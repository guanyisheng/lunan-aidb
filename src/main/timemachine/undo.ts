/**
 * Undo (reverse recovery) for DML recovery points.
 *
 * Safety model (task chapter 5.6):
 *  - the undo plan is built from the captured before/after images by primary key;
 *  - before applying anything the *current* rows are locked (SELECT ... FOR UPDATE)
 *    and compared column-by-column with the after image;
 *  - if another session changed/deleted/added a row, the whole undo is aborted
 *    and the conflicts are reported - new data is never silently overwritten;
 *  - all reverse changes run in one transaction and are verified before commit.
 *
 * DDL recovery points are explicitly not undoable here: DDL implicitly commits
 * and must be restored from a full backup.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  RestoreConflict,
  RestoreJob,
  RestoreStep,
  UndoChangeSet,
  UndoPreview,
  RecoveryPoint
} from '@shared/types'
import type { DbSession, Services } from '@main/service-contracts'
import { AppError, toAppError } from '@main/util/errors'
import { ensureDir, writeFileAtomic } from '@main/util/fsx'
import { newId, sha256Hex } from '@main/util/id'
import { isExpired, nowIso } from '@main/util/time'
import {
  getTableMeta,
  insertableColumns
} from './dbsession'
import { openStandaloneSession } from './session-factory'
import { audit, emitJob } from './backup'
import { buildPkMatch, MAX_CAPTURE_ROWS } from './guard'
import {
  IMAGE_FORMAT_VERSION,
  type ImageStatement,
  type RecoveryImageFileV1,
  type RowImage
} from './internal-types'
import { readImageFile } from './recovery'
import { columnList, escapeValue, qualified } from './sqlformat'

const PREVIEW_SQL_ROWS = 20

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

export async function buildUndoPreview(
  services: Services,
  recoveryPointId: string
): Promise<UndoPreview> {
  const point = services.store.getRecoveryPoint(recoveryPointId)
  if (!point) throw new AppError('NOT_FOUND', `恢复点 ${recoveryPointId} 不存在`)
  const warnings: string[] = []

  const hasBefore = !!point.beforeImagePath && (await fileExists(point.beforeImagePath))
  const hasAfter = !!point.afterImagePath && (await fileExists(point.afterImagePath))
  if (!hasBefore && !hasAfter) {
    const reason = point.backupId
      ? '该恢复点没有镜像文件，只有完整备份；请使用备份恢复（时间机器 → 恢复）'
      : '该恢复点没有可用的镜像文件'
    warnings.push(reason)
    return emptyPreview(point, warnings, reason)
  }

  // INSERT-only recovery points have no before image (there was nothing to
  // capture); the inserted rows live in the after image. Do not treat that as
  // "no undo information".
  const beforeFile = hasBefore
    ? await readImageFile(point.beforeImagePath as string)
    : emptyImageFile(point, 'before')
  const afterFile = hasAfter ? await readImageFile(point.afterImagePath as string) : null

  if (beforeFile.schema || afterFile?.schema) {
    warnings.push('该恢复点包含 DDL Schema 快照：DDL 隐式提交，不能通过撤销恢复结构变更')
  }
  if (beforeFile.partial || point.status === 'partial') {
    warnings.push('该恢复点的捕获不完整（partial），撤销可能无法还原全部行')
  }

  const changeSets: UndoChangeSet[] = []

  // Group by table + operation. UPDATE rows come from the before image and are
  // matched with their after image; INSERT from the after image only; DELETE
  // from the before image only.
  const groups = new Map<
    string,
    { table: string; operation: 'insert' | 'update' | 'delete'; before: ImageStatement[]; after: ImageStatement[] }
  >()
  const groupFor = (
    table: string,
    operation: 'insert' | 'update' | 'delete'
  ): { table: string; operation: 'insert' | 'update' | 'delete'; before: ImageStatement[]; after: ImageStatement[] } => {
    const key = `${table}|${operation}`
    let group = groups.get(key)
    if (!group) {
      group = { table, operation, before: [], after: [] }
      groups.set(key, group)
    }
    return group
  }
  for (const stmt of beforeFile.statements) {
    if (!stmt.targetTable) continue
    listPush(groupFor(stmt.targetTable, stmt.kind === 'delete' ? 'delete' : 'update').before, stmt)
  }
  for (const stmt of afterFile?.statements ?? []) {
    if (!stmt.targetTable) continue
    const operation = stmt.kind === 'insert' ? 'insert' : stmt.kind === 'delete' ? 'delete' : 'update'
    listPush(groupFor(stmt.targetTable, operation).after, stmt)
  }

  for (const group of groups.values()) {
    const { table, operation, before, after } = group
    const primaryKeyColumns =
      before.find((s) => s.primaryKeyColumns.length > 0)?.primaryKeyColumns ??
      after.find((s) => s.primaryKeyColumns.length > 0)?.primaryKeyColumns ??
      []
    if (primaryKeyColumns.length === 0) {
      warnings.push(`表 ${table} 没有主键，无法安全撤销`)
      continue
    }
    if ([...before, ...after].some((s) => s.kind === 'replace')) {
      warnings.push(`表 ${table} 使用了 REPLACE，旧行已被删除且前镜像不可靠，撤销不安全`)
      changeSets.push({
        table,
        operation,
        primaryKeyColumns,
        rows: [],
        canApply: false,
        blockedReason: 'REPLACE 无法可靠撤销'
      })
      continue
    }
    const changes = buildChangeSet(operation, table, primaryKeyColumns, before, after, warnings)
    changeSets.push(changes)
  }

  // Compare against the live database (read-only preview).
  if (changeSets.some((c) => c.canApply)) {
    const session = await openStandaloneSession(services, point.connectionId, point.database)
    try {
      for (const changes of changeSets) {
        if (!changes.canApply) continue
        await detectConflicts(session, point.database, changes)
        if (changes.rows.some((r) => r.conflicts.length > 0)) {
          changes.canApply = false
          changes.blockedReason = '检测到执行后的并发修改（见 conflicts），已停止自动覆盖'
        }
      }
    } finally {
      await session.release().catch(() => undefined)
    }
  }

  const conflicts = changeSets.flatMap((c) => c.rows.flatMap((r) => r.conflicts))
  const canUndo = changeSets.length > 0 && changeSets.every((c) => c.canApply) && conflicts.length === 0
  const requiresApproval =
    !canUndo || conflicts.length > 0 || point.risk === 'high' || point.risk === 'critical'
  if (conflicts.length > 0) {
    warnings.push('检测到并发修改：不会覆盖这些行，需要人工处理（见 conflicts）')
  }
  const sqlPreview = buildSqlPreview(changeSets)
  return {
    recoveryPoint: point,
    changeSets,
    conflicts,
    canUndo,
    requiresApproval,
    warnings: [...new Set(warnings)],
    sqlPreview
  }
}

function buildChangeSet(
  operation: 'insert' | 'update' | 'delete',
  table: string,
  primaryKeyColumns: string[],
  beforeStmts: ImageStatement[],
  afterStmts: ImageStatement[],
  warnings: string[]
): UndoChangeSet {
  const rows: UndoChangeSet['rows'] = []
  const beforeRows = beforeStmts.flatMap((s) => s.beforeRows)
  const afterRows = afterStmts.flatMap((s) => s.afterRows)
  if (operation === 'update') {
    const afterByPk = new Map<string, RowImage>()
    for (const row of afterRows) afterByPk.set(pkKey(row, primaryKeyColumns), row)
    for (const before of beforeRows) {
      const key = pkKey(before, primaryKeyColumns)
      const after = afterByPk.get(key) ?? null
      if (!after) warnings.push(`表 ${table} 的行 ${key} 缺少后镜像，撤销时将按前镜像恢复`)
      rows.push({
        primaryKey: primaryKeyOf(before, primaryKeyColumns),
        before,
        after,
        conflicts: []
      })
    }
  } else if (operation === 'insert') {
    for (const after of afterRows) {
      rows.push({
        primaryKey: primaryKeyOf(after, primaryKeyColumns),
        before: null,
        after,
        conflicts: []
      })
    }
  } else {
    for (const before of beforeRows) {
      rows.push({
        primaryKey: primaryKeyOf(before, primaryKeyColumns),
        before,
        after: null,
        conflicts: []
      })
    }
  }
  const truncated = beforeStmts.some((s) => s.partial) || afterStmts.some((s) => s.partial)
  return {
    table,
    operation,
    primaryKeyColumns,
    rows,
    // A no-op change set (statement affected 0 rows) is trivially undoable;
    // truncated captures are not.
    canApply: !truncated,
    ...(truncated ? { blockedReason: '捕获不完整（partial），撤销不能保证完整' } : {})
  }
}

function emptyImageFile(point: RecoveryPoint, kind: 'before' | 'after'): RecoveryImageFileV1 {
  return {
    version: IMAGE_FORMAT_VERSION,
    format: 'aidb-recovery-image',
    recoveryPointId: point.id,
    executionId: point.executionId,
    planId: point.planId,
    connectionId: point.connectionId,
    projectId: point.projectId,
    database: point.database,
    kind,
    capturedAt: point.createdAt,
    statements: [],
    partial: false,
    warnings: []
  }
}

function emptyPreview(point: RecoveryPoint, warnings: string[], reason: string): UndoPreview {
  return {
    recoveryPoint: point,
    changeSets: [],
    conflicts: [],
    canUndo: false,
    requiresApproval: false,
    warnings,
    sqlPreview: `-- 无法生成撤销 SQL：${reason}`
  }
}

/* ------------------------------------------------------------------ */
/* Conflict detection                                                  */
/* ------------------------------------------------------------------ */

async function detectConflicts(
  session: DbSession,
  database: string,
  changes: UndoChangeSet
): Promise<void> {
  const pks = changes.rows.map((r) => r.primaryKey)
  const currentRows = await fetchRowsByPk(session, database, changes.table, changes.primaryKeyColumns, pks)
  const currentByPk = new Map<string, RowImage>()
  for (const row of currentRows) currentByPk.set(pkKey(row, changes.primaryKeyColumns), row)

  for (const row of changes.rows) {
    const key = pkKey(row.primaryKey, changes.primaryKeyColumns)
    const current = currentByPk.get(key) ?? null
    if (changes.operation === 'update') {
      if (!current) {
        row.conflicts.push({
          table: changes.table,
          primaryKey: row.primaryKey,
          kind: 'row_missing',
          beforeValue: row.before,
          currentValue: null,
          recoveryValue: row.after,
          message: '执行后该行已被删除，撤销会复活旧数据，已停止自动覆盖'
        })
      } else if (row.after && !rowsEqual(current, row.after)) {
        row.conflicts.push({
          table: changes.table,
          primaryKey: row.primaryKey,
          kind: 'row_changed_since_recovery',
          beforeValue: row.before,
          currentValue: current,
          recoveryValue: row.after,
          message: '该行在操作之后又被其他会话修改，不能自动覆盖'
        })
      }
    } else if (changes.operation === 'insert') {
      if (current && row.after && !rowsEqual(current, row.after)) {
        row.conflicts.push({
          table: changes.table,
          primaryKey: row.primaryKey,
          kind: 'row_changed_since_recovery',
          beforeValue: null,
          currentValue: current,
          recoveryValue: row.after,
          message: '插入的行之后被其他会话修改，撤销（删除）会丢失新数据'
        })
      }
    } else {
      if (current) {
        row.conflicts.push({
          table: changes.table,
          primaryKey: row.primaryKey,
          kind: 'row_added',
          beforeValue: row.before,
          currentValue: current,
          recoveryValue: null,
          message: '删除后该主键又被重新插入，不能覆盖新行'
        })
      }
    }
  }
}

async function fetchRowsByPk(
  session: DbSession,
  database: string,
  table: string,
  pkColumns: string[],
  pks: RowImage[]
): Promise<RowImage[]> {
  const out: RowImage[] = []
  for (let i = 0; i < pks.length; i += 200) {
    const chunk = pks.slice(i, i + 200)
    const match = buildPkMatch(pkColumns, chunk)
    const rows = await session.rawQuery<RowImage>(
      `SELECT * FROM ${qualified(database, table)} WHERE ${match.sql} LIMIT ${MAX_CAPTURE_ROWS + 1}`,
      match.params
    )
    out.push(...rows.rows)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Execute undo                                                        */
/* ------------------------------------------------------------------ */

export async function executeUndo(
  services: Services,
  recoveryPointId: string,
  options: { confirmed: boolean; approvalId?: string | null }
): Promise<RestoreJob> {
  if (!options.confirmed) {
    throw new AppError('VALIDATION', '撤销需要 confirmed=true 的明确确认')
  }
  const point = services.store.getRecoveryPoint(recoveryPointId)
  if (!point) throw new AppError('NOT_FOUND', `恢复点 ${recoveryPointId} 不存在`)

  const preview = await buildUndoPreview(services, recoveryPointId)
  const job = createJob(point, 'undo_last')
  persistJob(services, job)
  emitJob(services, {
    jobId: job.id,
    kind: 'undo',
    status: 'running',
    phase: 'preview',
    message: '校验撤销计划',
    progress: 0.05
  })

  if (preview.requiresApproval && !preview.canUndo) {
    return finishFailed(services, job, point, {
      error: preview.warnings[0] ?? '该恢复点无法安全撤销',
      conflicts: preview.conflicts,
      mayBePartial: false
    })
  }
  if (
    preview.requiresApproval &&
    (point.risk === 'high' || point.risk === 'critical') &&
    !preview.conflicts.length
  ) {
    validateUndoApproval(services, point, options.approvalId ?? null)
  }
  if (!preview.canUndo) {
    return finishFailed(services, job, point, {
      error:
        preview.changeSets.find((c) => c.blockedReason)?.blockedReason ??
        '撤销计划不可安全执行',
      conflicts: preview.conflicts,
      mayBePartial: false
    })
  }

  const session = await openStandaloneSession(services, point.connectionId, point.database)
  const logLines: string[] = []
  const log = (line: string): void => {
    logLines.push(`[${nowIso()}] ${line}`)
  }
  log(`撤销恢复点 ${point.id}，数据库 ${point.database}`)
  const conflicts: RestoreConflict[] = []
  let committed = false
  try {
    await session.beginTransaction()
    // Phase 1: lock and re-validate every affected row inside the transaction.
    for (const changes of preview.changeSets) {
      if (!changes.canApply) continue
      const pks = changes.rows.map((r) => r.primaryKey)
      const currentRows = await fetchRowsByPkForUpdate(
        session,
        point.database,
        changes.table,
        changes.primaryKeyColumns,
        pks
      )
      const currentByPk = new Map<string, RowImage>()
      for (const row of currentRows) currentByPk.set(pkKey(row, changes.primaryKeyColumns), row)
      for (const row of changes.rows) {
        const key = pkKey(row.primaryKey, changes.primaryKeyColumns)
        const current = currentByPk.get(key) ?? null
        if (changes.operation === 'update') {
          if (!current || (row.after && !rowsEqual(current, row.after))) {
            conflicts.push({
              table: changes.table,
              primaryKey: row.primaryKey,
              kind: current ? 'row_changed_since_recovery' : 'row_missing',
              beforeValue: row.before,
              currentValue: current,
              recoveryValue: row.after,
              message: '事务内复核发现并发修改，已回滚撤销（未覆盖新数据）'
            })
          }
        } else if (changes.operation === 'insert') {
          if (current && row.after && !rowsEqual(current, row.after)) {
            conflicts.push({
              table: changes.table,
              primaryKey: row.primaryKey,
              kind: 'row_changed_since_recovery',
              beforeValue: null,
              currentValue: current,
              recoveryValue: row.after,
              message: '事务内复核发现插入行已被修改，已回滚撤销'
            })
          }
        } else if (changes.operation === 'delete' && current) {
          conflicts.push({
            table: changes.table,
            primaryKey: row.primaryKey,
            kind: 'row_added',
            beforeValue: row.before,
            currentValue: current,
            recoveryValue: null,
            message: '事务内复核发现该主键已被重新插入，已回滚撤销'
          })
        }
      }
    }
    if (conflicts.length > 0) {
      await session.rollback()
      log(`检测到 ${conflicts.length} 个并发冲突，已回滚，未修改任何数据`)
      return finishFailed(services, job, point, {
        error: '检测到并发修改：已停止自动覆盖，未修改任何数据',
        conflicts,
        mayBePartial: false,
        logLines
      })
    }
    emitJob(services, {
      jobId: job.id,
      kind: 'undo',
      status: 'running',
      phase: 'apply',
      message: '应用反向变更',
      progress: 0.4
    })

    // Phase 2: apply reverse statements.
    let applied = 0
    for (const changes of preview.changeSets) {
      for (const row of changes.rows) {
        await applyReverseRow(session, point.database, changes, row)
        applied += 1
      }
    }
    log(`应用了 ${applied} 个反向行变更`)

    // Phase 3: verify inside the same transaction.
    const verificationIssues: string[] = []
    for (const changes of preview.changeSets) {
      for (const row of changes.rows) {
        const expected =
          changes.operation === 'insert' ? null : row.before
        const current = (
          await fetchRowsByPkForUpdate(
            session,
            point.database,
            changes.table,
            changes.primaryKeyColumns,
            [row.primaryKey]
          )
        )[0] ?? null
        if (expected === null) {
          if (current) verificationIssues.push(`${changes.table} ${pkKey(row.primaryKey, changes.primaryKeyColumns)} 未被删除`)
        } else if (!current || !rowsEqual(current, expected)) {
          verificationIssues.push(
            `${changes.table} ${pkKey(row.primaryKey, changes.primaryKeyColumns)} 恢复后的值与前镜像不一致`
          )
        }
      }
    }
    if (verificationIssues.length > 0) {
      await session.rollback()
      log(`撤销校验失败，已回滚：${verificationIssues.join('；')}`)
      return finishFailed(services, job, point, {
        error: `撤销后校验失败，已回滚：${verificationIssues.slice(0, 3).join('；')}`,
        conflicts: [],
        mayBePartial: false,
        logLines
      })
    }
    await session.commit()
    committed = true

    services.store.updateRecoveryPoint(point.id, {
      status: 'restored',
      note: `${point.note}；已于 ${nowIso()} 执行撤销`
    })
    const finished: RestoreJob = {
      ...job,
      status: 'completed',
      progress: 100,
      finishedAt: nowIso(),
      verification: {
        tablesRestored: preview.changeSets.length,
        rowsMatched: true,
        passed: true,
        notes: [`撤销 ${applied} 行`, '单事务内完成并逐行校验']
      },
      logPath: await writeJobLog(services, job.id, logLines)
    }
    services.store.updateJob('restore_jobs', job.id, finished as unknown as Record<string, unknown>)
    audit(services, {
      action: 'recovery.undo',
      outcome: 'success',
      connectionId: point.connectionId,
      projectId: point.projectId,
      target: point.database,
      detail: `撤销恢复点 ${point.id}：${applied} 行`
    })
    emitJob(services, {
      jobId: job.id,
      kind: 'undo',
      status: 'completed',
      phase: 'done',
      message: `撤销完成（${applied} 行）`,
      progress: 1
    })
    return finished
  } catch (e) {
    if (!committed) await session.rollback().catch(() => undefined)
    const error = toAppError(e, 'RESTORE_FAILED')
    log(`撤销失败：${error.message}`)
    return finishFailed(services, job, point, {
      error: error.message,
      conflicts,
      mayBePartial: false,
      logLines
    })
  } finally {
    await session.release().catch(() => undefined)
  }
}

function validateUndoApproval(
  services: Services,
  point: RecoveryPoint,
  approvalId: string | null
): void {
  if (!approvalId) {
    throw new AppError('APPROVAL_REQUIRED', '该撤销操作需要已批准的审批记录', {
      details: { planHash: undoPlanHash(point.id) }
    })
  }
  const approval = services.store.getApproval(approvalId)
  if (!approval) throw new AppError('APPROVAL_REQUIRED', '审批记录不存在')
  if (approval.status !== 'approved') {
    throw new AppError('APPROVAL_REQUIRED', `审批状态为 ${approval.status}，尚未批准`)
  }
  if (isExpired(approval.expiresAt)) {
    throw new AppError('APPROVAL_EXPIRED', '审批已过期')
  }
  if (approval.planHash !== undoPlanHash(point.id)) {
    throw new AppError('APPROVAL_REQUIRED', '审批记录与恢复点不匹配（planHash 不一致）')
  }
}

export function undoPlanHash(recoveryPointId: string): string {
  return sha256Hex(`undo|${recoveryPointId}`)
}

/* ------------------------------------------------------------------ */
/* Reverse row application                                             */
/* ------------------------------------------------------------------ */

async function applyReverseRow(
  session: DbSession,
  database: string,
  changes: UndoChangeSet,
  row: UndoChangeSet['rows'][number]
): Promise<void> {
  const tableRef = qualified(database, changes.table)
  const match = buildPkMatch(changes.primaryKeyColumns, [row.primaryKey])
  if (changes.operation === 'insert') {
    await session.rawQuery(`DELETE FROM ${tableRef} WHERE ${match.sql}`, match.params)
    return
  }
  if (changes.operation === 'delete') {
    const before = row.before
    if (!before) throw new AppError('INTERNAL', '删除行缺少前镜像，无法恢复')
    const meta = await getTableMeta(session, database, changes.table)
    const columns = insertableColumns(meta).filter((c) => before[c] !== undefined)
    if (columns.length === 0) throw new AppError('INTERNAL', '没有可插入的列')
    const placeholders = columns.map(() => '?').join(', ')
    await session.rawQuery(
      `INSERT INTO ${tableRef} (${columnList(columns)}) VALUES (${placeholders})`,
      columns.map((c) => normalizeForParam(before[c]))
    )
    return
  }
  // update: restore every captured column except the primary key.
  const before = row.before
  if (!before) throw new AppError('INTERNAL', '更新行缺少前镜像，无法恢复')
  const setColumns = Object.keys(before).filter((c) => !changes.primaryKeyColumns.includes(c))
  if (setColumns.length === 0) {
    throw new AppError('INTERNAL', '没有可恢复的列（只有主键）')
  }
  const setSql = setColumns.map((c) => `${columnList([c])} = ?`).join(', ')
  await session.rawQuery(
    `UPDATE ${tableRef} SET ${setSql} WHERE ${match.sql}`,
    [...setColumns.map((c) => normalizeForParam(before[c])), ...match.params]
  )
}

function normalizeForParam(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'object' && value !== null) {
    // Images are JSON; dates were serialised as ISO strings and buffers as
    // {type:'Buffer',data:[...]}. Convert them back to mysql2-friendly values.
    if (isBufferJson(value)) {
      const data = (value as { data: number[] }).data
      return Buffer.from(data)
    }
    if (Array.isArray(value) || isPlainObject(value)) {
      return JSON.stringify(value)
    }
  }
  return value
}

/* ------------------------------------------------------------------ */
/* Job / logging helpers                                               */
/* ------------------------------------------------------------------ */

function createJob(point: RecoveryPoint, mode: RestoreJob['mode']): RestoreJob {
  const steps: RestoreStep[] = [
    { index: 0, title: '读取前/后镜像', status: 'pending' },
    { index: 1, title: '比对当前数据，检测并发修改', status: 'pending' },
    { index: 2, title: '单事务内应用反向变更', status: 'pending' },
    { index: 3, title: '校验撤销结果', status: 'pending' }
  ]
  return {
    id: newId('job'),
    mode,
    backupId: null,
    recoveryPointId: point.id,
    projectId: point.projectId,
    connectionId: point.connectionId,
    sourceDatabase: point.database,
    targetDatabase: point.database,
    tempDatabase: null,
    status: 'running',
    progress: 0,
    steps,
    conflicts: [],
    startedAt: nowIso(),
    finishedAt: null,
    error: null,
    mayBePartial: false,
    logPath: null,
    verification: null
  }
}

function persistJob(services: Services, job: RestoreJob): void {
  try {
    services.store.insertJob('restore_jobs', job)
  } catch {
    /* job persistence is best-effort; the returned object is still truthful */
  }
}

async function finishFailed(
  services: Services,
  job: RestoreJob,
  point: RecoveryPoint,
  input: {
    error: string
    conflicts: RestoreConflict[]
    mayBePartial: boolean
    logLines?: string[]
  }
): Promise<RestoreJob> {
  const logPath = await writeJobLog(services, job.id, input.logLines ?? [input.error])
  const failed: RestoreJob = {
    ...job,
    status: 'failed',
    progress: 100,
    conflicts: input.conflicts,
    finishedAt: nowIso(),
    error: input.error,
    mayBePartial: input.mayBePartial,
    steps: job.steps.map((s) => ({ ...s, status: s.index <= 1 ? 'ok' : 'skipped' })),
    logPath
  }
  services.store.updateJob('restore_jobs', job.id, failed as unknown as Record<string, unknown>)
  audit(services, {
    action: 'recovery.undo',
    outcome: 'failure',
    connectionId: point.connectionId,
    projectId: point.projectId,
    target: point.database,
    detail: input.error
  })
  emitJob(services, {
    jobId: job.id,
    kind: 'undo',
    status: 'failed',
    phase: 'failed',
    message: input.error,
    progress: 1,
    error: input.error
  })
  return failed
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

export async function readJobLog(services: Services, jobId: string): Promise<string | null> {
  try {
    return await fs.readFile(join(services.paths.logs, 'restore-jobs', `${jobId}.log`), 'utf8')
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* compare / preview helpers                                           */
/* ------------------------------------------------------------------ */

function primaryKeyOf(row: RowImage, pkColumns: string[]): RowImage {
  return Object.fromEntries(pkColumns.map((c) => [c, row[c]]))
}

function pkKey(row: RowImage, pkColumns: string[]): string {
  return pkColumns.map((c) => `${c}=${stableValue(row[c])}`).join('&')
}

function stableValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Date) return `ts:${value.toISOString()}`
  if (Buffer.isBuffer(value)) return `b64:${value.toString('base64')}`
  if (typeof value === 'bigint') return `big:${value.toString()}`
  if (typeof value === 'object') return `json:${canonicalJson(value)}`
  return `${typeof value}:${String(value)}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function rowsEqual(a: RowImage, b: RowImage): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (stableValue(a[key]) !== stableValue(b[key])) return false
  }
  return true
}

async function fetchRowsByPkForUpdate(
  session: DbSession,
  database: string,
  table: string,
  pkColumns: string[],
  pks: RowImage[]
): Promise<RowImage[]> {
  const out: RowImage[] = []
  for (let i = 0; i < pks.length; i += 200) {
    const chunk = pks.slice(i, i + 200)
    const match = buildPkMatch(pkColumns, chunk)
    const rows = await session.rawQuery<RowImage>(
      `SELECT * FROM ${qualified(database, table)} WHERE ${match.sql} LIMIT ${MAX_CAPTURE_ROWS + 1} FOR UPDATE`,
      match.params
    )
    out.push(...rows.rows)
  }
  return out
}

function buildSqlPreview(changeSets: UndoChangeSet[]): string {
  const lines: string[] = []
  let emitted = 0
  for (const changes of changeSets) {
    if (!changes.canApply) {
      lines.push(`-- 表 ${changes.table} 不可撤销：${changes.blockedReason ?? '未知原因'}`)
      continue
    }
    const tableRef = `\`db\`.\`${changes.table.replace(/`/g, '``')}\``
    for (const row of changes.rows) {
      const pk = changes.primaryKeyColumns[0]
      const pkValue = escapeValue(row.primaryKey[pk])
      if (changes.operation === 'insert') {
        lines.push(`DELETE FROM ${tableRef} WHERE \`${pk}\` = ${pkValue}; -- 撤销 INSERT`)
      } else if (changes.operation === 'delete') {
        const cols = row.before ? Object.keys(row.before) : changes.primaryKeyColumns
        const values = row.before ? cols.map((c) => escapeValue(row.before?.[c])) : changes.primaryKeyColumns.map((c) => escapeValue(row.primaryKey[c]))
        lines.push(
          `INSERT INTO ${tableRef} (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${values.join(', ')}); -- 撤销 DELETE`
        )
      } else {
        const cols = Object.keys(row.before ?? {}).filter((c) => !changes.primaryKeyColumns.includes(c))
        lines.push(
          `UPDATE ${tableRef} SET ${cols.map((c) => `\`${c}\` = ${escapeValue(row.before?.[c])}`).join(', ')} WHERE \`${pk}\` = ${pkValue}; -- 撤销 UPDATE`
        )
      }
      emitted += 1
    }
    if (emitted >= PREVIEW_SQL_ROWS) break
  }
  if (lines.length === 0) lines.push('-- 没有可预览的撤销语句')
  if (emitted >= PREVIEW_SQL_ROWS) lines.push(`-- 仅预览前 ${PREVIEW_SQL_ROWS} 行，实际执行会处理全部行`)
  return lines.join('\n')
}

function isBufferJson(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

function listPush<T>(list: T[], item: T): void {
  list.push(item)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}




