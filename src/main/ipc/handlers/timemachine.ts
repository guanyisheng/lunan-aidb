import { z } from 'zod'
import { defineHandler, type HandlerContext } from '../registry'
import { backupCreateSchema, idSchema, limitSchema, restorePreviewSchema } from '../schemas'
import { AppError } from '@main/util/errors'
import { isExpired, nowIso } from '@main/util/time'
import { newId } from '@main/util/id'

const voidSchema = z.void()

function emitJob(
  ctx: HandlerContext,
  jobId: string,
  kind: 'backup' | 'restore' | 'undo' | 'verify',
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
  phase: string,
  message: string,
  progress: number,
  error?: string
): void {
  ctx.services.events.emit('job.event', {
    jobId,
    kind,
    status,
    phase,
    message,
    progress,
    at: nowIso(),
    error
  })
}

export function registerTimeMachineHandlers(): void {
  /* ---------------------------------------------------------- backups */
  defineHandler('backup.create', backupCreateSchema, async (ctx, payload) => {
    const s = ctx.services
    const jobId = newId('job')
    emitJob(ctx, jobId, 'backup', 'running', 'start', '开始创建备份', 0.01)
    try {
      const record = await s.backups.create(payload, {
        projectId: payload.projectId ?? null,
        emitProgress: (p) => emitJob(ctx, jobId, 'backup', 'running', p.phase, p.message, p.progress)
      })
      const ok = record.status !== 'failed'
      emitJob(
        ctx,
        jobId,
        'backup',
        ok ? 'completed' : 'failed',
        'done',
        ok ? `备份完成：${record.fileName}` : `备份失败：${record.error ?? '未知错误'}`,
        1,
        record.error ?? undefined
      )
      s.audit.record({
        actor: 'user',
        action: 'backup.create',
        projectId: payload.projectId ?? null,
        connectionId: payload.connectionId,
        target: payload.database,
        outcome: ok ? 'success' : 'failure',
        detail: ok
          ? `备份 ${record.tool} 完成，${record.fileSize} 字节，sha256 ${record.checksumSha256.slice(0, 12)}，状态 ${record.status}`
          : `备份失败：${record.error ?? '未知错误'}`,
        metadata: { backupId: record.id, status: record.status, verify: payload.verify ?? false, restoreTest: payload.restoreTest ?? false }
      })
      return record
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      emitJob(ctx, jobId, 'backup', 'failed', 'error', message, 1, message)
      s.audit.record({
        actor: 'user',
        action: 'backup.create',
        projectId: payload.projectId ?? null,
        connectionId: payload.connectionId,
        target: payload.database,
        outcome: 'failure',
        detail: `备份失败：${message}`
      })
      throw e
    }
  })

  defineHandler(
    'backup.list',
    z.object({
      projectId: z.string().max(200).optional(),
      connectionId: z.string().max(200).optional(),
      limit: limitSchema
    }),
    async (ctx, payload) => ctx.services.backups.list({ ...payload, limit: payload.limit ?? 50 })
  )

  defineHandler('backup.get', z.object({ id: idSchema }), async (ctx, payload) => ctx.services.backups.get(payload.id))

  defineHandler('backup.verify', z.object({ id: idSchema, restoreTest: z.boolean().optional() }), async (ctx, payload) => {
    const s = ctx.services
    const jobId = newId('job')
    emitJob(ctx, jobId, 'verify', 'running', 'start', '开始校验备份', 0.01)
    const record = await s.backups.verify(payload.id, { restoreTest: payload.restoreTest ?? true })
    const ok = record.status === 'verified' || record.status === 'restore_tested'
    emitJob(
      ctx,
      jobId,
      'verify',
      ok ? 'completed' : 'failed',
      'done',
      ok
        ? record.status === 'restore_tested'
          ? `校验通过，并已恢复到临时库 ${record.verification.tempDatabase ?? ''} 验证`
          : '备份文件完整性校验通过'
        : `校验失败：${record.verification.notes.join('; ') || record.error || '未知原因'}`,
      1,
      ok ? undefined : record.error ?? undefined
    )
    s.audit.record({
      actor: 'user',
      action: 'backup.verify',
      connectionId: record.connectionId,
      target: record.database,
      outcome: ok ? 'success' : 'failure',
      detail: `备份校验：${record.status}`,
      metadata: { backupId: record.id, verification: record.verification }
    })
    return record
  })

  defineHandler('backup.delete', z.object({ id: idSchema, force: z.boolean().optional() }), async (ctx, payload) => {
    const record = ctx.services.backups.get(payload.id)
    await ctx.services.backups.remove(payload.id, { force: payload.force ?? false })
    ctx.services.audit.record({
      actor: 'user',
      action: 'backup.delete',
      connectionId: record?.connectionId ?? null,
      target: record?.database ?? null,
      outcome: 'info',
      detail: `删除备份 ${record?.fileName ?? payload.id}${payload.force ? '（强制）' : ''}`,
      metadata: { backupId: payload.id }
    })
  })

  defineHandler('backup.stats', z.object({ projectId: z.string().max(200).optional() }), async (ctx, payload) =>
    ctx.services.backups.stats(payload.projectId)
  )

  /* ------------------------------------------------------ time machine */
  defineHandler(
    'recovery.list',
    z.object({
      projectId: z.string().max(200).optional(),
      connectionId: z.string().max(200).optional(),
      limit: limitSchema
    }),
    async (ctx, payload) => ctx.services.recovery.list({ ...payload, limit: payload.limit ?? 50 })
  )

  defineHandler('recovery.get', z.object({ id: idSchema }), async (ctx, payload) => ctx.services.recovery.get(payload.id))

  defineHandler('recovery.previewUndo', z.object({ recoveryPointId: idSchema }), async (ctx, payload) => {
    const preview = await ctx.services.recovery.previewUndo(payload.recoveryPointId)
    ctx.services.audit.record({
      actor: 'user',
      action: 'recovery.preview_undo',
      connectionId: preview.recoveryPoint.connectionId,
      target: preview.recoveryPoint.database,
      outcome: 'info',
      detail: `预览撤销：${preview.canUndo ? '可执行' : '存在阻塞项'}，冲突 ${preview.conflicts.length} 个`,
      metadata: { recoveryPointId: payload.recoveryPointId }
    })
    return preview
  })

  defineHandler(
    'recovery.undo',
    z.object({ recoveryPointId: idSchema, approvalToken: z.string().max(200).optional(), confirmed: z.boolean() }),
    async (ctx, payload) => {
      const s = ctx.services
      if (!payload.confirmed) throw new AppError('VALIDATION', '必须显式确认后才可撤销')
      const preview = await s.recovery.previewUndo(payload.recoveryPointId)
      if (preview.requiresApproval) {
        if (!payload.approvalToken) throw new AppError('APPROVAL_REQUIRED', '撤销操作需要用户授权')
        const approval = s.store.getApproval(payload.approvalToken)
        if (!approval) throw new AppError('APPROVAL_REQUIRED', '授权记录不存在')
        if (approval.status !== 'approved') throw new AppError('APPROVAL_REQUIRED', '撤销尚未获得授权')
        if (isExpired(approval.expiresAt)) throw new AppError('APPROVAL_EXPIRED', '授权已过期')
      }
      const job = await s.recovery.undo(payload.recoveryPointId, {
        confirmed: true,
        approvalId: payload.approvalToken ?? null
      })
      s.audit.record({
        actor: 'user',
        action: 'recovery.undo',
        connectionId: job.connectionId,
        target: job.targetDatabase,
        outcome: job.status === 'completed' ? 'success' : 'failure',
        detail: `撤销恢复点 ${payload.recoveryPointId}：${job.status}${job.error ? `（${job.error}）` : ''}`,
        metadata: { jobId: job.id, conflicts: job.conflicts.length, mayBePartial: job.mayBePartial }
      })
      return job
    }
  )

  defineHandler('recovery.previewRestore', restorePreviewSchema, async (ctx, payload) => {
    const preview = await ctx.services.restore.preview(payload, 'user')
    ctx.services.audit.record({
      actor: 'user',
      action: 'recovery.preview_restore',
      connectionId: payload.connectionId,
      target: preview.targetDatabase,
      outcome: 'info',
      detail: `预览恢复：${preview.mode}，覆盖风险 ${preview.overwriteRisk}`,
      metadata: { backupId: payload.backupId ?? null, recoveryPointId: payload.recoveryPointId ?? null }
    })
    return preview
  })

  defineHandler('recovery.restoreToTemp', z.object({ backupId: idSchema, projectId: z.string().max(200).optional() }), async (ctx, payload) => {
    const job = await ctx.services.restore.toTempDatabase({ backupId: payload.backupId, projectId: payload.projectId ?? null }, 'user')
    ctx.services.audit.record({
      actor: 'user',
      action: 'recovery.restore_to_temp',
      connectionId: job.connectionId,
      target: job.tempDatabase ?? job.targetDatabase,
      outcome: job.status === 'completed' ? 'success' : 'failure',
      detail: `恢复到临时库：${job.status}`,
      metadata: { jobId: job.id, backupId: payload.backupId, mayBePartial: job.mayBePartial }
    })
    return job
  })

  defineHandler(
    'recovery.restoreInPlace',
    z.object({ backupId: idSchema, approvalToken: z.string().min(1).max(200), confirmed: z.boolean() }),
    async (ctx, payload) => {
      const s = ctx.services
      if (!payload.confirmed) throw new AppError('VALIDATION', '必须显式确认后才可恢复')
      const approval = s.store.getApproval(payload.approvalToken)
      if (!approval) throw new AppError('APPROVAL_REQUIRED', '恢复授权记录不存在')
      if (approval.status !== 'approved') throw new AppError('APPROVAL_REQUIRED', '恢复尚未获得授权')
      if (isExpired(approval.expiresAt)) throw new AppError('APPROVAL_EXPIRED', '恢复授权已过期')
      const job = await s.restore.inPlace(
        { backupId: payload.backupId, approvalId: payload.approvalToken, confirmed: true },
        'user'
      )
      s.audit.record({
        actor: 'user',
        action: 'recovery.restore_in_place',
        connectionId: job.connectionId,
        target: job.targetDatabase,
        outcome: job.status === 'completed' ? 'success' : 'failure',
        detail: `原地恢复：${job.status}${job.mayBePartial ? '（数据库可能处于部分恢复状态）' : ''}`,
        metadata: { jobId: job.id, backupId: payload.backupId, approvalId: payload.approvalToken, mayBePartial: job.mayBePartial }
      })
      return job
    }
  )

  defineHandler('recovery.job.get', z.object({ jobId: idSchema }), async (ctx, payload) =>
    ctx.services.restore.getJob(payload.jobId)
  )

  defineHandler(
    'recovery.job.list',
    z.object({ projectId: z.string().max(200).optional(), limit: limitSchema }),
    async (ctx, payload) => ctx.services.restore.listJobs({ projectId: payload.projectId, limit: payload.limit ?? 50 })
  )

  /* ------------------------------------------------------------ audit */
  defineHandler(
    'audit.list',
    z.object({
      projectId: z.string().max(200).optional(),
      connectionId: z.string().max(200).optional(),
      actor: z.enum(['user', 'agent', 'system']).optional(),
      outcome: z.enum(['success', 'failure', 'denied', 'info']).optional(),
      limit: limitSchema,
      offset: z.number().int().min(0).max(1_000_000).optional()
    }),
    async (ctx, payload) =>
      ctx.services.audit.list({ ...payload, limit: payload.limit ?? 100, offset: payload.offset ?? 0 })
  )

  defineHandler(
    'audit.export',
    z.object({ projectId: z.string().max(200).optional(), format: z.enum(['json', 'csv']) }),
    async (ctx, payload) => {
      const result = ctx.services.audit.export({ projectId: payload.projectId, format: payload.format })
      return { path: result.path, count: result.count }
    }
  )

  void voidSchema
}
