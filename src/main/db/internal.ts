/**
 * AIDB Studio - internal helpers shared by the MySQL database core.
 *
 * Everything in this module is private to src/main/db/. It contains the small
 * primitives that must stay consistent across connection / schema / classifier /
 * executor code:
 *  - identifier quoting (we never interpolate raw identifiers into SQL),
 *  - defensive numeric conversion for metadata queries (mysql2 may return
 *    BIGINT/DECIMAL values as strings),
 *  - canonical JSON + hashing helpers used for schema hashes and diffs,
 *  - typed AppError mapping for driver errors,
 *  - AbortSignal / timeout detection helpers.
 */
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, SchemaSnapshotTable } from '@shared/types'
import type { Services } from '../service-contracts'
import { AppError, isAppError, toAppError } from '../util/errors'
import { sha256Hex } from '../util/id'

/** The service container, passed directly or lazily (avoids construction cycles). */
export type ServicesSource = Services | (() => Services)

export function resolveServices(source: ServicesSource): Services {
  return typeof source === 'function' ? source() : source
}

/* ------------------------------------------------------------------ */
/* Identifiers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Quote a MySQL identifier. This is the *only* sanctioned way to embed a
 * database/table/column name into SQL; user/model supplied SQL is never
 * string-concatenated into statements we build ourselves.
 */
export function quoteId(name: string): string {
  if (!name || name.includes('\u0000')) {
    throw new AppError('VALIDATION', '非法的数据库标识符')
  }
  return `\`${name.replace(/`/g, '``')}\``
}

export function qualifyId(database: string, table: string): string {
  return `${quoteId(database)}.${quoteId(table)}`
}

/** MySQL object names are limited to 64 characters. */
export function validateDatabaseName(name: string): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new AppError('VALIDATION', '数据库名不能为空')
  }
  if (name.length > 64) {
    throw new AppError('VALIDATION', '数据库名长度不能超过 64 个字符')
  }
  if (name.includes('\u0000')) {
    throw new AppError('VALIDATION', '数据库名包含非法字符')
  }
  return name
}

/* ------------------------------------------------------------------ */
/* Numbers / strings                                                   */
/* ------------------------------------------------------------------ */

export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function toNumber(value: unknown, fallback = 0): number {
  return toNumberOrNull(value) ?? fallback
}

export function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

export function toStringValue(value: unknown, fallback = ''): string {
  return toStringOrNull(value) ?? fallback
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/* ------------------------------------------------------------------ */
/* Canonical JSON / hashing                                            */
/* ------------------------------------------------------------------ */

function nameOf(item: unknown): string {
  if (item && typeof item === 'object') {
    const name = (item as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return ''
}

export function sortByName<T>(items: T[]): T[] {
  return [...items].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
}

/**
 * Deterministic JSON serialisation: object keys are sorted recursively so the
 * same logical schema always produces the same hash, regardless of property
 * insertion order (mysql2 / information_schema ordering is not guaranteed).
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString()
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map((item) => walk(item))
    if (v instanceof Date) return v.toISOString()
    if (Buffer.isBuffer(v)) return v.toString('base64')
    const obj = v as Record<string, unknown>
    if (seen.has(obj)) return '[circular]'
    seen.add(obj)
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      const child = obj[key]
      if (child === undefined) continue
      out[key] = walk(child)
    }
    seen.delete(obj)
    return out
  }
  return JSON.stringify(walk(value))
}

/**
 * Canonical, hash-relevant view of a table. Shared by `hashTable`,
 * `hashSnapshot` and `diff` so all three agree on what "the same schema" means.
 */
export function canonicalTable(table: {
  name: string
  columns: unknown[]
  indexes: unknown[]
  foreignKeys: unknown[]
  primaryKey: string[]
}): unknown {
  return {
    name: table.name,
    columns: table.columns,
    indexes: sortByName(table.indexes),
    foreignKeys: sortByName(table.foreignKeys),
    primaryKey: table.primaryKey
  }
}

export function hashTableShape(table: {
  name: string
  columns: unknown[]
  indexes: unknown[]
  foreignKeys: unknown[]
  primaryKey: string[]
}): string {
  return sha256Hex(stableStringify(canonicalTable(table)))
}

/** Canonical snapshot view including metadata that is not part of a table hash. */
export function canonicalSnapshotTable(table: SchemaSnapshotTable): unknown {
  return {
    name: table.name,
    type: table.type,
    engine: table.engine ?? null,
    comment: table.comment ?? '',
    columns: table.columns,
    indexes: sortByName(table.indexes),
    foreignKeys: sortByName(table.foreignKeys),
    checkConstraints: sortByName(table.checkConstraints),
    primaryKey: table.primaryKey
  }
}

export function hashSnapshotShape(tables: SchemaSnapshotTable[]): string {
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name))
  return sha256Hex(stableStringify(sorted.map((t) => canonicalSnapshotTable(t))))
}

export function columnSignature(column: ColumnInfo): string {
  return stableStringify({
    name: column.name,
    dataType: column.dataType,
    columnType: column.columnType,
    nullable: column.nullable,
    defaultValue: column.defaultValue,
    isPrimaryKey: column.isPrimaryKey,
    isUnique: column.isUnique,
    isAutoIncrement: column.isAutoIncrement,
    isGenerated: column.isGenerated,
    comment: column.comment,
    ordinal: column.ordinal,
    charset: column.charset ?? null,
    collation: column.collation ?? null
  })
}

export function indexSignature(index: IndexInfo): string {
  return stableStringify({
    name: index.name,
    unique: index.unique,
    type: index.type,
    columns: index.columns,
    cardinality: index.cardinality ?? null
  })
}

export function foreignKeySignature(fk: ForeignKeyInfo): string {
  return stableStringify({
    name: fk.name,
    columns: fk.columns,
    referencedTable: fk.referencedTable,
    referencedColumns: fk.referencedColumns,
    onUpdate: fk.onUpdate,
    onDelete: fk.onDelete
  })
}

/* ------------------------------------------------------------------ */
/* Errors / cancellation                                               */
/* ------------------------------------------------------------------ */

interface DriverErrorLike {
  code?: string
  errno?: number
  sqlState?: string
  sqlMessage?: string
  message?: string
}

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_QUERY_TIMEOUT',
  'ER_LOCK_WAIT_TIMEOUT'
])

export function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as DriverErrorLike
  if (e.code && TIMEOUT_CODES.has(e.code)) return true
  const message = e.sqlMessage ?? e.message ?? ''
  return /(timed?\s*out|timeout|超时)/i.test(message)
}

const FATAL_CONNECTION_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ER_SERVER_SHUTDOWN',
  'ER_CONNECTION_KILLED',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT'
])

/** True when the underlying pooled connection is no longer usable. */
export function isFatalConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as DriverErrorLike).code
  return code !== undefined && FATAL_CONNECTION_CODES.has(code)
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string; code?: string; message?: string }
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return true
  return /aborted|abort|cancel(?:l)?ed/i.test(e.message ?? '')
}

export function throwIfAborted(signal?: AbortSignal, message = '操作已取消'): void {
  if (signal?.aborted) throw new AppError('CANCELLED', message)
}

/**
 * Map a driver / unknown error to a typed AppError with actionable hints.
 * This is intentionally exhaustive: database errors are never swallowed.
 */
export function mapDbError(error: unknown, context: string): AppError {
  if (isAppError(error)) return error
  if (isAbortError(error)) return new AppError('CANCELLED', `${context}：操作已取消`, { cause: error })

  const e = (error ?? {}) as DriverErrorLike
  const message = e.sqlMessage ?? e.message ?? String(error)
  const details = { errno: e.errno, rawCode: e.code, sqlState: e.sqlState }

  if (e.code === 'ER_ACCESS_DENIED_ERROR' || e.code === 'ER_DBACCESS_DENIED_ERROR') {
    return new AppError('PERMISSION_DENIED', `${context}：认证或授权失败（${message}）`, {
      details,
      hint: '请检查用户名/密码、主机访问授权（user@host）以及该账号是否拥有目标数据库权限。',
      cause: error
    })
  }
  if (e.code === 'ER_BAD_DB_ERROR') {
    return new AppError('NOT_FOUND', `${context}：数据库不存在（${message}）`, {
      details,
      hint: '请确认数据库名称，或先在服务器上创建该数据库。',
      cause: error
    })
  }
  if (isTimeoutError(error)) {
    return new AppError('TIMEOUT', `${context}：操作超时（${message}）`, {
      details,
      hint: '可增大执行/连接超时，或缩小查询范围后重试。',
      cause: error
    })
  }
  if (e.code === 'ER_CON_COUNT_ERROR') {
    return new AppError('CONNECTION_FAILED', `${context}：服务器连接数已满（${message}）`, {
      details,
      hint: '服务器 max_connections 已达上限，请稍后重试或调大该参数。',
      cause: error
    })
  }
  if (isFatalConnectionError(error)) {
    return new AppError('CONNECTION_FAILED', `${context}：数据库连接已断开（${message}）`, {
      details,
      hint: '连接已重建，请重试该操作（已执行语句的结果未知，请先核对数据）。',
      cause: error
    })
  }
  if (e.code === 'ER_PARSE_ERROR' || e.code === 'ER_SYNTAX_ERROR') {
    return new AppError('QUERY_FAILED', `${context}：SQL 语法错误（${message}）`, {
      details,
      hint: '请检查 SQL 语法与当前数据库版本是否兼容。',
      cause: error
    })
  }
  return toAppError(error)
}
