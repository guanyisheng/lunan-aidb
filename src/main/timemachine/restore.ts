/**
 * RestoreService implementation.
 *
 * Default path: restore into a NEW temporary database and keep it for the user
 * to inspect. In-place restore is deliberately harder to reach:
 *   1. the backup must verify again at execution time,
 *   2. an approved (non-expired, plan-hash matched) approval is required,
 *   3. a safety backup of the current target database is created and verified
 *      first - if that fails, nothing is overwritten,
 *   4. failures report `mayBePartial` truthfully (DDL cannot be rolled back).
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  BackupRecord,
  Id,
  RestoreConflict,
  RestoreJob,
  RestorePreview,
  RestorePreviewRequest,
  RestoreStep
} from '@shared/types'
import type {
  ApprovalRecord,
  HistoryTrigger,
  RestoreService,
  Services
} from '@main/service-contracts'
import { AppError, toAppError } from '@main/util/errors'
import { ensureDir, writeFileAtomic } from '@main/util/fsx'
import { addMs, isExpired, nowIso } from '@main/util/time'
import { newId, sha256Hex } from '@main/util/id'
import {
  countAllRows,
  databaseExists,
  dropDatabase,
  listObjects,
  tempDatabaseName
} from './dbsession'
import { resolveServices, type ServicesProvider } from './deps'
import { openStandaloneSession } from './session-factory'
import { readBackupManifest } from './manifest'
import { audit, emitJob } from './backup'
import { executeSqlFile } from './sqlfile'
import { restoreDumpToFreshDatabase, summarizeTempRestore } from './temprestore'

const APPROVAL_TTL_MS = 15 * 60 * 1000
const MAX_LIST = 1000

export class MySqlRestoreService implements RestoreService {
  constructor(private readonly provider: ServicesProvider) {}

  private services(): Services {
    return resolveServices(this.provider)
  }

  async preview(req: RestorePreviewRequest, trigger: HistoryTrigger): Promise<RestorePreview> {
    const services = this.services()
    const backup = await this.resolveVerifiedBackup(req)
    const manifest = (await readBackupManifest(backup.filePath)).manifest
    if (!manifest) {
      throw new AppError('BACKUP_FAILED', '备份文件缺少可解析的 manifest，无法生成恢复计划')
    }
    const mode = req.mode
    const warnings: string[] = []
    const schemaIssues: string[] = []
    const objectConflicts: string[] = []
    const steps: string[] = []

    let targetDatabase: string
    let tempDatabase: string | null = null
    if (mode === 'to_temp_database') {
      const prefix = req.tempDatabase?.trim() || 'aidb_restore'
      targetDatabase = await this.allocateTempName(services, req.connectionId, prefix)
      tempDatabase = targetDatabase
      steps.push('校验备份文件完整性', `创建临时数据库 ${targetDatabase}`, '执行备份 SQL', '逐表比对行数', '保留临时库供验证（不自动删除）')
    } else {
      targetDatabase = req.targetDatabase?.trim() || backup.database
      steps.push(
        '校验备份文件完整性',
        '校验目标库与审批记录',
        '创建目标库安全备份',
        '在目标库执行恢复 SQL（DDL 隐式提交）',
        '逐表比对行数并报告可能的部分恢复'
      )
      warnings.push('直接覆盖目标数据库属于高风险操作：恢复失败可能留下部分恢复状态')
    }
    warnings.push(`备份创建时间 ${backup.createdAt}，数据库 ${backup.database}`)

    const session = await openStandaloneSession(services, req.connectionId)
    try {
      await session.ping()
      const targetExists = await databaseExists(session, targetDatabase)
      if (mode === 'in_place') {
        if (!targetExists) {
          schemaIssues.push(`目标数据库 ${targetDatabase} 不存在：in_place 恢复不会自动创建目标库`)
        }
      } else if (targetExists) {
        warnings.push(`临时数据库 ${targetDatabase} 已存在，将重新生成名称`)
        targetDatabase = await this.allocateTempName(services, req.connectionId, req.tempDatabase?.trim() || 'aidb_restore')
        tempDatabase = targetDatabase
      }

      if (targetExists) {
        const liveObjects = await listObjects(session, targetDatabase)
        const liveTables = liveObjects.filter((o) => o.type === 'table').map((o) => o.name)
        for (const table of manifest.tables) {
          if (liveTables.includes(table)) objectConflicts.push(`表 ${table} 已存在，恢复后将覆盖其数据`)
        }
        // Schema compatibility: compare column names when the backup recorded them.
        for (const table of manifest.tables) {
          const expected = manifest.columnsByTable?.[table]
          if (!expected || !liveTables.includes(table)) continue
          const liveCols = await this.liveColumns(session, targetDatabase, table)
          const missing = expected.filter((c) => !liveCols.includes(c))
          const added = liveCols.filter((c) => !expected.includes(c))
          if (missing.length > 0) {
            schemaIssues.push(`表 ${table} 备份中的列在目标库缺失：${missing.join(', ')}`)
          }
          if (added.length > 0) {
            schemaIssues.push(`表 ${table} 目标库多了备份中不存在的列：${added.join(', ')}`)
          }
        }
      }
    } finally {
      await session.release().catch(() => undefined)
    }

    // Loss estimate based on current row counts of tables that will be replaced.
    const liveSession = await openStandaloneSession(services, req.connectionId)
    const lossEstimate: RestorePreview['lossEstimate'] = []
    try {
      const targetExists = await databaseExists(liveSession, targetDatabase)
      if (targetExists) {
        for (const table of manifest.tables) {
          if (!objectConflicts.some((c) => c.includes(`表 ${table} `) || c.includes(`表 ${table}已`))) continue
          const exists = await this.tableExists(liveSession, targetDatabase, table)
          if (!exists) continue
          const rows = await countAllRows(liveSession, targetDatabase, table)
          lossEstimate.push({
            table,
            rowsAtRisk: rows,
            reason: `恢复会用备份中的 ${manifest.rowCounts[table] ?? 0} 行替换当前 ${rows} 行`
          })
        }
      }
    } finally {
      await liveSession.release().catch(() => undefined)
    }

    const overwriteRisk: RestorePreview['overwriteRisk'] =
      mode === 'in_place'
        ? objectConflicts.length > 0
          ? 'high'
          : 'low'
        : objectConflicts.length > 0
          ? 'low'
          : 'none'
    if (mode === 'in_place' && overwriteRisk === 'high') {
      warnings.push(
        `目标库中 ${objectConflicts.length} 个对象将被覆盖，当前数据可能丢失（见 lossEstimate）`
      )
    }
    if (manifest.warnings.length > 0) warnings.push(...manifest.warnings.slice(0, 5))
    if (schemaIssues.length > 0) {
      warnings.push('Schema 兼容性检查发现问题：恢复后结构可能与备份不一致')
    }

    let approvalToken: string | undefined
    if (mode === 'in_place') {
      const approval = this.createRestoreApproval(backup, targetDatabase, mode, trigger, overwriteRisk)
      approvalToken = approval.id
    }

    return {
      source: {
        kind: req.recoveryPointId ? 'recovery_point' : 'backup',
        id: req.recoveryPointId ?? backup.id,
        database: backup.database,
        tables: manifest.tables,
        createdAt: backup.createdAt,
        verified: backup.status === 'verified' || backup.status === 'restore_tested'
      },
      mode,
      targetDatabase,
      tempDatabase,
      schemaCompatible: schemaIssues.length === 0,
      schemaIssues,
      objectConflicts,
      overwriteRisk,
      lossEstimate,
      requiresApproval: mode === 'in_place',
      warnings: [...new Set(warnings)],
      steps,
      ...(approvalToken ? { approvalToken } : {})
    }
  }

  async toTempDatabase(
    req: { backupId: Id; projectId?: Id | null },
    trigger: HistoryTrigger
  ): Promise<RestoreJob> {
    const services = this.services()
    const backup = await this.resolveVerifiedBackup({ backupId: req.backupId })
    const job = createRestoreJob({
      mode: 'to_temp_database',
      backup,
      projectId: req.projectId ?? backup.projectId,
      targetDatabase: '',
      tempDatabase: null
    })
    persistJob(services, job)
    emitJob(services, {
      jobId: job.id,
      kind: 'restore',
      status: 'running',
      phase: 'prepare',
      message: '创建临时数据库并恢复',
      progress: 0.05
    })
    job.steps = setStep(job.steps, 0, 'running', '备份完整性已校验')
    const lines: string[] = [`[${nowIso()}] 恢复备份 ${backup.id} 到临时数据库`]
    try {
      const result = await restoreDumpToFreshDatabase({
        services,
        connectionId: backup.connectionId,
        sourceDatabase: backup.database,
        filePath: backup.filePath,
        prefix: 'aidb_restore',
        keepDatabase: true,
        onProgress: (p) => {
          emitJob(services, {
            jobId: job.id,
            kind: 'restore',
            status: 'running',
            phase: p.phase,
            message: p.message,
            progress: 0.05 + Math.min(0.9, p.progress)
          })
          lines.push(`[${nowIso()}] ${p.phase}: ${p.message}`)
        }
      })
      job.tempDatabase = result.tempDatabase || null
      job.targetDatabase = result.tempDatabase
      lines.push(...result.notes.map((n) => `[${nowIso()}] ${n}`))
      job.steps = setStep(job.steps, 1, 'ok', `临时数据库 ${result.tempDatabase}`)
      job.steps = setStep(job.steps, 2, result.error ? 'failed' : 'ok', result.error ?? `执行 ${result.executedStatements} 条 SQL`)
      job.steps = setStep(
        job.steps,
        3,
        result.passed ? 'ok' : 'failed',
        result.passed ? '行数全部匹配' : result.notes.slice(-2).join('；')
      )
      job.steps = setStep(job.steps, 4, 'ok', '临时库保留，未自动删除')
      if (result.passed) {
        job.status = 'completed'
        job.progress = 100
        job.error = null
        job.mayBePartial = false
        job.verification = {
          tablesRestored: result.tablesRestored,
          rowsMatched: true,
          passed: true,
          notes: [
            `临时数据库 ${result.tempDatabase} 保留供验证`,
            `执行 ${result.executedStatements} 条 SQL`,
            ...result.notes
          ]
        }
      } else {
        job.status = 'failed'
        job.progress = 100
        job.error = summarizeTempRestore(result)
        job.mayBePartial = result.executedStatements > 0
        job.verification = {
          tablesRestored: result.tablesRestored,
          rowsMatched: result.rowsMatched,
          passed: false,
          notes: [
            ...(result.executedStatements > 0
              ? [`临时数据库 ${result.tempDatabase} 可能处于部分恢复状态`]
              : []),
            ...result.notes
          ]
        }
      }
    } catch (e) {
      const error = toAppError(e, 'RESTORE_FAILED')
      job.status = 'failed'
      job.progress = 100
      job.error = error.message
      job.mayBePartial = true
      lines.push(`[${nowIso()}] 失败：${error.message}`)
      emitJob(services, {
        jobId: job.id,
        kind: 'restore',
        status: 'failed',
        phase: 'failed',
        message: error.message,
        progress: 1,
        error: error.message
      })
    }
    job.finishedAt = nowIso()
    job.steps = job.steps.map((s) => (s.status === 'running' ? { ...s, status: 'failed' } : s))
    job.logPath = await writeJobLog(services, job.id, lines)
    updateJob(services, job)
    audit(services, {
      action: 'restore.to_temp_database',
      outcome: job.status === 'completed' ? 'success' : 'failure',
      connectionId: backup.connectionId,
      projectId: job.projectId,
      target: job.targetDatabase,
      detail: job.error ?? `恢复到 ${job.tempDatabase}，${job.verification?.tablesRestored ?? 0} 张表`
    })
    emitJob(services, {
      jobId: job.id,
      kind: 'restore',
      status: job.status === 'completed' ? 'completed' : 'failed',
      phase: 'done',
      message: job.error ?? `临时库恢复完成：${job.tempDatabase}`,
      progress: 1,
      ...(job.error ? { error: job.error } : {})
    })
    return job
  }

  async inPlace(
    req: { backupId: Id; approvalId?: Id | null; confirmed: boolean },
    trigger: HistoryTrigger
  ): Promise<RestoreJob> {
    const services = this.services()
    if (!req.confirmed) {
      throw new AppError('VALIDATION', '覆盖恢复需要 confirmed=true 的明确确认')
    }
    const backup = this.services().store.getBackup(req.backupId)
    if (!backup) throw new AppError('NOT_FOUND', `备份 ${req.backupId} 不存在`)
    const target = backup.database
    // Approval is checked before any expensive/irreversible work.
    this.validateRestoreApproval(backup.id, target, 'in_place', req.approvalId ?? null)

    // Re-verify the source backup *at execution time*.
    const verified = await this.verifySource(backup)
    if (verified.status !== 'verified' && verified.status !== 'restore_tested') {
      throw new AppError('BACKUP_FAILED', '执行前再次校验备份失败，已拒绝恢复', {
        details: { backupId: backup.id, verification: verified.verification }
      })
    }
    const manifest = (await readBackupManifest(backup.filePath)).manifest
    if (!manifest) throw new AppError('BACKUP_FAILED', '备份 manifest 无法解析')

    const job = createRestoreJob({
      mode: 'in_place',
      backup,
      projectId: backup.projectId,
      targetDatabase: target,
      tempDatabase: null
    })
    persistJob(services, job)
    emitJob(services, {
      jobId: job.id,
      kind: 'restore',
      status: 'running',
      phase: 'safety-backup',
      message: '覆盖恢复前创建目标库安全备份',
      progress: 0.05
    })
    const lines: string[] = [`[${nowIso()}] 覆盖恢复 ${backup.id} -> ${target}（审批 ${req.approvalId}）`]

    // 1) Safety backup of the current target state. Failure aborts the restore.
    let safetyBackupId: string | null = null
    try {
      const safety = await services.backups.create(
        {
          connectionId: backup.connectionId,
          projectId: backup.projectId,
          database: target,
          scope: 'database',
          type: 'full',
          verify: false,
          label: 'pre-restore-safety'
        },
        { projectId: backup.projectId }
      )
      const safetyVerified = await services.backups.verify(safety.id, { restoreTest: false })
      if (safetyVerified.status !== 'verified' && safetyVerified.status !== 'restore_tested') {
        throw new AppError('BACKUP_FAILED', `目标库安全备份校验失败（status=${safetyVerified.status}）`)
      }
      safetyBackupId = safetyVerified.id
      job.steps = setStep(job.steps, 0, 'ok', `安全备份 ${safetyVerified.id}`)
      lines.push(`[${nowIso()}] 已创建目标库安全备份 ${safetyVerified.id}`)
    } catch (e) {
      const error = toAppError(e, 'BACKUP_FAILED')
      job.status = 'failed'
      job.error = `覆盖恢复前安全备份失败，已取消恢复（目标库未被修改）：${error.message}`
      job.mayBePartial = false
      job.progress = 100
      job.finishedAt = nowIso()
      job.steps = setStep(job.steps, 0, 'failed', error.message)
      job.logPath = await writeJobLog(services, job.id, [...lines, job.error])
      updateJob(services, job)
      audit(services, {
        action: 'restore.in_place',
        outcome: 'failure',
        connectionId: backup.connectionId,
        projectId: backup.projectId,
        target,
        detail: job.error
      })
      emitJob(services, {
        jobId: job.id,
        kind: 'restore',
        status: 'failed',
        phase: 'failed',
        message: job.error,
        progress: 1,
        error: job.error
      })
      return job
    }

    job.steps = setStep(job.steps, 1, 'ok', '备份与审批校验通过')
    job.steps = setStep(job.steps, 2, 'ok', `安全备份 ${safetyBackupId}`)
    emitJob(services, {
      jobId: job.id,
      kind: 'restore',
      status: 'running',
      phase: 'apply',
      message: '在目标数据库执行恢复 SQL',
      progress: 0.25
    })

    const session = await openStandaloneSession(services, backup.connectionId, target)
    let executed = 0
    let committed = false
    try {
      await session.ping()
      if (!(await databaseExists(session, target))) {
        throw new AppError('NOT_FOUND', `目标数据库 ${target} 不存在`)
      }
      const exec = await executeSqlFile(session, backup.filePath, {
        signal: undefined,
        onProgress: (p) => {
          emitJob(services, {
            jobId: job.id,
            kind: 'restore',
            status: 'running',
            phase: 'apply',
            message: p.message,
            progress: 0.25 + Math.min(0.5, p.executed / 4000)
          })
        },
        log: (m, meta) => services.logger.debug(`[in-place-restore] ${m}`, meta)
      })
      executed = exec.executed
      committed = true
      job.steps = setStep(job.steps, 3, 'ok', `执行 ${executed} 条 SQL`)
      lines.push(`[${nowIso()}] 执行 ${executed} 条 SQL`)

      // Row count verification after the restore.
      const mismatches: string[] = []
      let tablesRestored = 0
      for (const table of manifest.tables) {
        const exists = await this.tableExists(session, target, table)
        if (!exists) {
          mismatches.push(`表 ${table} 恢复后不存在`)
          continue
        }
        tablesRestored += 1
        const actual = await countAllRows(session, target, table)
        const expected = manifest.rowCounts[table] ?? 0
        if (actual !== expected) {
          mismatches.push(`表 ${table} 行数不一致：期望 ${expected}，实际 ${actual}`)
        }
      }
      const passed = mismatches.length === 0
      job.verification = {
        tablesRestored,
        rowsMatched: passed,
        passed,
        notes: [
          `已创建目标库安全备份 ${safetyBackupId}`,
          ...mismatches,
          ...lines.slice(-5)
        ]
      }
      job.status = passed ? 'completed' : 'partial'
      job.error = passed ? null : `恢复完成但校验未通过：${mismatches.slice(0, 3).join('；')}`
      job.progress = 100
      job.mayBePartial = !passed
      job.steps = setStep(
        job.steps,
        4,
        passed ? 'ok' : 'failed',
        passed ? '行数全部匹配' : mismatches.slice(0, 2).join('；')
      )
      lines.push(`[${nowIso()}] ${passed ? '恢复校验通过' : `恢复校验失败：${mismatches.join('；')}`}`)
      audit(services, {
        action: 'restore.in_place',
        outcome: passed ? 'success' : 'failure',
        connectionId: backup.connectionId,
        projectId: backup.projectId,
        target,
        detail: passed ? `覆盖恢复成功（${tablesRestored} 表）` : job.error ?? undefined
      })
    } catch (e) {
      const error = toAppError(e, 'RESTORE_FAILED')
      job.status = 'failed'
      job.error = `覆盖恢复失败：${error.message}`
      job.progress = 100
      job.mayBePartial = executed > 0
      job.verification = {
        tablesRestored: 0,
        rowsMatched: false,
        passed: false,
        notes: [
          executed > 0
            ? '恢复过程中已有 SQL 执行（DDL 隐式提交），数据库可能处于部分恢复状态'
            : '未执行任何 SQL，目标库未修改',
          `安全备份 ${safetyBackupId} 可用于恢复原状态`
        ]
      }
      job.steps = job.steps.map((s) => (s.status === 'running' || s.status === 'pending' ? { ...s, status: 'failed' } : s))
      lines.push(`[${nowIso()}] 失败：${error.message}`)
      audit(services, {
        action: 'restore.in_place',
        outcome: 'failure',
        connectionId: backup.connectionId,
        projectId: backup.projectId,
        target,
        detail: job.error
      })
      emitJob(services, {
        jobId: job.id,
        kind: 'restore',
        status: 'failed',
        phase: 'failed',
        message: job.error,
        progress: 1,
        error: job.error
      })
    } finally {
      await session.release().catch(() => undefined)
    }

    job.finishedAt = nowIso()
    job.logPath = await writeJobLog(services, job.id, lines)
    updateJob(services, job)
    emitJob(services, {
      jobId: job.id,
      kind: 'restore',
      status: job.status === 'completed' ? 'completed' : 'failed',
      phase: 'done',
      message: job.error ?? '覆盖恢复完成',
      progress: 1,
      ...(job.error ? { error: job.error } : {})
    })
    void committed
    return job
  }

  getJob(id: Id): RestoreJob | null {
    return this.services().store.getJob('restore_jobs', id)
  }

  listJobs(q: { projectId?: Id; limit?: number }): { items: RestoreJob[]; total: number } {
    return this.services().store.listRestoreJobs({
      ...q,
      limit: Math.max(1, Math.min(q.limit ?? 100, MAX_LIST))
    })
  }

  /* ------------------------------ helpers ------------------------------ */

  private async resolveVerifiedBackup(req: {
    backupId?: Id
    recoveryPointId?: Id
  }): Promise<BackupRecord> {
    const services = this.services()
    if (req.backupId) {
      const backup = services.store.getBackup(req.backupId)
      if (!backup) throw new AppError('NOT_FOUND', `备份 ${req.backupId} 不存在`)
      return this.verifySource(backup)
    }
    if (req.recoveryPointId) {
      const point = services.store.getRecoveryPoint(req.recoveryPointId)
      if (!point) throw new AppError('NOT_FOUND', `恢复点 ${req.recoveryPointId} 不存在`)
      if (!point.backupId) {
        throw new AppError(
          'UNSAFE_OPERATION',
          '该恢复点不包含完整备份，不能用于整库恢复；请使用“撤销”功能',
          { hint: '只有前镜像的恢复点只能撤销对应的 DML 变更' }
        )
      }
      const backup = services.store.getBackup(point.backupId)
      if (!backup) {
        throw new AppError('NOT_FOUND', `恢复点引用的备份 ${point.backupId} 不存在`)
      }
      return this.verifySource(backup)
    }
    throw new AppError('VALIDATION', '必须提供 backupId 或 recoveryPointId')
  }

  private async verifySource(backup: BackupRecord): Promise<BackupRecord> {
    const services = this.services()
    if (backup.status === 'deleted') {
      throw new AppError('NOT_FOUND', `备份 ${backup.id} 已删除，无法恢复`)
    }
    const verified = await services.backups.verify(backup.id, { restoreTest: false })
    if (verified.status !== 'verified' && verified.status !== 'restore_tested') {
      throw new AppError('BACKUP_FAILED', '备份完整性校验未通过，不能用于恢复', {
        details: { backupId: backup.id, verification: verified.verification }
      })
    }
    return verified
  }

  private async allocateTempName(
    services: Services,
    connectionId: Id,
    prefix: string
  ): Promise<string> {
    const session = await openStandaloneSession(services, connectionId)
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = tempDatabaseName(prefix)
        if (!(await databaseExists(session, candidate))) return candidate
      }
    } finally {
      await session.release().catch(() => undefined)
    }
    throw new AppError('RESTORE_FAILED', '多次尝试后仍无法分配临时数据库名')
  }

  private async liveColumns(session: import('@main/service-contracts').DbSession, database: string, table: string): Promise<string[]> {
    const r = await session.rawQuery<Record<string, unknown>>(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [database, table]
    )
    return r.rows.map((row) => String(row.name ?? ''))
  }

  private async tableExists(
    session: import('@main/service-contracts').DbSession,
    database: string,
    table: string
  ): Promise<boolean> {
    const r = await session.rawQuery<Record<string, unknown>>(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table]
    )
    return r.rows.length > 0
  }

  private createRestoreApproval(
    backup: BackupRecord,
    targetDatabase: string,
    mode: 'to_temp_database' | 'in_place',
    trigger: HistoryTrigger,
    overwriteRisk: RestorePreview['overwriteRisk']
  ): ApprovalRecord {
    const services = this.services()
    const approval: ApprovalRecord = {
      id: newId('appr'),
      taskId: null,
      planId: `restore:${backup.id}`,
      kind: 'restore',
      summary: `覆盖恢复备份 ${backup.fileName} → ${targetDatabase}`,
      targets: backup.tables,
      risk: overwriteRisk === 'high' ? 'critical' : 'high',
      impact: `目标数据库 ${targetDatabase} 中的同名表将被备份内容替换；失败可能留下部分恢复状态`,
      createdAt: nowIso(),
      expiresAt: addMs(APPROVAL_TTL_MS),
      status: 'pending',
      planHash: restorePlanHash(backup.id, targetDatabase, mode),
      trigger
    }
    return services.store.insertApproval(approval)
  }

  private validateRestoreApproval(
    backupId: Id,
    targetDatabase: string,
    mode: 'in_place',
    approvalId: Id | null
  ): void {
    const services = this.services()
    if (!approvalId) {
      throw new AppError('APPROVAL_REQUIRED', '覆盖恢复必须提供已批准的 approvalId', {
        details: { planHash: restorePlanHash(backupId, targetDatabase, mode) }
      })
    }
    const approval = services.store.getApproval(approvalId)
    if (!approval) throw new AppError('APPROVAL_REQUIRED', '审批记录不存在')
    if (approval.status !== 'approved') {
      throw new AppError('APPROVAL_REQUIRED', `审批状态为 ${approval.status}，尚未批准`)
    }
    if (isExpired(approval.expiresAt)) {
      throw new AppError('APPROVAL_EXPIRED', '审批已过期，请重新预览并发起审批')
    }
    if (approval.planHash !== restorePlanHash(backupId, targetDatabase, mode)) {
      throw new AppError('APPROVAL_REQUIRED', '审批记录与本次恢复目标不匹配（planHash 不一致）')
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function restorePlanHash(
  backupId: Id,
  targetDatabase: string,
  mode: 'to_temp_database' | 'in_place'
): string {
  return sha256Hex(`restore|${backupId}|${targetDatabase}|${mode}`)
}

function createRestoreJob(input: {
  mode: RestoreJob['mode']
  backup: BackupRecord
  projectId: Id | null
  targetDatabase: string
  tempDatabase: string | null
}): RestoreJob {
  const steps: RestoreStep[] = [
    { index: 0, title: '校验备份完整性', status: 'pending' },
    { index: 1, title: '校验目标库与审批记录', status: 'pending' },
    { index: 2, title: '创建目标库安全备份', status: 'pending' },
    { index: 3, title: '执行恢复 SQL', status: 'pending' },
    { index: 4, title: '校验恢复结果', status: 'pending' }
  ]
  return {
    id: newId('job'),
    mode: input.mode,
    backupId: input.backup.id,
    recoveryPointId: null,
    projectId: input.projectId,
    connectionId: input.backup.connectionId,
    sourceDatabase: input.backup.database,
    targetDatabase: input.targetDatabase,
    tempDatabase: input.tempDatabase,
    status: 'running',
    progress: 5,
    steps,
    conflicts: [] as RestoreConflict[],
    startedAt: nowIso(),
    finishedAt: null,
    error: null,
    mayBePartial: false,
    logPath: null,
    verification: null
  }
}

function setStep(
  steps: RestoreStep[],
  index: number,
  status: RestoreStep['status'],
  detail?: string
): RestoreStep[] {
  return steps.map((step) =>
    step.index === index
      ? {
          ...step,
          status,
          ...(detail ? { detail } : {}),
          startedAt: step.startedAt ?? nowIso(),
          ...(status === 'ok' || status === 'failed' ? { finishedAt: nowIso() } : {})
        }
      : step
  )
}

function persistJob(services: Services, job: RestoreJob): void {
  try {
    services.store.insertJob('restore_jobs', job)
  } catch (e) {
    services.logger.warn('恢复任务持久化失败', { jobId: job.id, error: toAppError(e).message })
  }
}

function updateJob(services: Services, job: RestoreJob): void {
  try {
    services.store.updateJob('restore_jobs', job.id, job as unknown as Record<string, unknown>)
  } catch (e) {
    services.logger.warn('恢复任务更新失败', { jobId: job.id, error: toAppError(e).message })
  }
}

async function writeJobLog(
  services: Services,
  jobId: string,
  lines: string[]
): Promise<string | null> {
  try {
    const dir = join(services.paths.logs, 'restore-jobs')
    await ensureDir(dir)
    const path = join(dir, `${jobId}.log`)
    await writeFileAtomic(path, `${lines.join('\n')}\n`)
    return path
  } catch {
    return null
  }
}

/** Exported for tests: reads the restore log for a job. */
export async function readRestoreLog(services: Services, jobId: Id): Promise<string | null> {
  try {
    return await fs.readFile(join(services.paths.logs, 'restore-jobs', `${jobId}.log`), 'utf8')
  } catch {
    return null
  }
}

/** Explicitly drops a temporary database created by toTempDatabase. */
export async function dropTempDatabase(
  services: Services,
  connectionId: Id,
  database: string
): Promise<void> {
  if (!/^aidb_restore_/.test(database)) {
    throw new AppError('UNSAFE_OPERATION', `拒绝删除非 AIDB 临时数据库：${database}`)
  }
  const session = await openStandaloneSession(services, connectionId)
  try {
    await dropDatabase(session, database)
  } finally {
    await session.release().catch(() => undefined)
  }
}



