/**
 * SQL formatting / value escaping helpers shared by the dumper, undo and
 * restore modules.
 *
 * Escaping is delegated to mysql2's battle-tested `escape`/`escapeId` instead
 * of hand-rolled string building: row values come from the live database and
 * may contain quotes, backslashes, binary data and unicode.
 */
import { escape as mysqlEscape, escapeId as mysqlEscapeId } from 'mysql2'

export function ident(name: string): string {
  return mysqlEscapeId(name)
}

export function qualified(database: string, table: string): string {
  return `${mysqlEscapeId(database)}.${mysqlEscapeId(table)}`
}

/** Escapes one JS value into a MySQL literal. */
export function escapeValue(value: unknown): string {
  if (value === undefined) return 'NULL'
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL'
    return String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  return mysqlEscape(value as Parameters<typeof mysqlEscape>[0])
}

export interface InsertBuildResult {
  sql: string
  rowCount: number
}

/**
 * Builds a multi-row INSERT statement. `tableRef` must already be an escaped
 * reference (usually just the table name - restore runs inside the target
 * database, so qualifying with the source database would write to the wrong
 * place when restoring into a temporary database).
 */
export function buildInsert(
  tableRef: string,
  columns: string[],
  rows: Record<string, unknown>[],
  startIndex: number,
  maxRows: number
): InsertBuildResult {
  const slice = rows.slice(startIndex, startIndex + maxRows)
  if (slice.length === 0) return { sql: '', rowCount: 0 }
  const colList = columns.map((c) => mysqlEscapeId(c)).join(', ')
  const tuples = slice.map((row) => {
    const values = columns.map((c) => escapeValue(row[c]))
    return `(${values.join(', ')})`
  })
  return {
    sql: `INSERT INTO ${tableRef} (${colList}) VALUES\n${tuples.join(',\n')};`,
    rowCount: slice.length
  }
}

/** Builds a parameterised WHERE fragment for a primary key. */
export function buildPkWhere(
  primaryKeyColumns: string[]
): { where: string; values: string[] } {
  const where = primaryKeyColumns
    .map((c) => `${mysqlEscapeId(c)} = ?`)
    .join(' AND ')
  return { where, values: [] }
}

export function pkValuesOf(
  row: Record<string, unknown>,
  primaryKeyColumns: string[]
): unknown[] {
  return primaryKeyColumns.map((c) => row[c])
}

/** Renders a row as a short human readable preview for undo SQL previews. */
export function previewRow(
  row: Record<string, unknown>,
  primaryKeyColumns: string[],
  maxColumns = 8
): string {
  const keys = Object.keys(row)
  const ordered = [
    ...primaryKeyColumns.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !primaryKeyColumns.includes(k))
  ].slice(0, maxColumns)
  return `{ ${ordered.map((k) => `${k}=${escapeValue(row[k])}`).join(', ')} }`
}

/** Escapes a column list for SELECT statements. */
export function columnList(columns: string[]): string {
  return columns.map((c) => mysqlEscapeId(c)).join(', ')
}
