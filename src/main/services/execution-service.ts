import type {
  AuditActor,
  ExecutionResult,
  HistoryEntry,
  HistoryQuery,
  Id,
  PageResult,
  QueryColumn,
  RecoveryPlanSummary,
  SqlAnalysis,
  SqlExecuteRequest,
  SqlPlan,
  SqlPlanRequest,
  StatementExecution
} from '@shared/types'
import type {
  ApprovalRecord,
  ExecutorResult,
  HistoryTrigger,
  ProtectionContext,
  Services,
  SqlExecutionService,
  WriteProtection
} from '@main/service-contracts'
import { AppError, isAppError, toAppError } from '@main/util/errors'
import { newId, sha256Hex } from '@main/util/id'
import { addMs, isExpired, nowIso } from '@main/util/time'

const PLAN_TTL_MS = 15 * 60 * 1000
const APPROVAL_TTL_MS = 30 * 60 * 1000

interface StoredPlan {
  plan: SqlPlan
  trigger: HistoryTrigger
  approvalId: Id | null
}

function actorOf(trigger: HistoryTrigger): AuditActor {
  return trigger === 'agent' ? 'agent' : trigger === 'system' ? 'system' : 'user'
}

function uniqueTables(analysis: SqlAnalysis): string[] {
  const set = new Set<string>()
  for (const st of analysis.statements) {
    for (const t of st.targetTables) set.add(t)
  }
  return [...set]
}

function primaryKind(analysis: SqlAnalysis): HistoryEntry['kind'] {
  const first = analysis.statements.find((s) => s.category !== 'read') ?? analysis.statements[0]
  return first?.kind ?? 'unknown'
}

/**
 * Orchestrates the mandatory staged flow:
 *   understand -> classify -> plan (impact + recovery plan) -> user approval
 *   -> write protection -> execute -> verify -> audit/history -> memory revalidation.
 *
 * The renderer can never execute SQL directly; it only submits a plan request
 * and later references a plan id (single use, short TTL).
 */
export class DefaultSqlExecutionService implements SqlExecutionService {
  private readonly plans = new Map<Id, StoredPlan>()
  private readonly cancellers = new Map<Id, { controller: AbortController; planId: Id }>()
  private readonly byPlan = new Map<Id, Id>()

  constructor(private readonly getServices: () => Services) {}

  /* ---------------------------- planning --------------------------- */

  async plan(req: SqlPlanRequest, trigger: HistoryTrigger): Promise<SqlPlan> {
    const s = this.getServices()
    const sql = (req.sql ?? '').trim()
    if (!sql) throw new AppError('VALIDATION', 'SQL 不能为空')
    if (sql.length > 500_000) throw new AppError('VALIDATION', 'SQL 过大')

    const settings = s.settings.get()
    const analysis = s.classifier.classify(sql)
    if (analysis.statements.length === 0) throw new AppError('VALIDATION', '未解析到可执行语句')

    const session = await s.connections.openSession(req.connectionId, req.database)
    const database = req.database?.trim() || session.database
    if (!database) throw new AppError('VALIDATION', '未指定数据库')

    const recoveryPlan = await s.recovery.buildPlan({
      connectionId: req.connectionId,
      projectId: req.projectId ?? null,
      database,
      sql,
      analysis,
      session,
      settings
    })

    // Row impact estimates are advisory; a null result is shown as "未知".
    let estimatedRows: number | null = null
    for (const st of analysis.statements) {
      if (st.category === 'read' && st.kind !== 'select') continue
      try {
        const est = await s.executor.estimateRows(session, st.sql)
        if (est !== null) estimatedRows = (estimatedRows ?? 0) + est
      } catch {
        /* estimation is best-effort, never blocks planning */
      }
    }

    const planId = newId('plan')
    const createdAt = nowIso()
    const expiresAt = addMs(PLAN_TTL_MS)
    const requiresApproval = !analysis.readOnly
    const planHash = sha256Hex(
      JSON.stringify({
        connectionId: req.connectionId,
        database,
        sql,
        risk: analysis.overallRisk,
        strategy: recoveryPlan.strategy,
        trigger
      })
    )

    const plan: SqlPlan = {
      planId,
      planHash,
      connectionId: req.connectionId,
      projectId: req.projectId ?? null,
      database,
      sql,
      analysis,
      recoveryPlan,
      impact: {
        statementCount: analysis.statements.length,
        affectedTables: uniqueTables(analysis),
        estimatedRows,
        risk: analysis.overallRisk
      },
      requiresApproval,
      requiresBackup: recoveryPlan.needsBackup || analysis.requiresBackup,
      createdAt,
      expiresAt
    }

    let approvalId: Id | null = null
    if (requiresApproval) {
      const approval = s.store.insertApproval({
        id: newId('apv'),
        taskId: null,
        planId,
        kind: 'execute_sql',
        summary: this.buildApprovalSummary(analysis, database, estimatedRows, recoveryPlan),
        sql,
        targets: plan.impact.affectedTables,
        risk: analysis.overallRisk,
        impact: this.describeImpact(analysis, estimatedRows),
        recoveryPlan,
        createdAt,
        expiresAt: addMs(APPROVAL_TTL_MS),
        status: 'pending',
        planHash,
        trigger
      })
      approvalId = approval.id
    }

    this.plans.set(planId, { plan, trigger, approvalId })
    this.pruneExpired()

    s.audit.record({
      actor: actorOf(trigger),
      action: 'sql.plan',
      projectId: plan.projectId,
      connectionId: plan.connectionId,
      target: database,
      risk: analysis.overallRisk,
      sqlPreview: sql,
      outcome: 'info',
      detail: recoveryPlan.reason,
      metadata: {
        planId,
        approvalId,
        requiresApproval,
        requiresBackup: plan.requiresBackup,
        estimatedRows
      }
    })

    return plan
  }

  /* ---------------------------- execution -------------------------- */

  async execute(req: SqlExecuteRequest, trigger: HistoryTrigger): Promise<ExecutionResult> {
    const s = this.getServices()
    const stored = this.plans.get(req.planId)
    if (!stored) {
      throw new AppError('APPROVAL_EXPIRED', '执行计划不存在或已被使用，请重新预览后再执行')
    }
    if (isExpired(stored.plan.expiresAt)) {
      this.plans.delete(req.planId)
      throw new AppError('APPROVAL_EXPIRED', '执行计划已过期，请重新预览')
    }
    if (!req.confirmed) {
      throw new AppError('VALIDATION', '必须显式确认后才可执行')
    }

    const plan = stored.plan
    const settings = s.settings.get()

    // Approval is enforced by the trusted layer, never by the renderer.
    if (plan.requiresApproval) {
      const approval = s.store.getApprovalByPlan(plan.planId)
      if (!approval) throw new AppError('APPROVAL_REQUIRED', '该操作需要用户授权，请先确认执行计划')
      if (approval.status === 'denied') throw new AppError('APPROVAL_DENIED', '该操作已被拒绝')
      if (approval.status !== 'approved') throw new AppError('APPROVAL_REQUIRED', '该操作尚未获得授权')
      if (isExpired(approval.expiresAt)) {
        s.store.resolveApproval(approval.id, 'expired')
        throw new AppError('APPROVAL_EXPIRED', '授权已过期，请重新走一次预览与确认')
      }
      if (approval.planHash !== plan.planHash) {
        throw new AppError('APPROVAL_EXPIRED', '授权内容与当前计划不一致（可能被篡改），已拒绝执行')
      }
    }

    // Single use: a plan can never be replayed (double submit protection).
    this.plans.delete(plan.planId)

    const executionId = newId('exec')
    const controller = new AbortController()
    this.cancellers.set(executionId, { controller, planId: plan.planId })
    this.byPlan.set(plan.planId, executionId)

    const startedAt = nowIso()
    const history = s.store.insertHistory({
      id: newId('hist'),
      projectId: plan.projectId,
      connectionId: plan.connectionId,
      database: plan.database,
      sql: plan.sql,
      kind: primaryKind(plan.analysis),
      risk: plan.analysis.overallRisk,
      status: 'running',
      rowCount: 0,
      affectedRows: 0,
      durationMs: 0,
      executedAt: startedAt,
      recoveryPointId: null,
      backupId: null,
      trigger,
      error: undefined
    })

    const emitProgress = (p: { phase: string; message: string; progress: number }): void => {
      s.events.emit('job.event', {
        jobId: executionId,
        kind: 'backup',
        status: 'running',
        phase: p.phase,
        message: p.message,
        progress: p.progress,
        at: nowIso()
      })
    }

    let protection: WriteProtection | undefined
    let protectionContext: ProtectionContext | undefined
    try {
      const session = await s.connections.openSession(plan.connectionId, plan.database)
      if (!plan.analysis.readOnly) {
        if (!settings.autoProtection) {
          s.logger.warn('auto protection disabled by settings; time-machine still enforces risk strategy')
        }
        protection = s.recovery.createProtection({
          connectionId: plan.connectionId,
          projectId: plan.projectId,
          database: plan.database,
          executionId,
          planId: plan.planId,
          sql: plan.sql,
          analysis: plan.analysis,
          trigger,
          recoveryPlan: plan.recoveryPlan,
          settings,
          emitProgress,
          signal: controller.signal
        })
        protectionContext = {
          session,
          database: plan.database,
          executionId,
          planId: plan.planId,
          projectId: plan.projectId,
          connectionId: plan.connectionId,
          sql: plan.sql,
          analysis: plan.analysis,
          trigger,
          recoveryPlan: plan.recoveryPlan,
          settings,
          emitProgress,
          signal: controller.signal
        }
      }

      const outcome: ExecutorResult = await s.executor.execute(
        session,
        {
          sql: plan.sql,
          analysis: plan.analysis,
          database: plan.database,
          trigger,
          maxRows: req.maxRows ?? settings.maxResultRows,
          timeoutMs: settings.sqlTimeoutMs
        },
        {
          protection,
          protectionContext,
          signal: controller.signal,
          onStatement: (statement) => {
            s.events.emit('job.event', {
              jobId: executionId,
              kind: 'agent',
              status: 'running',
              phase: 'statement',
              message: `语句 ${statement.statementIndex + 1} 完成（影响 ${statement.affectedRows} 行）`,
              progress: (statement.statementIndex + 1) / Math.max(1, plan.analysis.statements.length),
              at: nowIso()
            })
          }
        }
      )

      const finishedAt = nowIso()
      const ok = outcome.ok
      const status: HistoryEntry['status'] = ok ? 'success' : controller.signal.aborted ? 'cancelled' : 'failed'
      const affected = outcome.statements.reduce((n, st) => n + st.affectedRows, 0)
      const rowCount = outcome.result?.rowCount ?? 0
      const recoveryPointId = outcome.protection?.recoveryPointId ?? null
      const backupId = outcome.protection?.backupId ?? null

      if (status === 'cancelled') {
        this.markCancelledStatements(outcome.statements)
      }

      const auditEvent = s.audit.record({
        actor: actorOf(trigger),
        action: 'sql.execute',
        projectId: plan.projectId,
        connectionId: plan.connectionId,
        target: plan.database,
        risk: plan.analysis.overallRisk,
        sqlPreview: plan.sql,
        outcome: ok ? 'success' : 'failure',
        detail: outcome.error?.message ?? (ok ? '执行成功' : '执行失败'),
        metadata: {
          executionId,
          planId: plan.planId,
          transaction: outcome.transaction,
          affectedRows: affected,
          rowCount,
          recoveryPointId,
          backupId,
          durationMs: outcome.durationMs,
          warnings: outcome.warnings
        }
      })

      s.store.updateHistory(history.id, {
        status,
        rowCount,
        affectedRows: affected,
        durationMs: outcome.durationMs,
        executedAt: finishedAt,
        recoveryPointId,
        backupId,
        auditEventId: auditEvent.id,
        error: outcome.error?.message
      })

      s.events.emit('job.event', {
        jobId: executionId,
        kind: 'agent',
        status: ok ? 'completed' : 'failed',
        phase: 'done',
        message: ok ? '执行完成' : '执行失败',
        progress: 1,
        at: finishedAt,
        error: outcome.error?.message
      })

      // Schema changed? Re-validate project memories asynchronously (never blocks
      // the response, never silently ignored: failures are logged).
      if (plan.projectId && plan.analysis.statements.some((st) => st.category === 'ddl')) {
        void s.schema
          .detectChanges(s, plan.projectId)
          .catch((e: unknown) =>
            s.logger.warn('schema change detection after DDL failed', {
              error: e instanceof Error ? e.message : String(e)
            })
          )
      }

      const result: ExecutionResult = {
        executionId,
        planId: plan.planId,
        ok,
        statements: outcome.statements,
        result: outcome.result,
        error: outcome.error ? { code: outcome.error.code, message: outcome.error.message } : undefined,
        durationMs: outcome.durationMs,
        recoveryPointId,
        backupId,
        auditEventId: auditEvent.id,
        warning: outcome.warnings.length > 0 ? outcome.warnings.join('; ') : undefined,
        startedAt,
        finishedAt
      }
      return result
    } catch (e) {
      const err = toAppError(e, 'QUERY_FAILED')
      const finishedAt = nowIso()
      s.store.updateHistory(history.id, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        executedAt: finishedAt,
        error: err.message
      })
      s.audit.record({
        actor: actorOf(trigger),
        action: 'sql.execute',
        projectId: plan.projectId,
        connectionId: plan.connectionId,
        target: plan.database,
        risk: plan.analysis.overallRisk,
        sqlPreview: plan.sql,
        outcome: err.code === 'PROTECTION_FAILED' || err.code === 'BACKUP_FAILED' ? 'denied' : 'failure',
        detail: err.message,
        metadata: { executionId, planId: plan.planId, code: err.code }
      })
      s.events.emit('job.event', {
        jobId: executionId,
        kind: 'agent',
        status: 'failed',
        phase: 'error',
        message: err.message,
        progress: 1,
        at: finishedAt,
        error: err.message
      })
      throw isAppError(e) ? e : err
    } finally {
      this.cancellers.delete(executionId)
      this.byPlan.delete(plan.planId)
    }
  }

  cancel(planId?: Id): { cancelled: boolean } {
    let cancelled = false
    for (const [executionId, entry] of this.cancellers) {
      if (planId && entry.planId !== planId) continue
      entry.controller.abort(new AppError('CANCELLED', '用户取消执行'))
      this.cancellers.delete(executionId)
      cancelled = true
    }
    if (planId) this.plans.delete(planId)
    return { cancelled }
  }

  /* ------------------------- plans / approval ---------------------- */

  getPlan(planId: Id): SqlPlan | null {
    const stored = this.plans.get(planId)
    if (!stored) return null
    if (isExpired(stored.plan.expiresAt)) {
      this.plans.delete(planId)
      return null
    }
    return stored.plan
  }

  activatePlan(planId: Id): void {
    const stored = this.plans.get(planId)
    if (!stored) return
    stored.plan = { ...stored.plan, expiresAt: addMs(PLAN_TTL_MS) }
  }

  getApprovalForPlan(planId: Id): ApprovalRecord | null {
    return this.getServices().store.getApprovalByPlan(planId)
  }

  approve(planId: Id, comment?: string): ApprovalRecord {
    const s = this.getServices()
    const approval = s.store.getApprovalByPlan(planId)
    if (!approval) throw new AppError('NOT_FOUND', '未找到该计划的授权请求')
    if (approval.status === 'approved') {
      this.activatePlan(planId)
      return approval
    }
    if (approval.status !== 'pending') {
      throw new AppError('VALIDATION', `授权请求状态为 ${approval.status}，无法批准`)
    }
    if (isExpired(approval.expiresAt)) {
      s.store.resolveApproval(approval.id, 'expired')
      throw new AppError('APPROVAL_EXPIRED', '授权请求已过期，请重新预览')
    }
    const updated = s.store.resolveApproval(approval.id, 'approved', comment)
    if (!updated) throw new AppError('INTERNAL', '授权状态写入失败')
    this.activatePlan(planId)
    s.audit.record({
      actor: 'user',
      action: 'approval.grant',
      projectId: this.plans.get(planId)?.plan.projectId ?? null,
      connectionId: this.plans.get(planId)?.plan.connectionId ?? null,
      target: this.plans.get(planId)?.plan.database ?? null,
      risk: approval.risk,
      sqlPreview: approval.sql,
      outcome: 'info',
      detail: comment ? `用户批准：${comment}` : '用户批准执行',
      metadata: { planId, approvalId: approval.id }
    })
    return updated
  }

  deny(planId: Id, comment?: string): ApprovalRecord {
    const s = this.getServices()
    const approval = s.store.getApprovalByPlan(planId)
    if (!approval) throw new AppError('NOT_FOUND', '未找到该计划的授权请求')
    const updated = s.store.resolveApproval(approval.id, 'denied', comment)
    if (!updated) throw new AppError('INTERNAL', '授权状态写入失败')
    this.plans.delete(planId)
    s.audit.record({
      actor: 'user',
      action: 'approval.deny',
      projectId: null,
      connectionId: null,
      target: null,
      risk: approval.risk,
      sqlPreview: approval.sql,
      outcome: 'denied',
      detail: comment ? `用户拒绝：${comment}` : '用户拒绝执行',
      metadata: { planId, approvalId: approval.id }
    })
    return updated
  }

  listPendingApprovals(projectId?: Id): ApprovalRecord[] {
    const s = this.getServices()
    s.store.expireStaleApprovals(nowIso())
    const list = s.store.listApprovals({ status: 'pending', limit: 100 })
    if (!projectId) return list
    return list.filter((a) => {
      const stored = this.plans.get(a.planId)
      if (!stored) return false
      return stored.plan.projectId === projectId
    })
  }

  /* --------------------------- read-only path ---------------------- */

  async runReadonlyQuery(
    input: { connectionId: Id; database?: string; projectId?: Id | null; sql: string; maxRows?: number },
    trigger: HistoryTrigger
  ): Promise<ExecutionResult> {
    const s = this.getServices()
    const sql = (input.sql ?? '').trim()
    if (!sql) throw new AppError('VALIDATION', 'SQL 不能为空')
    const analysis = s.classifier.classify(sql)
    if (!analysis.readOnly) {
      throw new AppError(
        'UNSAFE_OPERATION',
        '只读通道拒绝执行写语句；写操作必须走"预览→授权→执行"流程',
        { details: { risk: analysis.overallRisk } }
      )
    }
    const settings = s.settings.get()
    const session = await s.connections.openSession(input.connectionId, input.database)
    const executionId = newId('exec')
    const controller = new AbortController()
    const startedAt = nowIso()
    const history = s.store.insertHistory({
      id: newId('hist'),
      projectId: input.projectId ?? null,
      connectionId: input.connectionId,
      database: session.database,
      sql,
      kind: primaryKind(analysis),
      risk: analysis.overallRisk,
      status: 'running',
      rowCount: 0,
      affectedRows: 0,
      durationMs: 0,
      executedAt: startedAt,
      recoveryPointId: null,
      backupId: null,
      trigger,
      error: undefined
    })
    try {
      const outcome = await s.executor.execute(
        session,
        {
          sql,
          analysis,
          database: session.database,
          trigger,
          maxRows: input.maxRows ?? settings.maxResultRows,
          timeoutMs: settings.sqlTimeoutMs
        },
        { signal: controller.signal }
      )
      const finishedAt = nowIso()
      const auditEvent = s.audit.record({
        actor: actorOf(trigger),
        action: 'sql.readonly',
        projectId: input.projectId ?? null,
        connectionId: input.connectionId,
        target: session.database,
        risk: analysis.overallRisk,
        sqlPreview: sql,
        outcome: outcome.ok ? 'success' : 'failure',
        detail: outcome.error?.message ?? '只读查询完成',
        metadata: { executionId, rowCount: outcome.result?.rowCount ?? 0, transaction: outcome.transaction }
      })
      s.store.updateHistory(history.id, {
        status: outcome.ok ? 'success' : 'failed',
        rowCount: outcome.result?.rowCount ?? 0,
        durationMs: outcome.durationMs,
        executedAt: finishedAt,
        auditEventId: auditEvent.id,
        error: outcome.error?.message
      })
      return {
        executionId,
        planId: '',
        ok: outcome.ok,
        statements: outcome.statements,
        result: outcome.result,
        error: outcome.error ? { code: outcome.error.code, message: outcome.error.message } : undefined,
        durationMs: outcome.durationMs,
        recoveryPointId: null,
        backupId: null,
        auditEventId: auditEvent.id,
        warning: outcome.warnings.length > 0 ? outcome.warnings.join('; ') : undefined,
        startedAt,
        finishedAt
      }
    } catch (e) {
      const err = toAppError(e, 'QUERY_FAILED')
      s.store.updateHistory(history.id, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        executedAt: nowIso(),
        error: err.message
      })
      throw err
    }
  }

  /* ------------------------------ misc ----------------------------- */

  async classify(sql: string): Promise<SqlAnalysis> {
    return this.getServices().classifier.classify(sql)
  }

  async explain(connectionId: Id, sql: string, database?: string): Promise<{ columns: QueryColumn[]; rows: unknown[][] }> {
    const s = this.getServices()
    const session = await s.connections.openSession(connectionId, database)
    return s.executor.explain(session, sql, database)
  }

  listHistory(q: HistoryQuery): PageResult<HistoryEntry> {
    return this.getServices().store.listHistory(q)
  }

  getHistory(id: Id): HistoryEntry | null {
    return this.getServices().store.getHistory(id)
  }

  /* ---------------------------- internals -------------------------- */

  private pruneExpired(): void {
    const now = new Date()
    for (const [id, stored] of this.plans) {
      if (isExpired(stored.plan.expiresAt, now)) this.plans.delete(id)
    }
  }

  private markCancelledStatements(statements: StatementExecution[]): void {
    for (const st of statements) {
      if (!st.ok && !st.error) {
        st.error = { code: 'CANCELLED', message: '用户取消' }
      }
    }
  }

  private buildApprovalSummary(
    analysis: SqlAnalysis,
    database: string,
    estimatedRows: number | null,
    recoveryPlan: RecoveryPlanSummary
  ): string {
    const kinds = [...new Set(analysis.statements.map((x) => x.kind))].join('/')
    const rows = estimatedRows === null ? '未知' : `约 ${estimatedRows} 行`
    return `[${database}] ${kinds} 操作，风险 ${analysis.overallRisk}，预计影响 ${rows}；恢复策略：${recoveryPlan.strategy}${recoveryPlan.needsBackup ? '（执行前需完整备份）' : ''}`
  }

  private describeImpact(analysis: SqlAnalysis, estimatedRows: number | null): string {
    const tables = uniqueTables(analysis)
    const rows = estimatedRows === null ? '影响行数未知' : `预计影响 ${estimatedRows} 行`
    return `目标对象：${tables.length > 0 ? tables.join(', ') : '（未识别）'}；${rows}；语句数 ${analysis.statements.length}`
  }
}
