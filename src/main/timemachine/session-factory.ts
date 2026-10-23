/**
 * Standalone MySQL/MariaDB session used by the time-machine module.
 *
 * Why not reuse `services.connections.openSession()`?
 * The database core exposes ONE shared session per connection (a deliberate
 * design: transactions, `USE`, session variables stay consistent). A backup,
 * restore or verification opens its own connection *while the executor's
 * session may be in the middle of a transaction*, and closing that shared
 * session would break the caller. Time-machine long-running jobs therefore use
 * an independent mysql2 connection derived from the same (main-process only)
 * credential. The credential never leaves the trusted layer and is not logged.
 *
 * `dateStrings: true` is important: dump values must be re-insertable without
 * timezone conversion surprises.
 */
import { createConnection, type Connection } from 'mysql2/promise'
import type { ConnectionCredential, DbSession, QueryHandle, RawQueryResult, Services } from '@main/service-contracts'
import type { Id, QueryColumn } from '@shared/types'
import { AppError, toAppError } from '@main/util/errors'
import { newId } from '@main/util/id'

export async function openStandaloneSession(
  services: Services,
  connectionId: Id,
  database?: string
): Promise<DbSession> {
  const credential = readCredential(services, connectionId)
  const session = new StandaloneMySqlSession(connectionId, credential)
  await session.connect(database)
  return session
}

function readCredential(services: Services, connectionId: Id): ConnectionCredential {
  try {
    // No `hasCredential()` gate: a connection may legitimately have no password
    // (local socket / trust auth). `credential()` returns '' in that case and
    // still decrypts a stored password when present.
    return services.connections.credential(connectionId)
  } catch (e) {
    throw toAppError(e, 'CONNECTION_FAILED')
  }
}

class StandaloneMySqlSession implements DbSession {
  readonly connectionId: Id
  private readonly credential: ConnectionCredential
  private connection: Connection | null = null
  private currentDatabase = ''
  private inTx = false
  private version = ''
  private flavor: 'mysql' | 'mariadb' | 'unknown' = 'unknown'

  constructor(connectionId: Id, credential: ConnectionCredential) {
    this.connectionId = connectionId
    this.credential = credential
  }

  get database(): string {
    return this.currentDatabase
  }
  get serverFlavor(): 'mysql' | 'mariadb' | 'unknown' {
    return this.flavor
  }
  get serverVersion(): string {
    return this.version
  }
  get charset(): string {
    return this.credential.charset || 'utf8mb4'
  }

  async connect(database?: string): Promise<void> {
    const sslModes: Array<'off' | 'on'> =
      this.credential.ssl === 'disabled' || this.credential.ssl === 'preferred'
        ? ['off', 'on']
        : ['on']
    let lastError: unknown = null
    for (const mode of sslModes) {
      try {
        this.connection = await createConnection({
          host: this.credential.host,
          port: this.credential.port,
          user: this.credential.user,
          password: this.credential.password,
          database: database && database.length > 0 ? database : undefined,
          charset: this.credential.charset || 'utf8mb4',
          connectTimeout: this.credential.connectTimeoutMs || 10_000,
          dateStrings: true,
          multipleStatements: false,
          ...(mode === 'on' ? { ssl: { rejectUnauthorized: false } } : {})
        })
        lastError = null
        break
      } catch (e) {
        lastError = e
        if (this.credential.ssl === 'required') break
      }
    }
    if (!this.connection) {
      throw toAppError(lastError, 'CONNECTION_FAILED')
    }
    try {
      const [rows] = await this.connection.query('SELECT VERSION() AS v')
      const row = (rows as Record<string, unknown>[])[0] ?? {}
      this.version = String(row.v ?? '')
      this.flavor = /mariadb/i.test(this.version) ? 'mariadb' : 'mysql'
      this.currentDatabase = database && database.length > 0 ? database : ''
    } catch (e) {
      await this.release().catch(() => undefined)
      throw toAppError(e, 'CONNECTION_FAILED')
    }
  }

  async setDatabase(name: string): Promise<void> {
    const connection = this.assertConnection()
    if (!/^[A-Za-z0-9_$\u0080-\uFFFF-]+$/.test(name)) {
      throw new AppError('VALIDATION', `非法数据库名：${name}`)
    }
    if (name === this.currentDatabase) return
    try {
      await connection.query(`USE \`${name.replace(/`/g, '``')}\``)
      this.currentDatabase = name
    } catch (e) {
      throw toAppError(e, 'QUERY_FAILED')
    }
  }

  async ping(): Promise<void> {
    const connection = this.assertConnection()
    try {
      await connection.query('SELECT 1')
    } catch (e) {
      throw toAppError(e, 'CONNECTION_FAILED')
    }
  }

  async rawQuery<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    _opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RawQueryResult<T>> {
    const connection = this.assertConnection()
    try {
      const [result, fields] = await connection.query(sql, params)
      if (Array.isArray(result)) {
        const columns = ((fields ?? []) as unknown as FieldLike[]).map((field) => mapField(field))
        return {
          rows: result as T[],
          columns,
          affectedRows: 0,
          insertId: null,
          warnings: []
        }
      }
      const ok = result as unknown as Record<string, unknown>
      return {
        rows: [] as T[],
        columns: [],
        affectedRows: Number(ok.affectedRows ?? 0),
        insertId: (ok.insertId as number | undefined) ?? null,
        warnings: Number(ok.warningStatus ?? 0) > 0 ? [`警告 ${ok.warningStatus} 条`] : []
      }
    } catch (e) {
      throw toAppError(e, 'QUERY_FAILED')
    }
  }

  async query(
    sql: string,
    opts: { maxRows: number; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<QueryHandle> {
    const started = Date.now()
    const result = await this.rawQuery(sql, undefined, opts)
    const truncated = result.rows.length > opts.maxRows
    return {
      columns: result.columns,
      rows: result.rows.slice(0, opts.maxRows).map((row) => Object.values(row as Record<string, unknown>)),
      rowCount: Math.min(result.rows.length, opts.maxRows),
      affectedRows: result.affectedRows,
      insertId: result.insertId,
      warnings: result.warnings,
      durationMs: Date.now() - started,
      truncated
    }
  }

  async beginTransaction(): Promise<void> {
    const connection = this.assertConnection()
    try {
      await connection.beginTransaction()
      this.inTx = true
    } catch (e) {
      throw toAppError(e, 'QUERY_FAILED')
    }
  }

  async commit(): Promise<void> {
    const connection = this.assertConnection()
    try {
      await connection.commit()
      this.inTx = false
    } catch (e) {
      throw toAppError(e, 'QUERY_FAILED')
    }
  }

  async rollback(): Promise<void> {
    const connection = this.assertConnection()
    try {
      await connection.rollback()
    } finally {
      this.inTx = false
    }
  }

  inTransaction(): boolean {
    return this.inTx
  }

  async release(): Promise<void> {
    if (!this.connection) return
    const connection = this.connection
    this.connection = null
    this.inTx = false
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

  private assertConnection(): Connection {
    if (!this.connection) {
      throw new AppError('CONNECTION_FAILED', '数据库会话已关闭，请重新连接。')
    }
    return this.connection
  }
}

interface FieldLike {
  name: string
  type?: number
  columnType?: number
  flags?: number
  characterSet?: number
}

function mapField(field: FieldLike): QueryColumn {
  return {
    name: field.name,
    typeName: typeNameOf(field.type ?? 0),
    fieldType: field.type ?? 0,
    ...((field.flags ?? 0) & 1 ? { nullable: false } : {})
  }
}

function typeNameOf(type: number): string {
  // mysql2 field type codes (only the common ones are humanised)
  const map: Record<number, string> = {
    0: 'DECIMAL',
    1: 'TINY',
    2: 'SHORT',
    3: 'LONG',
    4: 'FLOAT',
    5: 'DOUBLE',
    7: 'TIMESTAMP',
    8: 'LONGLONG',
    9: 'INT24',
    10: 'DATE',
    11: 'TIME',
    12: 'DATETIME',
    13: 'YEAR',
    15: 'VARCHAR',
    16: 'BIT',
    245: 'JSON',
    246: 'NEWDECIMAL',
    247: 'ENUM',
    248: 'SET',
    249: 'TINY_BLOB',
    250: 'MEDIUM_BLOB',
    251: 'LONG_BLOB',
    252: 'BLOB',
    253: 'VAR_STRING',
    254: 'STRING',
    255: 'GEOMETRY'
  }
  return map[type] ?? `TYPE_${type}`
}

/** Small helper for modules that need a throw-away session id (tests). */
export function standaloneSessionId(): string {
  return newId('sess')
}
