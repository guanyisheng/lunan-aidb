/**
 * AIDB Studio - MySQL / MariaDB connection manager and session.
 *
 * Design and safety notes
 * -----------------------
 * - `mysql2/promise` is used with `multipleStatements: false`. The application
 *   splits and classifies scripts itself; the driver must never execute several
 *   statements implicitly.
 * - One pool per saved connection (`connectionLimit: 4`), lazily created and
 *   disposed together with the session. Passwords never leave the main process
 *   in plaintext: they are encrypted by `services.secrets` on save and decrypted
 *   only when a pool is created.
 * - The session owns a single "pinned" pooled connection while a transaction is
 *   active; every query inside the transaction runs on that connection.
 * - Database context: the pool is database-agnostic; each physical connection
 *   tracks the last database it switched to (WeakMap) and `USE` is issued only
 *   when the target database differs. Without this, switching the database on a
 *   pooled session would race with other pooled connections.
 * - A broken connection pool is rebuilt lazily. Only `ping()` retries the
 *   connection automatically. Arbitrary statements are NEVER retried because a
 *   write may already have been applied server-side; the executor reports the
 *   truth and the user decides.
 * - Errors are mapped to typed `AppError`s and never swallowed.
 */
import { createConnection, createPool } from 'mysql2/promise'
import type {
  Connection as MySqlConnection,
  ConnectionOptions,
  FieldPacket,
  Pool,
  PoolConnection,
  PoolOptions,
  QueryOptions,
  RowDataPacket,
  ResultSetHeader
} from 'mysql2/promise'

import type {
  ConnectionInput,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionTestResult,
  DatabaseInfo,
  Id,
  QueryColumn,
  SslMode
} from '@shared/types'
import type {
  ConnectionCredential,
  ConnectionManager,
  ConnectionRecord,
  DbSession,
  Logger,
  QueryHandle,
  RawQueryResult,
  Services
} from '../service-contracts'
import { AppError } from '../util/errors'
import { newId } from '../util/id'
import { nowIso } from '../util/time'
import {
  clamp,
  isAbortError,
  isFatalConnectionError,
  isTimeoutError,
  mapDbError,
  quoteId,
  resolveServices,
  throwIfAborted,
  toStringValue,
  validateDatabaseName,
  type ServicesSource
} from './internal'
import { DATABASE_LIST_SQL, mapDatabaseRows } from './meta'

/** Record type extended by the Lead-owned store with the persisted connect timeout. */
type ConnectionRecordWithTimeout = ConnectionRecord & { connectTimeoutMs?: number }

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const MIN_CONNECT_TIMEOUT_MS = 1_000
const MAX_CONNECT_TIMEOUT_MS = 120_000
const POOL_SIZE = 4
const MAX_RESULT_ROWS = 100_000

const PROBE_SQL =
  'SELECT VERSION() AS version, @@version_comment AS comment, @@character_set_connection AS charset'

interface ServerProbe {
  version: string
  comment: string
  flavor: 'mysql' | 'mariadb' | 'unknown'
  charset: string
  sslActive: boolean
}

interface ConnectionRuntime {
  record: ConnectionRecord
  credential: ConnectionCredential
  pool: Pool | null
  session: MySqlSession | null
  status: ConnectionStatus
  probe: ServerProbe | null
}

/** Host side of a session (implemented by the manager, avoids module cycles). */
interface SessionHost {
  ensurePool(connectionId: Id): Promise<Pool>
  ping(connectionId: Id): Promise<void>
  onFatal(connectionId: Id, error: unknown): void
  onSessionClosed(connectionId: Id): Promise<void>
}

/* ------------------------------------------------------------------ */
/* mysql2 row/field helpers                                            */
/* ------------------------------------------------------------------ */

const TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  14: 'NEWDATE',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'NEWDECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VAR_STRING',
  254: 'STRING',
  255: 'GEOMETRY'
}

function normalizeFieldPacketList(fields: FieldPacket[] | FieldPacket[][] | undefined): FieldPacket[] {
  if (!fields || fields.length === 0) return []
  const first = fields[0] as unknown
  if (Array.isArray(first)) {
    const sets = fields as unknown as FieldPacket[][]
    return sets[0] ?? []
  }
  return fields as FieldPacket[]
}

function fieldIsNullable(field: FieldPacket): boolean | undefined {
  const flags = field.flags
  if (typeof flags === 'number') return (flags & 1) === 0
  if (Array.isArray(flags)) return !flags.includes('NOT_NULL')
  return undefined
}

function mapFieldPackets(fields: FieldPacket[]): QueryColumn[] {
  return fields.map((field) => {
    const type = typeof field.type === 'number' ? field.type : field.columnType
    const typeName =
      typeof field.typeName === 'string' && field.typeName.length > 0
        ? field.typeName
        : (type !== undefined ? TYPE_NAMES[type] : undefined) ?? 'UNKNOWN'
    return {
      name: field.name,
      typeName,
      fieldType: typeof type === 'number' ? type : 0,
      nullable: fieldIsNullable(field),
      table: field.table || undefined,
      database: field.db || undefined
    }
  })
}

function isResultSetHeader(value: unknown): value is ResultSetHeader {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { affectedRows?: unknown }).affectedRows === 'number'
  )
}

function normalizeRowsOfObjects(rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return []
  if (rows.length === 0) return []
  const first: unknown = rows[0]
  if (Array.isArray(first)) {
    // Stored procedures / multiple result sets: use the first tabular set.
    const firstSet = (rows as unknown[])[0]
    return Array.isArray(firstSet)
      ? (firstSet.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) as Record<
          string,
          unknown
        >[])
      : []
  }
  return rows.filter(
    (row) => row && typeof row === 'object' && !Array.isArray(row)
  ) as Record<string, unknown>[]
}

function normalizeRowsOfArrays(rows: unknown): unknown[][] {
  if (!Array.isArray(rows)) return []
  if (rows.length === 0) return []
  const first: unknown = rows[0]
  if (Array.isArray(first) && first.length > 0 && Array.isArray(first[0])) {
    return first as unknown[][]
  }
  if (Array.isArray(first)) return rows as unknown[][]
  // A single object result (e.g. write statement) has no row set.
  return []
}

function detectFlavor(version: string, comment: string): 'mysql' | 'mariadb' | 'unknown' {
  const haystack = `${version} ${comment}`.toLowerCase()
  if (haystack.includes('mariadb')) return 'mariadb'
  if (haystack.includes('mysql')) return 'mysql'
  return 'unknown'
}

function looksLikeSslFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: string; message?: string; sqlMessage?: string }
  const text = `${e.code ?? ''} ${e.sqlMessage ?? ''} ${e.message ?? ''}`
  return /ssl|tls|handshake|certificate|secure connection/i.test(text)
}

function hintForConnectionError(error: unknown): string {
  const e = (error ?? {}) as { code?: string; message?: string; sqlMessage?: string }
  const text = `${e.code ?? ''} ${e.sqlMessage ?? ''} ${e.message ?? ''}`
  if (/access denied|ER_ACCESS_DENIED/i.test(text)) return '请检查用户名、密码以及该账号允许登录的主机。'
  if (/ER_BAD_DB_ERROR/i.test(text)) return '目标数据库不存在，请先创建数据库或选择其他数据库。'
  if (/ECONNREFUSED/i.test(text)) return '目标主机拒绝连接，请确认 MySQL/MariaDB 已启动且端口正确。'
  if (/ENOTFOUND|EHOSTUNREACH/i.test(text)) return '主机名无法解析或不可达，请检查主机地址与网络。'
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return '连接超时，请检查网络、防火墙以及连接超时配置。'
  return '请检查连接配置与服务器状态后重试。'
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

interface MySqlSessionOptions {
  connectionId: Id
  database: string
  probe: ServerProbe
  host: SessionHost
  logger: Logger
}

interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  rowsAsArray: boolean
}

interface RunResult {
  objectRows: Record<string, unknown>[]
  arrayRows: unknown[][]
  columns: QueryColumn[]
  affectedRows: number
  insertId: number | null
  warnings: string[]
}

/**
 * A DbSession backed by a shared pool.
 *
 * Transaction boundary: `beginTransaction()` pins one pooled connection and
 * every query routed through this session runs on it until `commit()` /
 * `rollback()`. Note that this protects *InnoDB data changes made by the
 * statements themselves*; it cannot undo DDL (implicit commit), and it cannot
 * undo side effects that live outside the transaction (files written by UDFs,
 * external services called from procedures, messages sent by triggers, etc.).
 */
export class MySqlSession implements DbSession {
  readonly connectionId: Id
  readonly serverFlavor: 'mysql' | 'mariadb' | 'unknown'
  readonly serverVersion: string
  readonly charset: string

  private readonly host: SessionHost
  private readonly logger: Logger
  private readonly dbByConnection = new WeakMap<PoolConnection, string>()
  private currentDatabase: string
  private pinned: PoolConnection | null = null
  private brokenTransaction = false
  private closed = false

  constructor(options: MySqlSessionOptions) {
    this.connectionId = options.connectionId
    this.currentDatabase = options.database
    this.serverVersion = options.probe.version
    this.serverFlavor = options.probe.flavor
    this.charset = options.probe.charset
    this.host = options.host
    this.logger = options.logger
  }

  get database(): string {
    return this.currentDatabase
  }

  get disposed(): boolean {
    return this.closed
  }

  /* ------------------------------ queries ------------------------------ */

  async rawQuery<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RawQueryResult<T>> {
    const result = await this.run(sql, params, {
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      rowsAsArray: false
    })
    return {
      rows: result.objectRows as T[],
      columns: result.columns,
      affectedRows: result.affectedRows,
      insertId: result.insertId,
      warnings: result.warnings
    }
  }

  async query(
    sql: string,
    opts: { maxRows: number; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<QueryHandle> {
    const startedAt = Date.now()
    const maxRows = clamp(
      typeof opts.maxRows === 'number' && opts.maxRows > 0 ? opts.maxRows : 1000,
      1,
      MAX_RESULT_ROWS
    )
    const result = await this.run(sql, undefined, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      rowsAsArray: true
    })
    const truncated = result.arrayRows.length > maxRows
    const rows = truncated ? result.arrayRows.slice(0, maxRows) : result.arrayRows
    return {
      columns: result.columns,
      rows,
      rowCount: rows.length,
      affectedRows: result.affectedRows,
      insertId: result.insertId,
      warnings: result.warnings,
      durationMs: Date.now() - startedAt,
      truncated
    }
  }

  private async run(sql: string, params: unknown[] | undefined, opts: RunOptions): Promise<RunResult> {
    this.assertOpen()
    throwIfAborted(opts.signal, 'SQL 执行已取消')
    const timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? clamp(opts.timeoutMs, 1, 600_000) : undefined

    const connection = await this.acquire()
    const isPinned = connection === this.pinned
    const onAbort = (): void => {
      // Destroying the socket is the only reliable way to interrupt a running
      // MySQL query; the await below rejects and the caller maps it.
      try {
        connection.destroy()
      } catch {
        /* connection already gone */
      }
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.ensureDatabase(connection)
      const queryOptions: QueryOptions = {
        sql,
        values: params as QueryOptions['values'],
        rowsAsArray: opts.rowsAsArray,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {})
      }
      const [rawRows, rawFields] = await connection.query<RowDataPacket[]>(queryOptions)
      const fields = normalizeFieldPacketList(
        rawFields as unknown as FieldPacket[] | FieldPacket[][] | undefined
      )
      const columns = mapFieldPackets(fields)

      if (isResultSetHeader(rawRows)) {
        const warningCount =
          typeof (rawRows as unknown as { warningStatus?: unknown }).warningStatus === 'number'
            ? (rawRows as unknown as { warningStatus: number }).warningStatus
            : typeof (rawRows as unknown as { warningCount?: unknown }).warningCount === 'number'
              ? (rawRows as unknown as { warningCount: number }).warningCount
              : 0
        return {
          objectRows: [],
          arrayRows: [],
          columns,
          affectedRows: rawRows.affectedRows,
          insertId: typeof rawRows.insertId === 'number' ? rawRows.insertId : null,
          warnings: warningCount > 0 ? [`服务器返回 ${warningCount} 个警告`] : []
        }
      }

      const objectRows = normalizeRowsOfObjects(rawRows)
      const arrayRows = normalizeRowsOfArrays(rawRows)
      return {
        objectRows,
        arrayRows,
        columns,
        affectedRows: 0,
        insertId: null,
        warnings: []
      }
    } catch (error) {
      const aborted = opts.signal?.aborted === true || isAbortError(error)
      if (aborted) {
        // An abort intentionally destroys the socket; do not tear down the whole
        // pool for it (only the pinned transaction is unusable).
        if (isPinned) this.brokenTransaction = true
        throw new AppError('CANCELLED', 'SQL 执行已取消', { cause: error })
      }
      if (isTimeoutError(error) && isPinned) this.brokenTransaction = true
      if (isFatalConnectionError(error)) {
        if (isPinned) this.brokenTransaction = true
        this.host.onFatal(this.connectionId, error)
      }
      throw mapDbError(error, 'SQL 执行失败')
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      if (!isPinned) this.safeRelease(connection)
    }
  }

  /* ---------------------------- transactions --------------------------- */

  async beginTransaction(): Promise<void> {
    this.assertOpen()
    if (this.pinned) throw new AppError('CONFLICT', '当前会话已处于事务中')
    const pool = await this.host.ensurePool(this.connectionId)
    const connection = await pool.getConnection()
    try {
      await this.ensureDatabase(connection)
      await connection.beginTransaction()
      this.pinned = connection
      this.brokenTransaction = false
    } catch (error) {
      this.safeRelease(connection)
      throw mapDbError(error, '开始事务失败')
    }
  }

  async commit(): Promise<void> {
    this.assertOpen()
    const connection = this.pinned
    if (!connection) throw new AppError('CONFLICT', '当前会话没有进行中的事务')
    if (this.brokenTransaction) {
      this.dropPinned()
      throw new AppError('CONFLICT', '事务连接已断开或超时，无法提交；请重新执行该操作。')
    }
    try {
      await connection.commit()
    } catch (error) {
      this.dropPinned()
      throw mapDbError(error, '提交事务失败')
    }
    this.releasePinned()
  }

  async rollback(): Promise<void> {
    this.assertOpen()
    const connection = this.pinned
    if (!connection) throw new AppError('CONFLICT', '当前会话没有进行中的事务')
    if (this.brokenTransaction) {
      this.dropPinned()
      // Report truthfully: a destroyed/lost connection cannot roll back, and a
      // silent no-op would let callers believe the transaction was undone.
      throw new AppError('CONFLICT', '事务连接已断开，无法回滚；请人工核对数据状态。')
    }
    try {
      await connection.rollback()
    } catch (error) {
      this.dropPinned()
      throw mapDbError(error, '回滚事务失败')
    }
    this.releasePinned()
  }

  inTransaction(): boolean {
    return this.pinned !== null
  }

  /* ------------------------------ session ------------------------------ */

  async setDatabase(name: string): Promise<void> {
    this.assertOpen()
    const database = validateDatabaseName(name)
    if (database === this.currentDatabase) return
    const connection = await this.acquire()
    const isPinned = connection === this.pinned
    try {
      await connection.query(`USE ${quoteId(database)}`)
      this.dbByConnection.set(connection, database)
      this.currentDatabase = database
    } catch (error) {
      throw mapDbError(error, `切换数据库失败（${database}）`)
    } finally {
      if (!isPinned) this.safeRelease(connection)
    }
  }

  async ping(): Promise<void> {
    this.assertOpen()
    await this.host.ping(this.connectionId)
  }

  async release(): Promise<void> {
    if (this.closed) return
    await this.disposeInternal()
    await this.host.onSessionClosed(this.connectionId)
  }

  /** Internal, idempotent teardown used by the manager when closing a runtime. */
  async disposeInternal(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const connection = this.pinned
    this.pinned = null
    this.brokenTransaction = false
    if (connection) {
      try {
        if (!this.brokenTransaction) await connection.rollback()
      } catch (error) {
        this.logger.warn('关闭会话时回滚未完成的事务失败', {
          connectionId: this.connectionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      try {
        connection.destroy()
      } catch {
        /* already destroyed */
      }
    }
  }

  /* ------------------------------ internals ---------------------------- */

  private assertOpen(): void {
    if (this.closed) {
      throw new AppError('CONNECTION_FAILED', '数据库会话已关闭，请重新连接。')
    }
  }

  private async acquire(): Promise<PoolConnection> {
    if (this.pinned) return this.pinned
    const pool = await this.host.ensurePool(this.connectionId)
    return pool.getConnection()
  }

  private async ensureDatabase(connection: PoolConnection): Promise<void> {
    if (!this.currentDatabase) return
    if (this.dbByConnection.get(connection) === this.currentDatabase) return
    await connection.query(`USE ${quoteId(this.currentDatabase)}`)
    this.dbByConnection.set(connection, this.currentDatabase)
  }

  private safeRelease(connection: PoolConnection): void {
    try {
      connection.release()
    } catch {
      try {
        connection.destroy()
      } catch {
        /* already destroyed */
      }
    }
  }

  private releasePinned(): void {
    const connection = this.pinned
    this.pinned = null
    this.brokenTransaction = false
    if (connection) this.safeRelease(connection)
  }

  private dropPinned(): void {
    const connection = this.pinned
    this.pinned = null
    this.brokenTransaction = false
    if (connection) {
      try {
        connection.destroy()
      } catch {
        /* already destroyed */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Connection manager                                                  */
/* ------------------------------------------------------------------ */

export class MySqlConnectionManager implements ConnectionManager, SessionHost {
  private readonly servicesSource: ServicesSource
  private readonly cache = new Map<Id, ConnectionRuntime>()
  private readonly connectTimeoutById = new Map<Id, number>()

  constructor(services: ServicesSource) {
    this.servicesSource = services
  }

  private get services(): Services {
    return resolveServices(this.servicesSource)
  }

  private get logger(): Logger {
    return this.services.logger.child('db.connection')
  }

  /* ------------------------------ listing ------------------------------ */

  list(): ConnectionSummary[] {
    return this.services.store.listConnectionRecords().map((record) => this.toSummary(record))
  }

  async save(input: { id?: Id; input: ConnectionInput }): Promise<ConnectionSummary> {
    const store = this.services.store
    const existing = input.id ? store.getConnectionRecord(input.id) : null
    if (input.id && !existing) {
      throw new AppError('NOT_FOUND', `连接不存在：${input.id}`)
    }

    const name = this.requireText(input.input.name, '连接名称')
    const host = this.requireText(input.input.host, '主机地址')
    const user = this.requireText(input.input.user, '用户名')
    const port = this.validatePort(input.input.port)
    const ssl = this.normalizeSsl(input.input.ssl ?? existing?.ssl ?? 'preferred')
    const charset = (input.input.charset ?? existing?.charset ?? 'utf8mb4').trim() || 'utf8mb4'
    const connectTimeoutMs = this.normalizeConnectTimeout(
      input.input.connectTimeoutMs ?? (existing ? this.connectTimeoutOf(existing) : DEFAULT_CONNECT_TIMEOUT_MS)
    )

    let secretCipher = existing?.secretCipher ?? null
    if (input.input.password !== undefined) {
      if (input.input.password === '') {
        secretCipher = null
      } else {
        const cipher = this.services.secrets.encrypt(input.input.password)
        if (!cipher) {
          throw new AppError('SECRET_ERROR', '无法安全保存数据库密码', {
            hint: '系统密钥库不可用。请检查系统钥匙串/凭据管理器后重试。'
          })
        }
        secretCipher = cipher
      }
    }

    const timestamp = nowIso()
    const record: ConnectionRecordWithTimeout = {
      id: existing?.id ?? newId('conn'),
      name,
      host,
      port,
      user,
      database: (input.input.database ?? existing?.database ?? '').trim(),
      ssl,
      charset,
      hasStoredPassword: secretCipher !== null,
      ...(input.input.color !== undefined
        ? { color: input.input.color }
        : existing?.color !== undefined
          ? { color: existing.color }
          : {}),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
      lastState: existing?.lastState ?? 'disconnected',
      secretCipher,
      connectTimeoutMs
    }

    const saved = store.saveConnectionRecord(record)
    this.connectTimeoutById.set(saved.id, connectTimeoutMs)

    const cached = this.cache.get(saved.id)
    if (cached && this.connectionSettingsChanged(cached.record, saved)) {
      await this.dropRuntime(saved.id, 'disconnected')
    } else if (cached) {
      cached.record = saved
      cached.credential = this.credentialFromRecord(saved, connectTimeoutMs)
    }

    this.logger.info('已保存数据库连接配置', {
      connectionId: saved.id,
      name: saved.name,
      host: saved.host,
      port: saved.port,
      user: saved.user,
      hasStoredPassword: saved.hasStoredPassword
    })
    return this.toSummary(saved)
  }

  async remove(id: Id): Promise<void> {
    const store = this.services.store
    if (!store.getConnectionRecord(id)) {
      throw new AppError('NOT_FOUND', `连接不存在：${id}`)
    }
    await this.dropRuntime(id, 'disconnected')
    store.deleteConnectionRecord(id)
    this.cache.delete(id)
    this.connectTimeoutById.delete(id)
    this.logger.info('已删除数据库连接配置', { connectionId: id })
  }

  /* ------------------------------ testing ------------------------------ */

  async test(input: { id?: Id; input: ConnectionInput }): Promise<ConnectionTestResult> {
    const stored = input.id ? this.services.store.getConnectionRecord(input.id) : null
    if (input.id && !stored) {
      throw new AppError('NOT_FOUND', `连接不存在：${input.id}`)
    }
    const startedAt = Date.now()
    let host = input.input.host
    try {
      const credential = this.credentialFromInput(stored, input.input)
      host = credential.host
      const probe = await this.probeStandalone(credential)
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        host: credential.host,
        serverVersion: probe.version,
        serverFlavor: probe.flavor,
        sslActive: probe.sslActive
      }
    } catch (error) {
      const mapped = mapDbError(error, '连接测试失败')
      this.logger.warn('数据库连接测试失败', {
        host,
        port: input.input.port,
        user: input.input.user,
        error: mapped.message
      })
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        host,
        error: mapped.message,
        hint: mapped.hint ?? hintForConnectionError(error)
      }
    }
  }

  /* ---------------------------- lifecycle ------------------------------ */

  async connect(id: Id): Promise<ConnectionStatus> {
    const runtime = this.runtimeFor(id)
    try {
      await this.ensurePool(id)
      this.services.store.touchConnection(id)
      return runtime.status
    } catch (error) {
      const mapped = mapDbError(error, '连接数据库失败')
      runtime.status = {
        connectionId: id,
        state: 'error',
        error: mapped.message
      }
      this.persistState(id, 'error')
      this.emitStatus(runtime.status)
      throw mapped
    }
  }

  async disconnect(id: Id): Promise<void> {
    if (!this.cache.has(id) && !this.services.store.getConnectionRecord(id)) {
      throw new AppError('NOT_FOUND', `连接不存在：${id}`)
    }
    // Ensure a runtime exists so `lastState` is persisted as disconnected even
    // when the connection was never opened in this process.
    this.runtimeFor(id)
    await this.dropRuntime(id, 'disconnected')
  }

  async status(id: Id): Promise<ConnectionStatus> {
    const runtime = this.cache.get(id)
    if (runtime) return runtime.status
    const record = this.services.store.getConnectionRecord(id)
    if (!record) throw new AppError('NOT_FOUND', `连接不存在：${id}`)
    return {
      connectionId: id,
      state: record.lastState,
      ...(record.lastState === 'error' ? { error: '上次连接失败' } : {})
    }
  }

  async listDatabases(id: Id): Promise<DatabaseInfo[]> {
    const session = await this.openSession(id)
    const result = await session.rawQuery(DATABASE_LIST_SQL)
    return mapDatabaseRows(result.rows)
  }

  async openSession(id: Id, database?: string): Promise<DbSession> {
    const runtime = this.runtimeFor(id)
    if (database !== undefined && database !== '') validateDatabaseName(database)

    if (runtime.session && !runtime.session.disposed) {
      if (database && database !== runtime.session.database) {
        await runtime.session.setDatabase(database)
      }
      this.services.store.touchConnection(id)
      return runtime.session
    }

    await this.ensurePool(id)
    const probe: ServerProbe = runtime.probe ?? {
      version: 'unknown',
      comment: '',
      flavor: 'unknown',
      charset: runtime.record.charset,
      sslActive: false
    }
    const session = new MySqlSession({
      connectionId: id,
      database: database && database !== '' ? database : runtime.record.database,
      probe,
      host: this,
      logger: this.logger.child('session')
    })
    runtime.session = session
    this.services.store.touchConnection(id)

    // Fail fast when the selected database does not exist, instead of failing on
    // the first user query with a confusing error.
    if (session.database) {
      try {
        await session.setDatabase(session.database)
      } catch (error) {
        runtime.session = null
        await session.disposeInternal()
        throw mapDbError(error, `打开会话失败（数据库 ${session.database}）`)
      }
    }
    this.logger.debug('已打开数据库会话', {
      connectionId: id,
      database: session.database,
      serverVersion: session.serverVersion,
      serverFlavor: session.serverFlavor
    })
    return session
  }

  credential(id: Id): ConnectionCredential {
    const runtime = this.cache.get(id)
    if (runtime) return runtime.credential
    const record = this.services.store.getConnectionRecord(id)
    if (!record) throw new AppError('NOT_FOUND', `连接不存在：${id}`)
    return this.credentialFromRecord(record, this.connectTimeoutOf(record))
  }

  hasCredential(id: Id): boolean {
    const record = this.services.store.getConnectionRecord(id)
    return record?.hasStoredPassword === true
  }

  async closeAll(): Promise<void> {
    const ids = [...this.cache.keys()]
    for (const id of ids) {
      try {
        await this.dropRuntime(id, 'disconnected')
      } catch (error) {
        this.logger.warn('关闭连接时发生错误', {
          connectionId: id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.cache.clear()
  }

  /* --------------------------- SessionHost ----------------------------- */

  async ensurePool(id: Id): Promise<Pool> {
    const runtime = this.runtimeFor(id)
    if (runtime.pool) return runtime.pool

    const startedAt = Date.now()
    runtime.status = { connectionId: id, state: 'connecting' }
    this.emitStatus(runtime.status)
    try {
      const { pool, probe } = await this.createProbedPool(runtime.credential)
      runtime.pool = pool
      runtime.probe = probe
      runtime.status = {
        connectionId: id,
        state: 'connected',
        serverVersion: probe.version,
        serverComment: probe.comment,
        serverFlavor: probe.flavor,
        latencyMs: Date.now() - startedAt,
        connectedAt: nowIso()
      }
      this.persistState(id, 'connected')
      this.emitStatus(runtime.status)
      this.logger.info('数据库连接已建立', {
        connectionId: id,
        host: runtime.credential.host,
        port: runtime.credential.port,
        database: runtime.credential.database,
        serverVersion: probe.version,
        serverFlavor: probe.flavor,
        sslActive: probe.sslActive
      })
      return pool
    } catch (error) {
      const mapped = mapDbError(error, '连接数据库失败')
      runtime.pool = null
      runtime.probe = null
      runtime.status = { connectionId: id, state: 'error', error: mapped.message }
      this.persistState(id, 'error')
      this.emitStatus(runtime.status)
      throw mapped
    }
  }

  async ping(id: Id): Promise<void> {
    try {
      const pool = await this.ensurePool(id)
      await this.pingPool(pool)
    } catch (firstError) {
      this.logger.warn('数据库 ping 失败，尝试重建连接池', {
        connectionId: id,
        error: firstError instanceof Error ? firstError.message : String(firstError)
      })
      const runtime = this.runtimeFor(id)
      const oldPool = runtime.pool
      runtime.pool = null
      runtime.probe = null
      if (oldPool) {
        try {
          await oldPool.end()
        } catch {
          /* pool already broken */
        }
      }
      const rebuilt = await this.ensurePool(id)
      await this.pingPool(rebuilt)
      this.logger.info('数据库连接池已重建', { connectionId: id })
    }
  }

  /**
   * mysql2's promise `Pool` wrapper does not expose `ping()`, so a trivial query
   * is used as the liveness probe (and it also verifies the database context).
   */
  private async pingPool(pool: Pool): Promise<void> {
    await pool.query({ sql: 'SELECT 1', timeout: 10_000 })
  }

  onFatal(id: Id, error: unknown): void {
    const runtime = this.cache.get(id)
    if (!runtime) return
    const mapped = mapDbError(error, '数据库连接中断')
    const pool = runtime.pool
    runtime.pool = null
    runtime.probe = null
    runtime.status = { connectionId: id, state: 'error', error: mapped.message }
    this.persistState(id, 'error')
    this.emitStatus(runtime.status)
    if (pool) {
      void pool.end().catch(() => {
        /* broken pool: nothing else to do */
      })
    }
    this.logger.warn('数据库连接异常断开，将在下次操作时重建连接池', {
      connectionId: id,
      error: mapped.message
    })
  }

  async onSessionClosed(id: Id): Promise<void> {
    await this.dropRuntime(id, 'disconnected')
  }

  /* ----------------------------- internals ----------------------------- */

  private runtimeFor(id: Id): ConnectionRuntime {
    const cached = this.cache.get(id)
    if (cached) return cached
    const record = this.services.store.getConnectionRecord(id)
    if (!record) throw new AppError('NOT_FOUND', `连接不存在：${id}`)
    const runtime: ConnectionRuntime = {
      record,
      credential: this.credentialFromRecord(record, this.connectTimeoutOf(record)),
      pool: null,
      session: null,
      status: {
        connectionId: id,
        state: record.lastState,
        ...(record.lastState === 'error' ? { error: '上次连接失败' } : {})
      },
      probe: null
    }
    this.cache.set(id, runtime)
    return runtime
  }

  private async dropRuntime(id: Id, state: ConnectionStatus['state']): Promise<void> {
    const runtime = this.cache.get(id)
    if (!runtime) return
    const session = runtime.session
    runtime.session = null
    if (session) await session.disposeInternal()
    const pool = runtime.pool
    runtime.pool = null
    runtime.probe = null
    if (pool) {
      try {
        await pool.end()
      } catch (error) {
        this.logger.warn('关闭连接池失败', {
          connectionId: id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    if (runtime.status.state !== state) {
      runtime.status = { connectionId: id, state }
      this.persistState(id, state)
      this.emitStatus(runtime.status)
    }
  }

  private async createProbedPool(
    credential: ConnectionCredential
  ): Promise<{ pool: Pool; probe: ServerProbe }> {
    try {
      return await this.buildAndProbePool(credential, true)
    } catch (error) {
      if (credential.ssl === 'preferred' && looksLikeSslFailure(error)) {
        this.logger.warn('SSL 连接失败，按 preferred 策略回退到非加密连接', {
          host: credential.host,
          port: credential.port
        })
        return await this.buildAndProbePool(credential, false)
      }
      throw error
    }
  }

  private async buildAndProbePool(
    credential: ConnectionCredential,
    allowSsl: boolean
  ): Promise<{ pool: Pool; probe: ServerProbe }> {
    const pool = createPool(this.poolOptions(credential, allowSsl))
    try {
      const connection = await pool.getConnection()
      try {
        const probe = await this.probeOver(connection, credential.connectTimeoutMs)
        return { pool, probe }
      } finally {
        connection.release()
      }
    } catch (error) {
      try {
        await pool.end()
      } catch {
        /* pool never really opened */
      }
      throw error
    }
  }

  private poolOptions(credential: ConnectionCredential, allowSsl: boolean): PoolOptions {
    const base = this.connectionOptions(credential, allowSsl)
    return {
      ...base,
      waitForConnections: true,
      connectionLimit: POOL_SIZE,
      maxIdle: POOL_SIZE,
      idleTimeout: 60_000,
      queueLimit: 0,
      resetOnRelease: false
    }
  }

  private connectionOptions(credential: ConnectionCredential, allowSsl: boolean): ConnectionOptions {
    const ssl =
      credential.ssl === 'disabled' || !allowSsl ? undefined : { rejectUnauthorized: false }
    return {
      host: credential.host,
      port: credential.port,
      user: credential.user,
      password: credential.password,
      charset: credential.charset,
      connectTimeout: credential.connectTimeoutMs,
      ssl,
      multipleStatements: false,
      namedPlaceholders: false,
      rowsAsArray: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000
    }
  }

  private async probeStandalone(credential: ConnectionCredential): Promise<ServerProbe> {
    try {
      return await this.probeSingleConnection(credential, true)
    } catch (error) {
      if (credential.ssl === 'preferred' && looksLikeSslFailure(error)) {
        return await this.probeSingleConnection(credential, false)
      }
      throw error
    }
  }

  private async probeSingleConnection(
    credential: ConnectionCredential,
    allowSsl: boolean
  ): Promise<ServerProbe> {
    const connection = await createConnection(this.connectionOptions(credential, allowSsl))
    try {
      return await this.probeOver(connection, credential.connectTimeoutMs)
    } finally {
      try {
        await connection.end()
      } catch {
        try {
          connection.destroy()
        } catch {
          /* already closed */
        }
      }
    }
  }

  private async probeOver(connection: MySqlConnection, timeoutMs: number): Promise<ServerProbe> {
    const [rows] = await connection.query<RowDataPacket[]>({
      sql: PROBE_SQL,
      timeout: Math.max(1, timeoutMs)
    })
    const first = Array.isArray(rows) ? (rows[0] as unknown as Record<string, unknown> | undefined) : undefined
    const version = toStringValue(first?.version, 'unknown')
    const comment = toStringValue(first?.comment, '')
    const charset = toStringValue(first?.charset, 'utf8mb4')

    let sslActive = false
    try {
      const [sslRows] = await connection.query<RowDataPacket[]>({
        sql: "SHOW STATUS LIKE 'Ssl_cipher'",
        timeout: Math.max(1, timeoutMs)
      })
      const sslRow = Array.isArray(sslRows)
        ? (sslRows[0] as unknown as Record<string, unknown> | undefined)
        : undefined
      sslActive = toStringValue(sslRow?.Value).length > 0
    } catch {
      // Some servers/proxies do not expose Ssl_cipher; absence means "unknown",
      // which we conservatively report as not active.
      sslActive = false
    }

    return {
      version,
      comment,
      flavor: detectFlavor(version, comment),
      charset,
      sslActive
    }
  }

  private credentialFromRecord(record: ConnectionRecord, connectTimeoutMs: number): ConnectionCredential {
    return {
      host: record.host,
      port: record.port,
      user: record.user,
      password: this.decryptPassword(record),
      database: record.database,
      ssl: record.ssl,
      charset: record.charset,
      connectTimeoutMs
    }
  }

  private credentialFromInput(
    stored: ConnectionRecord | null,
    input: ConnectionInput
  ): ConnectionCredential {
    const password =
      input.password !== undefined
        ? input.password
        : stored
          ? this.decryptPassword(stored)
          : ''
    return {
      host: this.requireText(input.host, '主机地址'),
      port: this.validatePort(input.port),
      user: this.requireText(input.user, '用户名'),
      password,
      database: (input.database ?? stored?.database ?? '').trim(),
      ssl: this.normalizeSsl(input.ssl ?? stored?.ssl ?? 'preferred'),
      charset: (input.charset ?? stored?.charset ?? 'utf8mb4').trim() || 'utf8mb4',
      connectTimeoutMs: this.normalizeConnectTimeout(
        input.connectTimeoutMs ??
          (stored ? this.connectTimeoutOf(stored) : DEFAULT_CONNECT_TIMEOUT_MS)
      )
    }
  }

  private decryptPassword(record: ConnectionRecord): string {
    if (!record.secretCipher) return ''
    const plaintext = this.services.secrets.decrypt(record.secretCipher)
    if (plaintext === null) {
      throw new AppError('SECRET_ERROR', '无法解密已保存的数据库密码', {
        hint: '系统密钥库不可用或凭据已损坏，请重新输入密码保存。'
      })
    }
    return plaintext
  }

  private connectTimeoutOf(record: ConnectionRecordWithTimeout): number {
    if (typeof record.connectTimeoutMs === 'number') {
      return this.normalizeConnectTimeout(record.connectTimeoutMs)
    }
    const cached = this.connectTimeoutById.get(record.id)
    return cached !== undefined ? cached : DEFAULT_CONNECT_TIMEOUT_MS
  }

  private normalizeConnectTimeout(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_CONNECT_TIMEOUT_MS
    return clamp(value, MIN_CONNECT_TIMEOUT_MS, MAX_CONNECT_TIMEOUT_MS)
  }

  private normalizeSsl(value: SslMode): SslMode {
    if (value === 'disabled' || value === 'required' || value === 'preferred') return value
    throw new AppError('VALIDATION', `不支持的 SSL 模式：${String(value)}`)
  }

  private validatePort(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new AppError('VALIDATION', '端口必须是 1-65535 之间的整数')
    }
    return value
  }

  private requireText(value: string, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AppError('VALIDATION', `${label}不能为空`)
    }
    return value.trim()
  }

  private connectionSettingsChanged(before: ConnectionRecord, after: ConnectionRecord): boolean {
    return (
      before.host !== after.host ||
      before.port !== after.port ||
      before.user !== after.user ||
      before.database !== after.database ||
      before.ssl !== after.ssl ||
      before.charset !== after.charset ||
      before.secretCipher !== after.secretCipher
    )
  }

  private toSummary(record: ConnectionRecord): ConnectionSummary {
    const { secretCipher, ...summary } = record
    void secretCipher
    return summary
  }

  private persistState(id: Id, state: ConnectionStatus['state']): void {
    try {
      this.services.store.setConnectionLastState(id, state)
    } catch (error) {
      this.logger.warn('持久化连接状态失败', {
        connectionId: id,
        state,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private emitStatus(status: ConnectionStatus): void {
    try {
      this.services.events.emit('conn.state', status)
    } catch (error) {
      this.logger.warn('发送连接状态事件失败', {
        connectionId: status.connectionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
