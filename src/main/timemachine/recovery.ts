/**
 * RecoveryService + WriteProtection (the heart of the time machine).
 *
 * Strategy decisions are made from the classifier's AST analysis, never from
 * regexes. The executor calls:
 *
 *   prepare()        before the transaction: create a VERIFIED full backup when
 *                    the strategy requires one. A backup failure throws, which
 *                    makes the executor refuse to run a single statement.
 *   captureBefore()  inside the transaction: SELECT ... FOR UPDATE of affected
 *                    rows (before image), capped to avoid unbounded memory.
 *   captureAfter()   inside the transaction: rows after an UPDATE/INSERT.
 *   finalize()       after commit/rollback: persist JSON images + RecoveryPoint
 *                    with truthful coverage flags.
 *   abort()          on refusal: best-effort cleanup of half-written images.
 *
 * DDL note: MySQL/MariaDB DDL implicitly commits. We capture before/after
 * SHOW CREATE snapshots for comparison, but a DDL can NEVER be undone by a
 * transaction rollback - the recovery point says so explicitly.
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings,
  BackupRecord,
  CapturedRowSet,
  Id,
  RecoveryPlanSummary,
  RecoveryPoint,
  RecoveryPointKind,
  RecoveryPointStatus,
  RestoreJob,
  SqlAnalysis,
  StatementExecution,
  StatementRisk,
  UndoPreview
} from '@shared/types'
import type {
  CapturedBefore,
  ExecutionProtectionOutcome,
  HistoryTrigger,
  ProtectionContext,
  ProtectionPreparation,
  ProtectionResult,
  RecoveryService,
  Services,
  WriteProtection
} from '@main/service-contracts'
import { AppError, toAppError } from '@main/util/errors'
import { ensureDir, pathExists, removeFile, sha256File, writeFileAtomic } from '@main/util/fsx'
import { newId, sha256Hex } from '@main/util/id'
import { nowIso } from '@main/util/time'
import {
  captureCreateStatements,
  getTableMeta,
  listObjects,
  scalarNumber
} from './dbsession'
import { resolveServices, type ServicesProvider } from './deps'
import {
  IMAGE_FORMAT_VERSION,
  type CapturePlan,
  type ImageStatement,
  type ProtectionState,
  type RecoveryImageFileV1,
  type RowImage,
  type SchemaImage,
  type TableMeta
} from './internal-types'
import { MAX_CAPTURE_ROWS, buildPkMatch, validateWherePredicate } from './guard'
import { columnList, qualified } from './sqlformat'
import { localDateStamp } from './backup'
import { buildUndoPreview, executeUndo } from './undo'

const READ_KINDS = new Set(['select', 'show', 'explain', 'set', 'transaction'])

const STRATEGY_RANK: Record<RecoveryPlanSummary['strategy'], number> = {
  none: 0,
  before_image: 1,
  schema_snapshot: 2,
  full_backup: 3,
  refuse_unsafe: 4
}

export class MySqlRecoveryService implements RecoveryService {
  constructor(private readonly provider: ServicesProvider) {}

  private services(): Services {
    return resolveServices(this.provider)
  }

  async buildPlan(input: {
    connectionId: Id
    projectId: Id | null
    database: string
    sql: string
    analysis: SqlAnalysis
    session: import('@main/service-contracts').DbSession
    settings: AppSettings
  }): Promise<RecoveryPlanSummary> {
    const warnings: string[] = []
    const writeStatements = input.analysis.statements.filter((s) => !READ_KINDS.has(s.kind))
    if (writeStatements.length === 0) {
      return {
        strategy: 'none',
        needsBackup: false,
        reason: '只读语句，不需要恢复点或备份',
        estimatedAffectedRows: null,
        beforeImageSupported: true,
        warnings
      }
    }

    const decisions: { statement: StatementRisk; strategy: RecoveryPlanSummary['strategy']; reason: string }[] = []
    for (const statement of writeStatements) {
      const decision = await this.decideStatement(input.session, input.database, statement)
      decisions.push({ statement, ...decision })
      warnings.push(...decision.warnings)
    }

    const strategy = decisions.reduce<RecoveryPlanSummary['strategy']>(
      (max, d) => (STRATEGY_RANK[d.strategy] > STRATEGY_RANK[max] ? d.strategy : max),
      'none'
    )
    const needsBackup = strategy === 'full_backup' || decisions.some((d) => d.statement.requiresBackup)
    const targetTables = [
      ...new Set(
        writeStatements
          .map((s) => s.targetTable)
          .filter((t): t is string => typeof t === 'string' && t.length > 0)
      )
    ]
    const someTargetUnknown = writeStatements.some(
      (s) => s.targetTable === null || s.targetTable === undefined
    )
    let backupScope: RecoveryPlanSummary['backupScope']
    let backupTables: string[] | undefined
    if (needsBackup) {
      if (!someTargetUnknown && targetTables.length > 0) {
        backupScope = 'tables'
        backupTables = targetTables
      } else {
        backupScope = 'database'
      }
    }

    const estimates = writeStatements.map((s) => s.estimatedRows)
    const estimatedAffectedRows =
      estimates.length > 0 && estimates.every((n): n is number => typeof n === 'number')
        ? estimates.reduce((a, b) => a + b, 0)
        : null

    const reason = decisions
      .map((d) => `${describeStatement(d.statement)} → ${d.strategy}（${d.reason}）`)
      .join('；')
    if (strategy === 'schema_snapshot') {
      warnings.push(
        'DDL 在 MySQL/MariaDB 中会隐式提交：可以捕获前后 Schema 用于对比，但事务回滚不能撤销结构变更；需要回滚时请使用完整备份恢复'
      )
    }
    if (strategy === 'full_backup') {
      warnings.push('该操作要求执行前完成并通过校验的完整备份，否则执行器会阻止执行')
    }
    return {
      strategy,
      needsBackup,
      ...(backupScope ? { backupScope } : {}),
      ...(backupTables ? { backupTables } : {}),
      reason,
      estimatedAffectedRows,
      beforeImageSupported: strategy === 'before_image' || strategy === 'none',
      warnings: [...new Set(warnings)]
    }
  }

  private async decideStatement(
    session: import('@main/service-contracts').DbSession,
    database: string,
    statement: StatementRisk
  ): Promise<{
    strategy: RecoveryPlanSummary['strategy']
    reason: string
    warnings: string[]
  }> {
    const warnings: string[] = []
    if (READ_KINDS.has(statement.kind)) {
      return { strategy: 'none', reason: '只读', warnings }
    }
    if (statement.parseError) {
      warnings.push(`${describeStatement(statement)} 解析失败（${statement.parseError}），按最高风险处理`)
      return { strategy: 'full_backup', reason: '解析失败，无法确定影响范围', warnings }
    }
    if (statement.kind === 'insert') {
      if (!statement.targetTable) {
        return { strategy: 'full_backup', reason: '无法确定目标表', warnings }
      }
      const meta = await safeTableMeta(session, database, statement.targetTable, warnings)
      if (!meta) return { strategy: 'full_backup', reason: '无法读取目标表元数据', warnings }
      if (meta.triggers.length > 0) {
        warnings.push(`表 ${meta.name} 有触发器，INSERT 的副作用无法从前/后镜像还原`)
        return { strategy: 'full_backup', reason: '目标表存在触发器', warnings }
      }
      if (meta.primaryKey.length === 0) {
        warnings.push(`表 ${meta.name} 没有主键，无法可靠确定插入行，撤销不可保证`)
        return { strategy: 'full_backup', reason: '表无主键，INSERT 无法可靠撤销', warnings }
      }
      if (statement.valueTuples !== null && statement.valueTuples !== undefined && statement.valueTuples > 5000) {
        warnings.push('批量 INSERT 行数较多，前镜像/后镜像捕获可能不完整')
      }
      return {
        strategy: 'before_image',
        reason: '有主键，按执行后主键捕获新行用于撤销',
        warnings
      }
    }
    if (statement.kind === 'replace') {
      warnings.push('REPLACE 会删除冲突的旧行，旧行值不在 WHERE 范围内，前镜像不可靠')
      return { strategy: 'full_backup', reason: 'REPLACE 的删除语义不可靠捕获', warnings }
    }
    if (statement.kind === 'update' || statement.kind === 'delete') {
      if (!statement.targetTable) {
        return { strategy: 'full_backup', reason: '无法确定目标表', warnings }
      }
      const meta = await safeTableMeta(session, database, statement.targetTable, warnings)
      if (!meta) return { strategy: 'full_backup', reason: '无法读取目标表元数据', warnings }
      if (!statement.hasWhereClause || !statement.whereSql) {
        warnings.push(`${describeStatement(statement)} 没有可用的 WHERE 条件，无法界定受影响行`)
        return { strategy: 'full_backup', reason: '无 WHERE，影响范围不可控', warnings }
      }
      if (meta.primaryKey.length === 0) {
        warnings.push(`表 ${meta.name} 没有主键，无法可靠捕获/回写前镜像`)
        return { strategy: 'full_backup', reason: '目标表无主键', warnings }
      }
      if (meta.triggers.length > 0) {
        warnings.push(`表 ${meta.name} 有触发器，事务回滚不能撤销触发器的外部副作用`)
        return { strategy: 'full_backup', reason: '目标表存在触发器', warnings }
      }
      const validation = validateWherePredicate(statement.whereSql, statement.targetTable)
      if (!validation.ok) {
        warnings.push(`WHERE 条件未通过安全校验：${validation.reason}`)
        return { strategy: 'full_backup', reason: 'WHERE 条件不可安全重放', warnings }
      }
      return {
        strategy: 'before_image',
        reason: '有 WHERE 且目标表有主键，事务内 SELECT ... FOR UPDATE 捕获前镜像',
        warnings
      }
    }
    if (statement.kind === 'create' || statement.kind === 'alter' || statement.kind === 'rename') {
      warnings.push('结构变更会隐式提交，只能记录前后 Schema 快照，不能依赖事务回滚')
      return { strategy: 'schema_snapshot', reason: '结构变更：捕获前后 Schema', warnings }
    }
    if (statement.kind === 'drop' || statement.kind === 'truncate') {
      return {
        strategy: 'full_backup',
        reason: '破坏性操作，必须先有经验证的完整备份',
        warnings
      }
    }
    // load / grant / procedure(CALL) / unknown: assume the worst.
    warnings.push(`${describeStatement(statement)} 风险无法可靠评估，按最高风险处理`)
    return { strategy: 'full_backup', reason: '无法可靠评估影响范围', warnings }
  }

  createProtection(ctx: {
    connectionId: Id
    projectId: Id | null
    database: string
    executionId: Id
    planId: Id
    sql: string
    analysis: SqlAnalysis
    trigger: HistoryTrigger
    recoveryPlan: RecoveryPlanSummary
    settings: AppSettings
    emitProgress?: (p: { phase: string; message: string; progress: number }) => void
    signal?: AbortSignal
  }): WriteProtection {
    return new MySqlWriteProtection(this.provider, ctx.recoveryPlan)
  }

  get(id: Id): RecoveryPoint | null {
    return this.services().store.getRecoveryPoint(id)
  }

  list(q: { projectId?: Id; connectionId?: Id; limit?: number }): {
    items: RecoveryPoint[]
    total: number
  } {
    return this.services().store.listRecoveryPoints({
      ...q,
      limit: Math.max(1, Math.min(q.limit ?? 100, 1000))
    })
  }

  async previewUndo(recoveryPointId: Id): Promise<UndoPreview> {
    return buildUndoPreview(this.services(), recoveryPointId)
  }

  async undo(
    recoveryPointId: Id,
    options: { confirmed: boolean; approvalId?: Id | null }
  ): Promise<RestoreJob> {
    return executeUndo(this.services(), recoveryPointId, options)
  }

  async refreshStatus(recoveryPointId: Id): Promise<RecoveryPoint> {
    const services = this.services()
    const point = services.store.getRecoveryPoint(recoveryPointId)
    if (!point) throw new AppError('NOT_FOUND', `恢复点 ${recoveryPointId} 不存在`)
    if (point.status === 'expired') return point
    const problems: string[] = []
    let beforeText: string | null = null
    let afterText: string | null = null
    for (const [label, path, slot] of [
      ['前镜像', point.beforeImagePath, 'before'],
      ['后镜像', point.afterImagePath, 'after']
    ] as [string, string | null | undefined, 'before' | 'after'][]) {
      if (!path) continue
      if (!(await pathExists(path))) {
        problems.push(`${label}文件不存在：${path}`)
        continue
      }
      const text = await fs.readFile(path, 'utf8')
      if (slot === 'before') beforeText = text
      else afterText = text
    }
    const expected = point.checksum ?? null
    const actual =
      beforeText === null && afterText === null ? null : imageChecksum(beforeText, afterText)
    const checksumOk = !expected || actual === expected
    if (!checksumOk) problems.push('镜像文件校验和不一致（文件可能被修改或损坏）')
    const status: RecoveryPointStatus =
      problems.length === 0 ? point.status : point.kind === 'none' ? 'unusable' : 'partial'
    return services.store.updateRecoveryPoint(point.id, {
      status,
      note: problems.length > 0 ? `${point.note}；状态刷新：${problems.join('；')}` : point.note
    })
  }
}

/** Checksum over the two image payloads (empty string for a missing side). */
export function imageChecksum(beforeText: string | null, afterText: string | null): string {
  return sha256Hex(`${beforeText ?? ''}\n${afterText ?? ''}`)
}

/* ------------------------------------------------------------------ */
/* Write protection                                                    */
/* ------------------------------------------------------------------ */

export class MySqlWriteProtection implements WriteProtection {
  constructor(
    private readonly provider: ServicesProvider,
    private readonly plan: RecoveryPlanSummary
  ) {}

  async prepare(ctx: ProtectionContext): Promise<ProtectionPreparation> {
    const services = resolveServices(this.provider)
    const settings = ctx.settings
    const warnings = [...(this.plan.warnings ?? [])]
    const state: ProtectionState = {
      recoveryPointId: newId('rp'),
      database: ctx.database,
      strategy: this.plan.strategy,
      plans: [],
      backupId: null,
      backupVerified: false,
      backupWarnings: [],
      upgradedToBackup: false,
      before: [],
      after: [],
      schemaBefore: null,
      schemaAfter: null,
      warnings,
      partial: false,
      startedAt: nowIso()
    }
    const progress = ctx.emitProgress ?? (() => undefined)
    progress({ phase: 'protection', message: '评估恢复点保护策略', progress: 0.1 })

    if (!settings.autoProtection) {
      warnings.push('自动保护设置已关闭，但高风险操作仍强制要求已验证备份（不会静默跳过）')
    }

    const writeStatements = ctx.analysis.statements.filter((s) => !READ_KINDS.has(s.kind))
    const metaUsed = new Map<string, TableMeta | null>()

    // Build capture plans for DML statements.
    for (const statement of writeStatements) {
      if (!['insert', 'update', 'delete', 'replace'].includes(statement.kind)) continue
      const table = statement.targetTable
      if (!table) {
        warnings.push(`${describeStatement(statement)} 缺少目标表，无法捕获镜像（依赖备份）`)
        continue
      }
      let meta = metaUsed.get(table)
      if (meta === undefined) {
        meta = await safeTableMeta(ctx.session, ctx.database, table, warnings)
        metaUsed.set(table, meta)
      }
      if (!meta || meta.primaryKey.length === 0) {
        warnings.push(`表 ${table} 无可用主键，跳过前镜像捕获（依赖完整备份）`)
        continue
      }
      const whereSql = statement.kind === 'update' || statement.kind === 'delete' ? statement.whereSql ?? null : null
      const plan: CapturePlan = {
        statementIndex: statement.statementIndex,
        kind: statement.kind,
        targetTable: table,
        whereSql,
        primaryKeyColumns: [...meta.primaryKey],
        noUsablePrimaryKey: false,
        hasTriggers: meta.triggers.length > 0,
        estimatedRows: statement.estimatedRows,
        warnings: []
      }
      state.plans.push(plan)
    }

    // Pre-flight: reject/replace captures that could exceed the memory cap.
    let upgrade = false
    for (const plan of state.plans) {
      if (plan.kind === 'update' || plan.kind === 'delete') {
        if (!plan.whereSql) {
          upgrade = true
          plan.warnings.push('无 WHERE，无法可靠捕获前镜像，升级为完整备份')
          continue
        }
        const validation = validateWherePredicate(plan.whereSql, plan.targetTable as string)
        if (!validation.ok) {
          throw new AppError(
            'PROTECTION_FAILED',
            `WHERE 条件未通过安全校验，拒绝捕获前镜像：${validation.reason}`
          )
        }
        plan.whereSql = validation.normalized
        const countSql = `SELECT 1 AS x FROM ${qualified(ctx.database, plan.targetTable as string)} WHERE (${validation.normalized}) LIMIT ${MAX_CAPTURE_ROWS + 1}`
        const countRows = await ctx.session.rawQuery<Record<string, unknown>>(countSql)
        plan.estimatedRows = countRows.rows.length
        if (countRows.rows.length > MAX_CAPTURE_ROWS) {
          upgrade = true
          plan.warnings.push(`受影响行数超过 ${MAX_CAPTURE_ROWS}，升级为完整备份并仅捕获前 ${MAX_CAPTURE_ROWS} 行`)
        }
      }
      if (plan.kind === 'insert') {
        const tuples = statementTuples(ctx.analysis, plan.statementIndex)
        plan.estimatedRows = tuples
        if (tuples !== null && tuples > MAX_CAPTURE_ROWS) {
          upgrade = true
          plan.warnings.push(`批量 INSERT 行数 ${tuples} 超过捕获上限，升级为完整备份`)
        }
      }
    }

    const needsBackup = this.plan.needsBackup || this.plan.strategy === 'full_backup' || upgrade
    if (needsBackup) {
      progress({ phase: 'backup', message: '创建执行前完整备份', progress: 0.2 })
      const scope = this.plan.backupScope ?? 'database'
      const tables = scope === 'tables' ? this.plan.backupTables ?? [] : undefined
      let backup: BackupRecord
      try {
        backup = await services.backups.create(
          {
            connectionId: ctx.connectionId,
            projectId: ctx.projectId,
            database: ctx.database,
            scope,
            ...(tables ? { tables } : {}),
            type: 'full',
            verify: false,
            label: 'write-protection'
          },
          {
            projectId: ctx.projectId,
            signal: ctx.signal,
            emitProgress: (p) =>
              progress({
                phase: `backup.${p.phase}`,
                message: p.message,
                progress: 0.2 + Math.min(0.5, p.progress * 0.5)
              })
          }
        )
      } catch (e) {
        const message = toAppError(e, 'BACKUP_FAILED').message
        this.auditFailure(services, ctx, `执行前备份失败，已阻止执行：${message}`)
        throw new AppError('BACKUP_FAILED', `高风险操作要求完整备份，但备份失败：${message}`, {
          hint: '数据库未执行任何写语句'
        })
      }
      state.backupId = backup.id
      state.backupWarnings.push(...backup.verification.notes)
      if (upgrade) state.upgradedToBackup = true
      // The backup must be *verified*, not merely created.
      const verified = await services.backups.verify(backup.id, { restoreTest: false })
      if (verified.status !== 'verified' && verified.status !== 'restore_tested') {
        this.auditFailure(
          services,
          ctx,
          `执行前备份校验未通过（status=${verified.status}），已阻止执行`
        )
        throw new AppError(
          'PROTECTION_FAILED',
          `高风险操作要求已验证备份，但备份校验失败（status=${verified.status}）`,
          { details: { backupId: verified.id, verification: verified.verification } }
        )
      }
      state.backupVerified = true
      warnings.push(`已创建并校验完整备份 ${verified.id}（${verified.fileName}）`)
      progress({ phase: 'backup', message: '完整备份已通过校验', progress: 0.75 })
    }

    // DDL schema snapshot (before execution, DDL implicitly commits).
    const ddlStatements = writeStatements.filter((s) =>
      ['create', 'alter', 'rename', 'drop', 'truncate'].includes(s.kind)
    )
    if (ddlStatements.length > 0 || this.plan.strategy === 'schema_snapshot') {
      state.schemaBefore = await this.captureSchemaBefore(ctx.session, ctx.database, ddlStatements, warnings)
      warnings.push('DDL 隐式提交：schema 快照用于对比与人工恢复，不能通过事务回滚撤销')
    }

    return {
      recoveryPointId: state.recoveryPointId,
      backupId: state.backupId,
      warnings: unique([...warnings, ...state.backupWarnings]),
      preparedAt: nowIso(),
      state
    }
  }

  private async captureSchemaBefore(
    session: ProtectionContext['session'],
    database: string,
    ddlStatements: StatementRisk[],
    warnings: string[]
  ): Promise<Record<string, string>> {
    const targets = [
      ...new Set(
        ddlStatements
          .map((s) => s.targetTable)
          .filter((t): t is string => typeof t === 'string' && t.length > 0)
      )
    ]
    try {
      const objects =
        targets.length > 0
          ? (await listObjects(session, database)).filter((o) => targets.includes(o.name))
          : await listObjects(session, database)
      return await captureCreateStatements(session, database, objects)
    } catch (e) {
      warnings.push(`无法捕获执行前 Schema 快照：${toAppError(e).message}`)
      return {}
    }
  }

  async captureBefore(
    ctx: ProtectionContext,
    prep: ProtectionPreparation,
    statement: StatementRisk
  ): Promise<CapturedBefore> {
    const state = this.stateOf(prep)
    const plan = state.plans.find((p) => p.statementIndex === statement.statementIndex)
    if (!plan) return { state, warnings: [], capturedRows: 0 }
    const warnings: string[] = [...plan.warnings]

    if (plan.kind === 'replace' && statement.pkValues) {
      // REPLACE deletes conflicting rows: capture exactly the rows it may replace.
      const pk = plan.primaryKeyColumns
      const values = pk.map((c) => statement.pkValues?.[c])
      if (values.some((v) => v === undefined)) {
        warnings.push('REPLACE 的主键值不完整，无法捕获将被删除的旧行')
      } else {
        const row = Object.fromEntries(pk.map((c, i) => [c, values[i]]))
        const match = buildPkMatch(pk, [row])
        const sql = `SELECT * FROM ${qualified(ctx.database, plan.targetTable as string)} WHERE ${match.sql} LIMIT ${MAX_CAPTURE_ROWS + 1}${
          ctx.session.inTransaction() ? ' FOR UPDATE' : ''
        }`
        const rows = (await ctx.session.rawQuery<RowImage>(sql, match.params)).rows
        pushBeforeImage(state, plan, rows, statement, warnings)
        return { state, warnings, capturedRows: rows.length }
      }
    }

    if (plan.kind === 'insert') {
      // Nothing to lock before an INSERT; new rows are located in captureAfter().
      return { state, warnings, capturedRows: 0 }
    }

    const tableRef = qualified(ctx.database, plan.targetTable as string)
    const where = plan.whereSql ? ` WHERE (${plan.whereSql})` : ''
    const order = plan.primaryKeyColumns.map((c) => `\`${c.replace(/`/g, '``')}\``).join(', ')
    const lock = ctx.session.inTransaction() ? ' FOR UPDATE' : ''
    const sql = `SELECT * FROM ${tableRef}${where} ORDER BY ${order} LIMIT ${MAX_CAPTURE_ROWS + 1}${lock}`
    const rows = (await ctx.session.rawQuery<RowImage>(sql)).rows
    if (rows.length > MAX_CAPTURE_ROWS) {
      if (!state.backupId) {
        this.auditFailure(resolveServices(this.provider), ctx, '前镜像捕获超过上限且没有完整备份')
        throw new AppError(
          'PROTECTION_FAILED',
          `受影响行数超过捕获上限 ${MAX_CAPTURE_ROWS} 且没有完整备份，已阻止执行`,
          { hint: '请先创建完整备份，或缩小 WHERE 范围' }
        )
      }
      const truncated = rows.slice(0, MAX_CAPTURE_ROWS)
      warnings.push(`前镜像捕获达到上限 ${MAX_CAPTURE_ROWS} 行，已截断并标记为 partial`)
      pushBeforeImage(state, plan, truncated, statement, warnings, true)
      state.partial = true
      return { state, warnings, capturedRows: truncated.length }
    }
    pushBeforeImage(state, plan, rows, statement, warnings)
    return { state, warnings, capturedRows: rows.length }
  }

  async captureAfter(
    ctx: ProtectionContext,
    prep: ProtectionPreparation,
    before: CapturedBefore,
    outcome: StatementExecution
  ): Promise<void> {
    const state = this.stateOf(prep)
    const plan = state.plans.find((p) => p.statementIndex === outcome.statementIndex)
    if (!plan) {
      // DDL: capture the schema after the fact.
      await this.captureSchemaAfter(ctx, state, outcome)
      return
    }
    const warnings: string[] = []
    const beforeImage = state.before.find((s) => s.statementIndex === outcome.statementIndex)
    const afterRows: RowImage[] = []
    const expectedRows = beforeImage?.beforeRows.length ?? 0

    if (plan.kind === 'update') {
      const pkRows = (beforeImage?.beforeRows ?? [])
        .map((row) => Object.fromEntries(plan.primaryKeyColumns.map((c) => [c, row[c]])))
        .filter((row) => plan.primaryKeyColumns.every((c) => row[c] !== null && row[c] !== undefined))
      afterRows.push(...(await selectByPk(ctx.session, ctx.database, plan.targetTable as string, plan.primaryKeyColumns, pkRows)))
      if (afterRows.length !== expectedRows) {
        warnings.push(`UPDATE 后按主键找到 ${afterRows.length} 行，与执行前捕获的 ${expectedRows} 行不一致（可能有触发器或并发修改）`)
        state.partial = true
      }
    } else if (plan.kind === 'delete') {
      // Nothing to capture: the before image contains the deleted rows.
    } else if (plan.kind === 'insert' || plan.kind === 'replace') {
      const located = await this.locateInsertedRows(ctx, plan, outcome, warnings)
      afterRows.push(...located.rows)
      if (located.partial) state.partial = true
      if (located.rows.length === 0 && outcome.affectedRows > 0) {
        warnings.push(
          `无法可靠定位 INSERT 影响的新行（insertId=${outcome.insertId}, affectedRows=${outcome.affectedRows}），后镜像标记为 partial`
        )
        state.partial = true
      }
    }

    state.after.push({
      statementIndex: outcome.statementIndex,
      kind: plan.kind,
      targetTable: plan.targetTable,
      whereSql: plan.whereSql,
      primaryKeyColumns: plan.primaryKeyColumns,
      beforeRows: [],
      afterRows,
      primaryKeys: afterRows.map((row) =>
        Object.fromEntries(plan.primaryKeyColumns.map((c) => [c, row[c]]))
      ),
      partial: state.partial,
      warnings: unique([...(beforeImage?.warnings ?? []), ...warnings]),
      affectedRows: outcome.affectedRows
    })
    if (warnings.length > 0) state.warnings.push(...warnings)
  }

  private async locateInsertedRows(
    ctx: ProtectionContext,
    plan: CapturePlan,
    outcome: StatementExecution,
    warnings: string[]
  ): Promise<{ rows: RowImage[]; partial: boolean }> {
    const table = plan.targetTable as string
    const meta = await getTableMeta(ctx.session, ctx.database, table)
    const pk = plan.primaryKeyColumns
    // 1) literal primary keys from the parsed AST
    const literal = (ctx.analysis.statements.find((s) => s.statementIndex === plan.statementIndex)?.pkValues ?? null) as
      | Record<string, unknown>
      | null
    if (literal && pk.every((c) => literal[c] !== undefined)) {
      return {
        rows: await selectByPk(ctx.session, ctx.database, table, pk, [literal]),
        partial: false
      }
    }
    // 2) AUTO_INCREMENT allocation from insertId + affectedRows
    const singlePk = pk.length === 1 ? pdColumn(meta, pk[0]) : null
    if (
      outcome.insertId !== null &&
      outcome.insertId !== undefined &&
      outcome.affectedRows > 0 &&
      singlePk &&
      singlePk.autoIncrement &&
      isIntegerType(singlePk.dataType)
    ) {
      const inc = await this.autoIncrementIncrement(ctx.session)
      const start = Number(outcome.insertId)
      const end = start + outcome.affectedRows * inc
      const rows = (
        await ctx.session.rawQuery<RowImage>(
          `SELECT * FROM ${qualified(ctx.database, table)} WHERE \`${pk[0].replace(/`/g, '``')}\` >= ? AND \`${pk[0].replace(/`/g, '``')}\` < ? ORDER BY \`${pk[0].replace(/`/g, '``')}\` LIMIT ${MAX_CAPTURE_ROWS + 1}`,
          [start, end]
        )
      ).rows
      if (rows.length === outcome.affectedRows) return { rows, partial: false }
      warnings.push(
        `通过 AUTO_INCREMENT 区间定位到 ${rows.length}/${outcome.affectedRows} 行新数据`
      )
      return { rows, partial: true }
    }
    if (outcome.affectedRows === 0) return { rows: [], partial: false }
    warnings.push(
      'INSERT 使用了显式主键或非自增主键，且无法从 AST 静态确定主键值：后镜像不可靠'
    )
    return { rows: [], partial: true }
  }

  private async autoIncrementIncrement(session: ProtectionContext['session']): Promise<number> {
    try {
      const r = await session.rawQuery<Record<string, unknown>>(
        'SELECT @@auto_increment_increment AS inc'
      )
      const inc = scalarNumber(r.rows[0]?.inc)
      return inc > 0 ? inc : 1
    } catch {
      return 1
    }
  }

  private async captureSchemaAfter(
    ctx: ProtectionContext,
    state: ProtectionState,
    outcome: StatementExecution
  ): Promise<void> {
    const statement = ctx.analysis.statements.find((s) => s.statementIndex === outcome.statementIndex)
    if (!statement) return
    if (!['create', 'alter', 'rename', 'drop', 'truncate'].includes(statement.kind)) return
    const merged = state.schemaAfter ?? {}
    try {
      const object = statement.targetTable
      const objects = object
        ? (await listObjects(ctx.session, ctx.database)).filter((o) => o.name === object)
        : await listObjects(ctx.session, ctx.database)
      for (const entry of objects) {
        const created = await captureCreateStatements(ctx.session, ctx.database, [entry])
        Object.assign(merged, created)
      }
      state.schemaAfter = merged
    } catch (e) {
      state.warnings.push(`DDL 执行后无法捕获 Schema：${toAppError(e).message}`)
      state.partial = true
    }
  }

  async finalize(
    ctx: ProtectionContext,
    prep: ProtectionPreparation,
    result: ExecutionProtectionOutcome
  ): Promise<ProtectionResult> {
    const services = resolveServices(this.provider)
    const state = this.stateOf(prep)
    const warnings = unique([...state.warnings, ...state.backupWarnings])

    const beforeStatements = state.before.filter(
      (s) => s.beforeRows.length > 0 || s.partial || s.warnings.length > 0
    )
    const afterStatements = state.after
    const hasSchema = state.schemaBefore !== null || state.schemaAfter !== null
    const hasAnyCapture =
      beforeStatements.length > 0 || afterStatements.length > 0 || hasSchema || state.backupId !== null
    if (!hasAnyCapture) {
      return {
        recoveryPointId: null,
        backupId: state.backupId,
        warnings,
        coverage: null
      }
    }

    if (!result.ok) {
      warnings.push('执行未成功；恢复点记录的是实际捕获到的内容，请结合错误信息判断')
    }
    if (result.transaction === 'implicit_ddl') {
      warnings.push('本次执行包含 DDL（隐式提交），不能通过事务回滚恢复结构变更')
    }

    const dir = join(
      services.paths.recoveryPoints,
      sanitizeSegment(ctx.database),
      localDateStamp(new Date())
    )
    await ensureDir(dir)
    const beforePath = join(dir, `${state.recoveryPointId}-before.json`)
    const afterPath = join(dir, `${state.recoveryPointId}-after.json`)

    const beforeFile: RecoveryImageFileV1 = {
      version: IMAGE_FORMAT_VERSION,
      format: 'aidb-recovery-image',
      recoveryPointId: state.recoveryPointId,
      executionId: ctx.executionId,
      planId: ctx.planId,
      connectionId: ctx.connectionId,
      projectId: ctx.projectId,
      database: ctx.database,
      kind: 'before',
      capturedAt: nowIso(),
      statements: beforeStatements,
      ...(hasSchema && state.schemaBefore
        ? { schema: schemaImage(state.schemaBefore, state.schemaAfter ?? {}) }
        : {}),
      partial: state.partial,
      warnings
    }
    const afterFile: RecoveryImageFileV1 = {
      version: IMAGE_FORMAT_VERSION,
      format: 'aidb-recovery-image',
      recoveryPointId: state.recoveryPointId,
      executionId: ctx.executionId,
      planId: ctx.planId,
      connectionId: ctx.connectionId,
      projectId: ctx.projectId,
      database: ctx.database,
      kind: 'after',
      capturedAt: nowIso(),
      statements: afterStatements,
      partial: state.partial,
      warnings
    }

    let beforeText: string | null = null
    let afterText: string | null = null
    try {
      if (beforeStatements.length > 0 || hasSchema) {
        beforeText = JSON.stringify(beforeFile)
        await writeFileAtomic(beforePath, beforeText)
      }
      if (afterStatements.length > 0) {
        afterText = JSON.stringify(afterFile)
        await writeFileAtomic(afterPath, afterText)
      }
    } catch (e) {
      await removeFile(beforePath).catch(() => undefined)
      await removeFile(afterPath).catch(() => undefined)
      throw new AppError('PROTECTION_FAILED', `恢复点镜像写入失败：${toAppError(e).message}`)
    }

    const checksum = imageChecksum(beforeText, afterText)
    const sizeBytes =
      (beforeText ? Buffer.byteLength(beforeText) : 0) +
      (afterText ? Buffer.byteLength(afterText) : 0)
    const kind = recoveryKind(state)
    // Captured row sets include after-image rows so INSERT recovery points are
    // not reported as "nothing captured".
    const captured: CapturedRowSet[] = [
      ...beforeStatements
        .filter((s) => s.targetTable)
        .map((s) => ({
          table: s.targetTable as string,
          primaryKeyColumns: s.primaryKeyColumns,
          rowCount: s.beforeRows.length,
          truncated: s.partial
        })),
      ...afterStatements
        .filter((s) => s.targetTable && s.afterRows.length > 0)
        .map((s) => ({
          table: s.targetTable as string,
          primaryKeyColumns: s.primaryKeyColumns,
          rowCount: s.afterRows.length,
          truncated: s.partial
        }))
    ]
    const status: RecoveryPointStatus = state.partial || !result.ok ? 'partial' : 'ready'
    const note = buildNote({
      state,
      result,
      verified: state.backupVerified,
      warnings
    })
    const point: RecoveryPoint = {
      id: state.recoveryPointId,
      executionId: ctx.executionId,
      planId: ctx.planId,
      projectId: ctx.projectId,
      connectionId: ctx.connectionId,
      database: ctx.database,
      kind,
      strategy: state.strategy as RecoveryPoint['strategy'],
      risk: ctx.analysis.overallRisk,
      targetTables: [...new Set(state.plans.map((p) => p.targetTable).filter((t): t is string => !!t))],
      beforeImagePath: beforeStatements.length > 0 || hasSchema ? beforePath : null,
      afterImagePath: afterStatements.length > 0 ? afterPath : null,
      schemaSnapshotId: null,
      backupId: state.backupId,
      captured,
      createdAt: nowIso(),
      status,
      verified: true,
      verifiedAt: nowIso(),
      note,
      sizeBytes,
      checksum,
      coverage: {
        hasOperationLog: true,
        hasBeforeImage: beforeStatements.length > 0 || hasSchema,
        hasFullBackup: state.backupId !== null,
        backupVerified: state.backupVerified
      }
    }
    const stored = services.store.insertRecoveryPoint(point)
    this.audit(services, ctx, 'success', `创建恢复点 ${stored.id}（${kind}，${captured.length} 张表）`)
    return {
      recoveryPointId: stored.id,
      backupId: state.backupId,
      warnings,
      coverage: stored.coverage
    }
  }

  async abort(ctx: ProtectionContext, prep: ProtectionPreparation | null, error: Error): Promise<void> {
    const services = resolveServices(this.provider)
    const state = prep ? (prep.state as ProtectionState | null) : null
    if (state?.recoveryPointId) {
      // finalize() writes images atomically; if a previous attempt left files
      // behind, remove them so no half-finished recovery point is offered.
      try {
        const dir = join(
          services.paths.recoveryPoints,
          sanitizeSegment(ctx.database),
          localDateStamp(new Date())
        )
        await removeFile(join(dir, `${state.recoveryPointId}-before.json`))
        await removeFile(join(dir, `${state.recoveryPointId}-after.json`))
      } catch {
        /* best effort */
      }
    }
    this.auditFailure(
      services,
      ctx,
      `保护流程中止：${error.message}${state?.backupId ? `；已创建的备份 ${state.backupId} 保留可用` : ''}`
    )
  }

  private stateOf(prep: ProtectionPreparation): ProtectionState {
    const state = prep.state as ProtectionState | null
    if (!state || typeof state !== 'object' || !('recoveryPointId' in state)) {
      throw new AppError('INTERNAL', '保护状态缺失或损坏')
    }
    return state
  }

  private audit(
    services: Services,
    ctx: ProtectionContext,
    outcome: 'success' | 'failure' | 'info',
    detail: string
  ): void {
    try {
      services.audit.record({
        actor: 'system',
        action: 'recovery_point.create',
        connectionId: ctx.connectionId,
        projectId: ctx.projectId,
        target: ctx.database,
        risk: ctx.analysis.overallRisk,
        sqlPreview: ctx.sql.slice(0, 300),
        outcome,
        detail
      })
    } catch {
      /* audit is best-effort */
    }
  }

  private auditFailure(services: Services, ctx: ProtectionContext, detail: string): void {
    try {
      services.audit.record({
        actor: 'system',
        action: 'write_protection.prepare',
        connectionId: ctx.connectionId,
        projectId: ctx.projectId,
        target: ctx.database,
        risk: ctx.analysis.overallRisk,
        outcome: 'denied',
        detail
      })
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* image helpers                                                       */
/* ------------------------------------------------------------------ */

export async function readImageFile(path: string): Promise<RecoveryImageFileV1> {
  const raw = await fs.readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError('INTERNAL', `恢复点镜像文件不是合法 JSON：${path}`)
  }
  const file = parsed as Partial<RecoveryImageFileV1>
  if (file.format !== 'aidb-recovery-image' || file.version !== IMAGE_FORMAT_VERSION) {
    throw new AppError('INTERNAL', `未知的恢复点镜像格式：${path}`)
  }
  return {
    ...(file as RecoveryImageFileV1),
    statements: Array.isArray(file.statements) ? file.statements : [],
    warnings: Array.isArray(file.warnings) ? file.warnings : [],
    partial: file.partial === true
  }
}

export function summarizeImageRows(statements: ImageStatement[]): number {
  return statements.reduce((sum, s) => sum + s.beforeRows.length + s.afterRows.length, 0)
}

export function schemaImage(before: Record<string, string>, after: Record<string, string>): SchemaImage {
  return { before, after, implicitCommit: true }
}

function pushBeforeImage(  state: ProtectionState,
  plan: CapturePlan,
  rows: RowImage[],
  statement: StatementRisk,
  warnings: string[],
  partial = false
): void {
  const entry: ImageStatement = {
    statementIndex: plan.statementIndex,
    kind: plan.kind,
    targetTable: plan.targetTable,
    whereSql: plan.whereSql,
    primaryKeyColumns: plan.primaryKeyColumns,
    beforeRows: rows,
    afterRows: [],
    primaryKeys: rows.map((row) =>
      Object.fromEntries(plan.primaryKeyColumns.map((c) => [c, row[c]]))
    ),
    partial,
    warnings: [...warnings]
  }
  state.before.push(entry)
  if (partial) state.partial = true
  if (statement.hasWhereClause === false && plan.kind !== 'insert' && plan.kind !== 'replace') {
    warnings.push(`${describeStatement(statement)} 没有 WHERE，前镜像覆盖整表（受上限保护）`)
  }
}

async function selectByPk(
  session: ProtectionContext['session'],
  database: string,
  table: string,
  pkColumns: string[],
  rows: RowImage[]
): Promise<RowImage[]> {
  if (rows.length === 0) return []
  const sqlColumn = columnList(pkColumns)
  const tableRef = qualified(database, table)
  const out: RowImage[] = []
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const match = buildPkMatch(pkColumns, chunk)
    const order = sqlColumn
    const result = await session.rawQuery<RowImage>(
      `SELECT * FROM ${tableRef} WHERE ${match.sql} ORDER BY ${order} LIMIT ${MAX_CAPTURE_ROWS + 1}`,
      match.params
    )
    out.push(...result.rows)
  }
  return out
}

function pdColumn(meta: TableMeta, name: string): TableMeta['columns'][number] | null {
  return meta.columns.find((c) => c.name === name) ?? null
}

function isIntegerType(dataType: string): boolean {
  return ['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'].includes(dataType)
}

function statementTuples(analysis: SqlAnalysis, statementIndex: number): number | null {
  const statement = analysis.statements.find((s) => s.statementIndex === statementIndex)
  if (!statement) return null
  if (typeof statement.valueTuples === 'number') return statement.valueTuples
  return null
}

async function safeTableMeta(
  session: import('@main/service-contracts').DbSession,
  database: string,
  table: string,
  warnings: string[]
): Promise<TableMeta | null> {
  try {
    return await getTableMeta(session, database, table)
  } catch (e) {
    warnings.push(`无法读取表 ${table} 的元数据：${toAppError(e).message}`)
    return null
  }
}

function describeStatement(statement: StatementRisk): string {
  return `${statement.kind.toUpperCase()}${statement.targetTable ? ` ${statement.targetTable}` : ''}`
}

function recoveryKind(state: ProtectionState): RecoveryPointKind {
  if (state.backupId) return 'full_backup'
  if (state.schemaBefore !== null || state.schemaAfter !== null) return 'ddl_schema_snapshot'
  if (
    state.before.some((s) => s.beforeRows.length > 0) ||
    state.after.some((s) => s.afterRows.length > 0)
  ) {
    return 'dml_before_image'
  }
  if (state.partial) return 'partial'
  return 'none'
}

function buildNote(input: {
  state: ProtectionState
  result: ExecutionProtectionOutcome
  verified: boolean
  warnings: string[]
}): string {
  const parts: string[] = []
  const rows = input.state.before.reduce((sum, s) => sum + s.beforeRows.length, 0)
  parts.push(`事务结果：${input.result.transaction}`)
  if (rows > 0) parts.push(`前镜像 ${rows} 行`)
  if (input.state.after.length > 0) {
    parts.push(`后镜像 ${input.state.after.reduce((sum, s) => sum + s.afterRows.length, 0)} 行`)
  }
  if (input.state.backupId) {
    parts.push(`完整备份 ${input.state.backupId}${input.verified ? '（已校验）' : '（未校验！）'}`)
  }
  if (input.state.schemaBefore) parts.push('含执行前后 Schema 快照（DDL 不可事务回滚）')
  if (input.state.partial) parts.push('捕获不完整，撤销可能不完整（partial）')
  if (input.result.transaction === 'implicit_ddl') parts.push('包含 DDL 隐式提交')
  if (input.result.transaction === 'rolled_back') parts.push('事务已回滚，数据未被本次语句修改')
  if (!input.result.ok && input.result.error) parts.push(`执行错误：${input.result.error.message}`)
  return parts.join('；')
}

function sanitizeSegment(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'database'
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}
