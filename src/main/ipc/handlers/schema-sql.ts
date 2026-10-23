import { join } from 'node:path'
import { z } from 'zod'
import { defineHandler } from '../registry'
import { idSchema, limitSchema, offsetSchema, riskLevelSchema, sqlTextSchema } from '../schemas'
import { AppError } from '@main/util/errors'
import { nowIso } from '@main/util/time'
import { readBrowseCache, writeBrowseCache } from '@main/db/browse-cache'

const voidSchema = z.void()

export function registerSchemaSqlHandlers(): void {
  /* ----------------------------------------------------------- schema */
  defineHandler(
    'schema.scan',
    z.object({
      connectionId: idSchema,
      database: z.string().max(200).optional(),
      projectId: z.string().max(200).optional(),
      includeRowCounts: z.boolean().optional(),
      includeSampleRows: z.boolean().optional()
    }),
    async (ctx, payload) => {
      const s = ctx.services
      const busy = s.agent.getBusyState(payload.connectionId)
      if (busy.busy) {
        throw new AppError('CONFLICT', '正在进行 AI 任务，请稍后再扫描结构', {
          hint: `当前有 ${busy.tasks.length} 个 Agent 任务占用该连接；可在工作区右下角 AI 浮窗查看进度或停止任务。`,
          details: { tasks: busy.tasks }
        })
      }
      const settings = s.settings.get()
      const session = await s.connections.openSession(payload.connectionId, payload.database)
      const database = payload.database?.trim() || session.database
      if (!database) throw new AppError('VALIDATION', '请先选择数据库')

      const jobId = `scan_${Date.now().toString(36)}`
      const emitProgress = (p: { phase: string; message: string; progress: number }): void => {
        s.events.emit('job.event', {
          jobId,
          kind: 'schema_scan',
          status: 'running',
          phase: p.phase,
          message: p.message,
          progress: p.progress,
          at: nowIso()
        })
      }
      emitProgress({ phase: 'start', message: `开始扫描 ${database}`, progress: 0.02 })

      const snapshot = await s.schema.scan(session, {
        connectionId: payload.connectionId,
        database,
        projectId: payload.projectId ?? null,
        includeRowCounts: payload.includeRowCounts ?? false,
        includeSampleRows: payload.includeSampleRows ?? false,
        // Sampling is opt-in and guard-railed; a full business-table read is
        // never performed by default.
        sampling: {
          allowed: settings.allowSampling,
          maxRows: settings.maxSampleRows
        },
        onProgress: emitProgress
      })

      if (payload.projectId) {
        s.store.insertSchemaSnapshot(snapshot)
        s.store.setProjectSnapshot(payload.projectId, snapshot.id)
        try {
          await s.memory.syncSchemaMemory(snapshot)
        } catch (e) {
          s.logger.warn('syncSchemaMemory failed', { error: e instanceof Error ? e.message : String(e) })
        }
        s.store.touchProject(payload.projectId)
      }

      emitProgress({ phase: 'done', message: '扫描完成', progress: 1 })
      s.events.emit('job.event', {
        jobId,
        kind: 'schema_scan',
        status: 'completed',
        phase: 'done',
        message: `扫描完成：${snapshot.objectCount} 个对象`,
        progress: 1,
        at: nowIso()
      })
      s.audit.record({
        actor: 'user',
        action: 'schema.scan',
        projectId: payload.projectId ?? null,
        connectionId: payload.connectionId,
        target: database,
        outcome: 'success',
        detail: `扫描 ${snapshot.objectCount} 个对象，结构哈希 ${snapshot.schemaHash.slice(0, 12)}`
      })
      return snapshot
    }
  )

  defineHandler('schema.latest', z.object({ projectId: idSchema, includeTables: z.boolean().optional() }), async (ctx, payload) =>
    ctx.services.store.getLatestSchemaSnapshot(payload.projectId, payload.includeTables ?? true)
  )

  defineHandler('schema.snapshots', z.object({ projectId: idSchema, limit: limitSchema }), async (ctx, payload) =>
    ctx.services.store.listSchemaSnapshots(payload.projectId, payload.limit ?? 10)
  )

  defineHandler(
    'schema.getTable',
    z.object({ connectionId: idSchema, database: z.string().min(1).max(200), table: z.string().min(1).max(200) }),
    async (ctx, payload) => {
      const s = ctx.services
      const session = await s.connections.openSession(payload.connectionId, payload.database)
      return s.schema.getTable(session, payload.database, payload.table)
    }
  )

  defineHandler(
    'schema.listTables',
    z.object({ connectionId: idSchema, database: z.string().min(1).max(200) }),
    async (ctx, payload) => {
      const s = ctx.services
      const session = await s.connections.openSession(payload.connectionId, payload.database)
      const tables = await s.schema.listTables(session, payload.database)
      return {
        tables: tables.filter((t) => t.type === 'table').map((t) => t.name),
        views: tables.filter((t) => t.type === 'view').map((t) => t.name)
      }
    }
  )

  defineHandler('schema.listDatabases', z.object({ connectionId: idSchema }), async (ctx, payload) =>
    ctx.services.connections.listDatabases(payload.connectionId)
  )

  defineHandler(
    'schema.diff',
    z.object({ snapshotAId: idSchema, snapshotBId: idSchema }),
    async (ctx, payload) => {
      const s = ctx.services
      const a = s.store.getSchemaSnapshot(payload.snapshotAId, true)
      const b = s.store.getSchemaSnapshot(payload.snapshotBId, true)
      if (!a) throw new AppError('NOT_FOUND', '历史快照 A 不存在')
      if (!b) throw new AppError('NOT_FOUND', '历史快照 B 不存在')
      return s.schema.diff(a, b)
    }
  )

  defineHandler('schema.detectChanges', z.object({ projectId: idSchema }), async (ctx, payload) => {
    const s = ctx.services
    const report = await s.schema.detectChanges(s, payload.projectId)
    if (report.changed && report.diff) {
      s.audit.record({
        actor: 'user',
        action: 'schema.detect_changes',
        projectId: payload.projectId,
        outcome: 'info',
        detail: `检测到结构变化：+${report.diff.addedTables.length}/-${report.diff.removedTables.length}/~${report.diff.changedTables.length} 张表；失效记忆 ${report.invalidatedMemories} 条`,
        metadata: { staleMemories: report.staleMemories }
      })
    }
    return report
  })

  /* ------------------------------------------------------- table browse */
  defineHandler(
    'table.browse',
    z.object({
      connectionId: idSchema,
      database: z.string().min(1).max(200),
      table: z.string().min(1).max(200),
      projectId: z.string().max(200).nullable().optional(),
      offset: z.number().int().min(0).max(10_000_000).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      preferCache: z.boolean().optional(),
      forceLive: z.boolean().optional()
    }),
    async (ctx, payload) => {
      const database = payload.database.trim()
      const table = payload.table.trim()
      if (!/^[A-Za-z0-9_$]+$/.test(database)) {
        throw new AppError('VALIDATION', `非法数据库名: ${database}`)
      }
      if (!/^[A-Za-z0-9_$]+$/.test(table)) {
        throw new AppError('VALIDATION', `非法表名: ${table}`)
      }
      const settings = ctx.services.settings.get()
      const limit = Math.min(
        1000,
        Math.max(1, Math.floor(payload.limit ?? Math.min(100, settings.maxResultRows || 100)))
      )
      const offset = Math.max(0, Math.floor(payload.offset ?? 0))
      const cacheDir = join(ctx.services.paths.userData, 'browse-cache')
      const cacheParts = {
        connectionId: payload.connectionId,
        database,
        table,
        offset,
        limit
      }
      const cached = readBrowseCache(cacheDir, cacheParts)
      const busy = ctx.services.agent.getBusyState(payload.connectionId)
      const agentBusy = busy.busy

      if (agentBusy && payload.forceLive) {
        throw new AppError('CONFLICT', '正在进行 AI 任务，无法实时刷新表数据', {
          hint: '浏览将继续使用本地缓存预览；请等待 AI 结束或在浮窗中停止任务后再强制刷新。',
          details: { tasks: busy.tasks, cachedAt: cached?.cachedAt ?? null }
        })
      }

      if ((agentBusy || payload.preferCache) && cached) {
        return {
          ...cached.result,
          fromCache: true,
          cachedAt: cached.cachedAt,
          cacheReason: agentBusy
            ? 'AI 任务进行中，已改用本地缓存预览'
            : '已使用本地缓存预览'
        }
      }

      if (agentBusy && !cached) {
        throw new AppError('CONFLICT', '正在进行 AI 任务，且尚无该表的本地缓存', {
          hint: '请稍后再打开此表，或先停止 AI 任务。首次成功浏览后会自动缓存到本机。',
          details: { tasks: busy.tasks }
        })
      }

      const sql = `SELECT * FROM \`${database.replace(/`/g, '``')}\`.\`${table.replace(/`/g, '``')}\` LIMIT ${limit} OFFSET ${offset}`

      let estimatedTotal: number | null = null
      try {
        const session = await ctx.services.connections.openSession(payload.connectionId, database)
        const details = await ctx.services.schema.getTable(session, database, table)
        estimatedTotal =
          typeof details.rowCount === 'number'
            ? details.rowCount
            : typeof details.rowEstimate === 'number'
              ? details.rowEstimate
              : null
      } catch {
        /* estimate is best-effort */
      }

      try {
        const execution = await ctx.services.execution.runReadonlyQuery(
          {
            connectionId: payload.connectionId,
            database,
            projectId: payload.projectId ?? null,
            sql,
            maxRows: limit
          },
          'user'
        )
        const live = { sql, offset, limit, execution, estimatedTotal }
        if (execution.ok) {
          const entry = writeBrowseCache(cacheDir, cacheParts, live)
          return { ...live, fromCache: false, cachedAt: entry.cachedAt }
        }
        if (cached) {
          return {
            ...cached.result,
            fromCache: true,
            cachedAt: cached.cachedAt,
            cacheReason: '实时查询失败，已回退本地缓存'
          }
        }
        return { ...live, fromCache: false }
      } catch (error) {
        if (cached) {
          return {
            ...cached.result,
            fromCache: true,
            cachedAt: cached.cachedAt,
            cacheReason: '连接繁忙或查询失败，已回退本地缓存'
          }
        }
        throw error
      }
    }
  )

  /* -------------------------------------------------------------- sql */
  defineHandler(
    'sql.plan',
    z.object({
      connectionId: idSchema,
      sql: sqlTextSchema,
      database: z.string().max(200).optional(),
      projectId: z.string().max(200).optional(),
      maxRows: z.number().int().min(1).max(100_000).optional()
    }),
    async (ctx, payload) => {
      const busy = ctx.services.agent.getBusyState(payload.connectionId)
      if (busy.busy) {
        throw new AppError('CONFLICT', '正在进行 AI 任务，请稍后再执行 SQL', {
          hint: `当前有 ${busy.tasks.length} 个 Agent 占用该连接；表浏览仍可看本地缓存，写操作请等 AI 结束。`,
          details: { tasks: busy.tasks }
        })
      }
      return ctx.services.execution.plan(payload, 'user')
    }
  )

  defineHandler(
    'sql.execute',
    z.object({
      planId: idSchema,
      approvalToken: z.string().max(200).optional(),
      confirmed: z.boolean(),
      maxRows: z.number().int().min(1).max(100_000).optional()
    }),
    async (ctx, payload) => ctx.services.execution.execute(payload, 'user')
  )

  defineHandler('sql.cancel', z.object({ planId: z.string().max(200).optional() }), async (ctx, payload) =>
    ctx.services.execution.cancel(payload.planId)
  )

  defineHandler('sql.classify', z.object({ sql: sqlTextSchema }), async (ctx, payload) => ctx.services.classifier.classify(payload.sql))

  defineHandler(
    'sql.explain',
    z.object({ connectionId: idSchema, sql: sqlTextSchema, database: z.string().max(200).optional() }),
    async (ctx, payload) => ctx.services.execution.explain(payload.connectionId, payload.sql, payload.database)
  )

  defineHandler(
    'sql.history.list',
    z.object({
      projectId: z.string().max(200).optional(),
      connectionId: z.string().max(200).optional(),
      status: z.enum(['planned', 'running', 'success', 'failed', 'cancelled', 'denied']).optional(),
      risk: riskLevelSchema.optional(),
      limit: limitSchema,
      offset: offsetSchema
    }),
    async (ctx, payload) => ctx.services.execution.listHistory(payload)
  )

  defineHandler('sql.history.get', z.object({ id: idSchema }), async (ctx, payload) =>
    ctx.services.execution.getHistory(payload.id)
  )

  /* -------------------------------------------------------- approvals */
  defineHandler('approval.pending', z.object({ projectId: z.string().max(200).optional() }), async (ctx, payload) =>
    ctx.services.execution.listPendingApprovals(payload.projectId)
  )

  defineHandler(
    'approval.approve',
    z.object({ planId: idSchema, comment: z.string().max(1000).optional() }),
    async (ctx, payload) => ctx.services.execution.approve(payload.planId, payload.comment)
  )

  defineHandler(
    'approval.deny',
    z.object({ planId: idSchema, comment: z.string().max(1000).optional() }),
    async (ctx, payload) => ctx.services.execution.deny(payload.planId, payload.comment)
  )

  void voidSchema
}
