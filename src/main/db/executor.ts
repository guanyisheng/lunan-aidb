/**
 * AIDB Studio - trusted SQL executor.
 *
 * Transaction boundaries (also surfaced to the user as result warnings):
 *  - Pure read scripts run in autocommit mode; nothing is written.
 *  - Pure DML (INSERT/REPLACE/UPDATE/DELETE) runs inside ONE explicit
 *    transaction: protection.prepare (outside the transaction), BEGIN,
 *    captureBefore → statement → captureAfter per write, then COMMIT. Any
 *    failure ROLLBACKs and calls protection.abort. InnoDB data changes are
 *    rolled back, but trigger/UDF side effects that leave the database (files,
 *    external services, messages) are NOT covered by the transaction.
 *  - Scripts containing DDL or statements with implicit commit (ALTER, CREATE,
 *    RENAME, DROP, TRUNCATE, CALL, LOAD, GRANT, unknown statements) are NOT run
 *    inside a transaction. `protection.prepare` must succeed before the first
 *    statement; if it fails nothing is executed. Statements run one by one and a
 *    failure stops execution with `transaction: 'partial'` — we never claim DDL
 *    was rolled back.
 *  - `protection.prepare` failures throw `AppError('PROTECTION_FAILED')` so the
 *    execution service records a failed history entry; all other failures are
 *    returned as `ExecutorResult{ ok:false }` with the completed statements
 *    preserved.
 *  - Execution and protection always use the SAME analysis: if the caller's
 *    analysis disagrees with the splitter, the executor re-classifies, warns and
 *    injects that analysis into the protection context.
 */
import type {
  CapturedBefore,
  DbSession,
  ExecutorHooks,
  ExecutorInput,
  ExecutorResult,
  ExecutorTransactionOutcome,
  ProtectionPreparation,
  ProtectionResult,
  QueryHandle,
  Services,
  SqlExecutor,
  WriteProtection
} from '../service-contracts'
import type {
  AppErrorPayload,
  QueryColumn,
  QueryResultPage,
  SqlAnalysis,
  SqlStatementKind,
  StatementExecution,
  StatementRisk
} from '@shared/types'
import { AppError, isAppError } from '../util/errors'
import {
  clamp,
  mapDbError,
  resolveServices,
  throwIfAborted,
  type ServicesSource
} from './internal'

const DML_KINDS: ReadonlySet<SqlStatementKind> = new Set(['insert', 'replace', 'update', 'delete'])
const READ_KINDS: ReadonlySet<SqlStatementKind> = new Set(['select', 'show', 'explain'])

function isDml(kind: SqlStatementKind): boolean {
  return DML_KINDS.has(kind)
}

function isRead(kind: SqlStatementKind): boolean {
  return READ_KINDS.has(kind)
}

function isWriteKind(kind: SqlStatementKind): boolean {
  return (
    DML_KINDS.has(kind) ||
    kind === 'create' ||
    kind === 'alter' ||
    kind === 'drop' ||
    kind === 'truncate' ||
    kind === 'rename' ||
    kind === 'procedure' ||
    kind === 'load' ||
    kind === 'grant' ||
    kind === 'unknown'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface SyntheticUse {
  synthetic: 'use'
}

interface ExecutionState {
  statements: StatementExecution[]
  warnings: string[]
  lastResult?: QueryResultPage
  protectionResult?: ProtectionResult
}

export class MySqlSqlExecutor implements SqlExecutor {
  private readonly servicesSource: ServicesSource

  constructor(services: ServicesSource) {
    this.servicesSource = services
  }

  private get services(): Services {
    return resolveServices(this.servicesSource)
  }

  private get logger(): Services['logger'] {
    return this.services.logger.child('db.executor')
  }

  /* ------------------------------ execute ------------------------------ */

  async execute(
    session: DbSession,
    input: ExecutorInput,
    hooks: ExecutorHooks = {}
  ): Promise<ExecutorResult> {
    const startedAt = Date.now()
    this.validateInput(input)
    const state: ExecutionState = { statements: [], warnings: [] }
    const analysis = this.effectiveAnalysis(input, state.warnings)
    const protection = hooks.protection ?? null
    const protectionContext = this.effectiveProtectionContext(hooks, analysis, input)

    const effectiveWriteStatements = analysis.statements.filter(
      (statement) =>
        isDml(statement.kind) ||
        statement.category === 'ddl' ||
        statement.category === 'destructive' ||
        (statement.category === 'complex' &&
          (statement.kind === 'procedure' || statement.kind === 'load' || statement.kind === 'grant'))
    )
    const hasWrite = effectiveWriteStatements.length > 0
    const hasTxnControl = analysis.statements.some((statement) => statement.kind === 'transaction')
    const maxRows = clamp(input.maxRows, 1, 100_000)

    // Switching database before any statement keeps session context consistent.
    if (input.database && session.database !== input.database) {
      await session.setDatabase(input.database)
    }

    // The executor owns transaction boundaries; manual BEGIN/COMMIT mixed with
    // writes would bypass both transaction and recovery-point guarantees.
    if (hasTxnControl && hasWrite) {
      const error = new AppError(
        'UNSAFE_OPERATION',
        'SQL 脚本同时包含手动事务控制（BEGIN/COMMIT/ROLLBACK）与写操作，执行器无法可靠保证事务边界与恢复点，已拒绝执行。',
        { hint: '请移除脚本中的事务控制语句，由执行器统一管理事务。' }
      )
      return this.buildResult(false, state, 'none', startedAt, error)
    }

    const mode: 'read' | 'dml' | 'ddl' = !hasWrite
      ? 'read'
      : effectiveWriteStatements.every((statement) => isDml(statement.kind))
        ? 'dml'
        : 'ddl'

    if (mode === 'dml') {
      state.warnings.push(
        'DML 在单个事务内执行：任一步失败将回滚数据变更；触发器/UDF 的外部副作用（写文件、调用外部服务等）不受事务保护。'
      )
    } else if (mode === 'ddl') {
      state.warnings.push(
        '脚本包含 DDL/隐式提交语句，执行器未开启事务；已执行的语句无法通过回滚撤销，失败时只报告实际完成情况。'
      )
    }
    if (hasTxnControl) {
      state.warnings.push('脚本包含手动事务控制语句，执行器未额外开启事务。')
    }

    // Protection pre-flight: runs before BEGIN / before the first statement.
    let preparation: ProtectionPreparation | null = null
    if (hasWrite) {
      if (!protection || !protectionContext) {
        if (analysis.requiresBackup) {
          throw new AppError(
            'PROTECTION_FAILED',
            '高风险操作缺少写入保护（备份/恢复点）实现，已拒绝执行。',
            { hint: '请确认写保护服务已启用，或先在时间机器中创建经过验证的备份。' }
          )
        }
        state.warnings.push('本次执行未提供写入保护实现：不会创建恢复点，请谨慎操作。')
      } else {
        try {
          preparation = await protection.prepare(protectionContext)
        } catch (error) {
          const mapped = isAppError(error) ? error : mapDbError(error, '写保护准备失败')
          await this.safeAbort(protection, protectionContext, null, mapped, state.warnings)
          throw new AppError('PROTECTION_FAILED', `写保护准备失败，已拒绝执行：${mapped.message}`, {
            details: { causeCode: mapped.code },
            hint: '高风险操作必须成功创建经过验证的备份后才能执行。请检查备份工具、磁盘空间与权限后重试。',
            cause: error
          })
        }
      }
    }

    if (mode === 'read') {
      return this.executeReadMode(session, input, analysis, hooks, maxRows, startedAt, state)
    }
    if (mode === 'dml') {
      if (!protection || !protectionContext) {
        return this.executeDmlMode(session, input, analysis, hooks, maxRows, startedAt, state, null, null, null)
      }
      return this.executeDmlMode(
        session,
        input,
        analysis,
        hooks,
        maxRows,
        startedAt,
        state,
        protection,
        protectionContext,
        preparation
      )
    }
    return this.executeDdlMode(
      session,
      input,
      analysis,
      hooks,
      maxRows,
      startedAt,
      state,
      protection,
      protectionContext,
      preparation
    )
  }

  /* ---------------------------- read script ---------------------------- */

  private async executeReadMode(
    session: DbSession,
    input: ExecutorInput,
    analysis: SqlAnalysis,
    hooks: ExecutorHooks,
    maxRows: number,
    startedAt: number,
    state: ExecutionState
  ): Promise<ExecutorResult> {
    for (const statement of analysis.statements) {
      const statementStartedAt = Date.now()
      try {
        throwIfAborted(hooks.signal, `第 ${statement.statementIndex + 1} 条语句执行前已取消`)
        const handle = await this.runStatement(session, statement, input, hooks.signal)
        const execution = this.toExecution(statement, handle, statementStartedAt)
        state.statements.push(execution)
        hooks.onStatement?.(execution, statement.statementIndex)
        if (isRead(statement.kind)) state.lastResult = this.toResultPage(handle, maxRows)
      } catch (error) {
        const mapped = this.mapStatementError(error)
        const execution = this.failedExecution(statement, mapped, statementStartedAt)
        state.statements.push(execution)
        hooks.onStatement?.(execution, statement.statementIndex)
        return this.buildResult(false, state, 'none', startedAt, mapped)
      }
    }
    return this.buildResult(true, state, 'none', startedAt, undefined)
  }

  /* ----------------------------- DML script ---------------------------- */

  private async executeDmlMode(
    session: DbSession,
    input: ExecutorInput,
    analysis: SqlAnalysis,
    hooks: ExecutorHooks,
    maxRows: number,
    startedAt: number,
    state: ExecutionState,
    protection: WriteProtection | null,
    protectionContext: ExecutorHooks['protectionContext'] | null,
    preparation: ProtectionPreparation | null
  ): Promise<ExecutorResult> {
    let activeStatement: StatementRisk | null = null
    let rollbackSucceeded = false
    let transactionStarted = false

    try {
      await session.beginTransaction()
      transactionStarted = true
      for (const statement of analysis.statements) {
        activeStatement = statement
        throwIfAborted(hooks.signal, `第 ${statement.statementIndex + 1} 条语句执行前已取消`)
        const statementStartedAt = Date.now()

        let captured: CapturedBefore | null = null
        if (protection && protectionContext && preparation && isDml(statement.kind)) {
          captured = await protection.captureBefore(protectionContext, preparation, statement)
        }

        const handle = await this.runStatement(session, statement, input, hooks.signal)
        const execution = this.toExecution(statement, handle, statementStartedAt)

        if (protection && protectionContext && preparation && captured && isDml(statement.kind)) {
          await protection.captureAfter(protectionContext, preparation, captured, execution)
        }

        state.statements.push(execution)
        hooks.onStatement?.(execution, statement.statementIndex)
        if (isRead(statement.kind)) state.lastResult = this.toResultPage(handle, maxRows)
        activeStatement = null
      }

      await session.commit()
      activeStatement = null
    } catch (error) {
      const mapped = this.mapStatementError(error)
      if (
        activeStatement &&
        !state.statements.some((s) => s.statementIndex === activeStatement?.statementIndex)
      ) {
        const execution = this.failedExecution(activeStatement, mapped, Date.now())
        state.statements.push(execution)
        hooks.onStatement?.(execution, activeStatement.statementIndex)
      }

      if (transactionStarted && session.inTransaction()) {
        try {
          await session.rollback()
          rollbackSucceeded = true
        } catch (rollbackError) {
          state.warnings.push(
            `回滚失败：${errorMessage(rollbackError)}。数据库可能处于未确定状态，请人工核对。`
          )
        }
      } else if (transactionStarted) {
        state.warnings.push('事务连接已断开或已被取消，无法确认回滚结果，请人工核对数据状态。')
      }

      if (protection && protectionContext && preparation) {
        await this.safeAbort(protection, protectionContext, preparation, mapped, state.warnings)
      }
      const transaction: ExecutorTransactionOutcome = rollbackSucceeded ? 'rolled_back' : 'partial'
      return this.buildResult(false, state, transaction, startedAt, mapped)
    }

    if (protection && protectionContext && preparation) {
      try {
        state.protectionResult = await protection.finalize(protectionContext, preparation, {
          ok: true,
          transaction: 'committed',
          statements: state.statements
        })
      } catch (finalizeError) {
        state.warnings.push(
          `数据已提交，但恢复点持久化失败：${errorMessage(finalizeError)}。恢复点可能不可用，请人工核对。`
        )
        return this.buildResult(
          false,
          state,
          'committed',
          startedAt,
          new AppError('PROTECTION_FAILED', `数据已提交，但恢复点持久化失败：${errorMessage(finalizeError)}`, {
            hint: '数据变更已经生效，无法回滚；请人工确认恢复点状态。'
          })
        )
      }
      this.backfillRecoveryPoint(state.statements, state.protectionResult.recoveryPointId)
    }

    return this.buildResult(true, state, 'committed', startedAt, undefined)
  }

  /* ----------------------------- DDL script ---------------------------- */

  private async executeDdlMode(
    session: DbSession,
    input: ExecutorInput,
    analysis: SqlAnalysis,
    hooks: ExecutorHooks,
    maxRows: number,
    startedAt: number,
    state: ExecutionState,
    protection: WriteProtection | null,
    protectionContext: ExecutorHooks['protectionContext'] | null,
    preparation: ProtectionPreparation | null
  ): Promise<ExecutorResult> {
    for (const statement of analysis.statements) {
      const statementStartedAt = Date.now()
      try {
        throwIfAborted(hooks.signal, `第 ${statement.statementIndex + 1} 条语句执行前已取消`)
        const handle = await this.runStatement(session, statement, input, hooks.signal)
        const execution = this.toExecution(statement, handle, statementStartedAt)
        state.statements.push(execution)
        hooks.onStatement?.(execution, statement.statementIndex)
        if (isRead(statement.kind)) state.lastResult = this.toResultPage(handle, maxRows)
      } catch (error) {
        const mapped = this.mapStatementError(error)
        const execution = this.failedExecution(statement, mapped, statementStartedAt)
        state.statements.push(execution)
        hooks.onStatement?.(execution, statement.statementIndex)
        if (protection && protectionContext && preparation) {
          await this.safeAbort(protection, protectionContext, preparation, mapped, state.warnings)
        }
        const transaction: ExecutorTransactionOutcome = state.statements.some((completed) => completed.ok)
          ? 'partial'
          : 'none'
        return this.buildResult(false, state, transaction, startedAt, mapped)
      }
    }

    if (protection && protectionContext && preparation) {
      try {
        state.protectionResult = await protection.finalize(protectionContext, preparation, {
          ok: true,
          transaction: 'implicit_ddl',
          statements: state.statements
        })
        this.backfillRecoveryPoint(state.statements, state.protectionResult.recoveryPointId)
      } catch (finalizeError) {
        state.warnings.push(
          `DDL 已执行完成，但恢复点持久化失败：${errorMessage(finalizeError)}。请人工核对恢复点状态。`
        )
        return this.buildResult(
          false,
          state,
          'implicit_ddl',
          startedAt,
          new AppError(
            'PROTECTION_FAILED',
            `DDL 已执行，但恢复点持久化失败：${errorMessage(finalizeError)}`
          )
        )
      }
    }

    return this.buildResult(true, state, 'implicit_ddl', startedAt, undefined)
  }

  /* ---------------------------- EXPLAIN APIs --------------------------- */

  async explain(
    session: DbSession,
    sql: string,
    database?: string
  ): Promise<{ columns: QueryColumn[]; rows: unknown[][] }> {
    const trimmed = (sql ?? '').trim()
    if (trimmed.length === 0) throw new AppError('VALIDATION', 'EXPLAIN 需要一条 SQL 语句')
    if (database && database !== session.database) {
      await session.setDatabase(database)
    }
    const parts = this.services.classifier.splitStatements(trimmed)
    if (parts.length !== 1) {
      throw new AppError('VALIDATION', 'EXPLAIN 只接受单条 SQL 语句')
    }
    const risk = this.services.classifier.classifyStatement(parts[0], 0)
    if (!['select', 'insert', 'replace', 'update', 'delete'].includes(risk.kind)) {
      throw new AppError('VALIDATION', `不支持对 ${risk.kind} 语句执行 EXPLAIN`)
    }
    const handle = await session.query(`EXPLAIN ${parts[0]}`, {
      maxRows: 1000,
      timeoutMs: this.defaultTimeoutMs()
    })
    return { columns: handle.columns, rows: handle.rows }
  }

  async estimateRows(session: DbSession, sql: string): Promise<number | null> {
    const trimmed = (sql ?? '').trim()
    if (trimmed.length === 0) return null
    const parts = this.services.classifier.splitStatements(trimmed)
    if (parts.length !== 1) return null
    let risk: StatementRisk
    try {
      risk = this.services.classifier.classifyStatement(parts[0], 0)
    } catch {
      return null
    }
    // Only meaningful for predicates we understand; otherwise null (per contract).
    if (!isDml(risk.kind) && risk.kind !== 'select') return null
    if (risk.hasWhereClause !== true) return null
    try {
      const result = await session.rawQuery(`EXPLAIN ${parts[0]}`, undefined, {
        timeoutMs: this.defaultTimeoutMs()
      })
      let total = 0
      let found = false
      for (const row of result.rows) {
        const value = row.rows ?? row.ROWS
        if (value === null || value === undefined) continue
        const numeric = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(numeric) || numeric < 0) continue
        total += numeric
        found = true
      }
      return found ? total : null
    } catch (error) {
      this.logger.warn('EXPLAIN 行数估算失败，返回 null', {
        error: errorMessage(error),
        sqlPreview: trimmed.slice(0, 200)
      })
      return null
    }
  }

  /* ------------------------------ internals ---------------------------- */

  private validateInput(input: ExecutorInput): void {
    if (!input || typeof input.sql !== 'string' || input.sql.trim().length === 0) {
      throw new AppError('VALIDATION', 'SQL 不能为空')
    }
    if (!input.analysis || !Array.isArray(input.analysis.statements)) {
      throw new AppError('VALIDATION', '缺少 SQL 风险分析结果，拒绝执行')
    }
    if (typeof input.maxRows !== 'number' || !Number.isFinite(input.maxRows) || input.maxRows <= 0) {
      throw new AppError('VALIDATION', 'maxRows 必须是正整数')
    }
    if (
      typeof input.timeoutMs !== 'number' ||
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs <= 0
    ) {
      throw new AppError('VALIDATION', 'timeoutMs 必须是正整数')
    }
  }

  /**
   * Execution and protection must use the same analysis. A mismatching caller
   * analysis is re-derived locally (and reported as a warning) rather than
   * executed against stale risk metadata.
   */
  private effectiveAnalysis(input: ExecutorInput, warnings: string[]): SqlAnalysis {
    let classified: SqlAnalysis
    try {
      classified = this.services.classifier.classify(input.sql)
    } catch (error) {
      throw new AppError('VALIDATION', `SQL 无法分类，拒绝执行：${errorMessage(error)}`, {
        cause: error
      })
    }
    if (classified.statements.length === 0) {
      throw new AppError('VALIDATION', 'SQL 中没有可执行语句')
    }
    const provided = input.analysis
    const matches =
      provided.statements.length === classified.statements.length &&
      provided.statements.every((statement, index) => {
        const expected = classified.statements[index]
        return (
          statement.statementIndex === expected.statementIndex &&
          statement.kind === expected.kind &&
          statement.sql.trim() === expected.sql.trim()
        )
      })
    if (!matches) {
      warnings.push('传入的风险分析与当前 SQL 不一致，执行器已重新分类并使用最新分析结果。')
      this.logger.warn('SQL 分析与执行器重新分类结果不一致，已采用重新分类结果', {
        providedStatements: provided.statements.length,
        actualStatements: classified.statements.length
      })
    }
    // Always execute (and protect) against the freshly classified analysis; a
    // caller-supplied analysis is never trusted for risk metadata.
    return classified
  }

  private effectiveProtectionContext(
    hooks: ExecutorHooks,
    analysis: SqlAnalysis,
    input: ExecutorInput
  ): ExecutorHooks['protectionContext'] | null {
    const context = hooks.protectionContext
    if (!context) return null
    return {
      ...context,
      analysis,
      sql: input.sql,
      ...(input.database ? { database: input.database } : {})
    }
  }

  private async runStatement(
    session: DbSession,
    statement: StatementRisk,
    input: ExecutorInput,
    signal?: AbortSignal
  ): Promise<QueryHandle | SyntheticUse> {
    // USE must go through the session so the database context stays coherent for
    // pooled connections (a raw USE would only affect one physical connection).
    const useMatch = /^\s*USE\s+`?([^`\s;]+)`?\s*$/i.exec(statement.sql)
    if (useMatch && statement.kind === 'set') {
      await session.setDatabase(useMatch[1])
      return { synthetic: 'use' }
    }
    return session.query(statement.sql, {
      maxRows: clamp(input.maxRows, 1, 100_000),
      timeoutMs: input.timeoutMs,
      signal
    })
  }

  private toExecution(
    statement: StatementRisk,
    handle: QueryHandle | SyntheticUse,
    startedAt: number
  ): StatementExecution {
    if ('synthetic' in handle) {
      return {
        statementIndex: statement.statementIndex,
        sql: statement.sql,
        kind: statement.kind,
        ok: true,
        affectedRows: 0,
        insertId: null,
        rowCount: 0,
        warnings: [],
        durationMs: Date.now() - startedAt
      }
    }
    return {
      statementIndex: statement.statementIndex,
      sql: statement.sql,
      kind: statement.kind,
      ok: true,
      affectedRows: handle.affectedRows,
      insertId: handle.insertId,
      rowCount: handle.rowCount,
      warnings: [...handle.warnings],
      durationMs: handle.durationMs
    }
  }

  private failedExecution(
    statement: StatementRisk,
    error: AppError,
    startedAt: number
  ): StatementExecution {
    return {
      statementIndex: statement.statementIndex,
      sql: statement.sql,
      kind: statement.kind,
      ok: false,
      affectedRows: 0,
      insertId: null,
      rowCount: 0,
      warnings: [],
      durationMs: Math.max(0, Date.now() - startedAt),
      error: this.errorPayload(error)
    }
  }

  private toResultPage(handle: QueryHandle | SyntheticUse, maxRows: number): QueryResultPage {
    if ('synthetic' in handle) {
      return { columns: [], rows: [], rowCount: 0, truncated: false, maxRows }
    }
    return {
      columns: handle.columns,
      rows: handle.rows,
      rowCount: handle.rowCount,
      truncated: handle.truncated,
      maxRows
    }
  }

  private backfillRecoveryPoint(
    statements: StatementExecution[],
    recoveryPointId: string | null
  ): void {
    if (!recoveryPointId) return
    for (const statement of statements) {
      if (statement.ok && isWriteKind(statement.kind)) statement.recoveryPointId = recoveryPointId
    }
  }

  private mapStatementError(error: unknown): AppError {
    if (isAppError(error)) return error
    return mapDbError(error, 'SQL 执行失败')
  }

  private errorPayload(error: AppError): AppErrorPayload {
    return error.toPayload()
  }

  private async safeAbort(
    protection: WriteProtection,
    context: NonNullable<ExecutorHooks['protectionContext']>,
    preparation: ProtectionPreparation | null,
    error: Error,
    warnings: string[]
  ): Promise<void> {
    try {
      await protection.abort(context, preparation, error)
    } catch (abortError) {
      warnings.push(`清理写保护产物失败：${errorMessage(abortError)}，可能残留未完成备份文件。`)
      this.logger.warn('写保护 abort 失败', { error: errorMessage(abortError) })
    }
  }

  private defaultTimeoutMs(): number {
    try {
      const timeout = this.services.settings.get().sqlTimeoutMs
      return typeof timeout === 'number' && timeout > 0 ? timeout : 30_000
    } catch {
      return 30_000
    }
  }

  private buildResult(
    ok: boolean,
    state: ExecutionState,
    transaction: ExecutorTransactionOutcome,
    startedAt: number,
    error: AppError | undefined
  ): ExecutorResult {
    return {
      ok,
      statements: state.statements,
      transaction,
      durationMs: Math.max(0, Date.now() - startedAt),
      warnings: [...state.warnings],
      ...(state.lastResult ? { result: state.lastResult } : {}),
      ...(state.protectionResult ? { protection: state.protectionResult } : {}),
      ...(error
        ? {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details !== undefined ? { details: error.details } : {})
            }
          }
        : {})
    }
  }
}
