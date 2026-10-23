/**
 * AIDB Studio - metadata SQL shared by the connection manager and schema service.
 *
 * Security decision: database metadata is always read from `information_schema`
 * (never from business tables). These queries are read-only and only expose
 * objects the connected server account is allowed to see.
 */
import type { DatabaseInfo } from '@shared/types'
import { toNumber, toStringValue } from './internal'

/** Schemas that are always treated as server/system schemas. */
export const SYSTEM_DATABASES: ReadonlySet<string> = new Set([
  'mysql',
  'information_schema',
  'performance_schema',
  'sys'
])

/**
 * MariaDB encodes filesystem names that start with `.` as `#mysql50#.<name>`.
 * On macOS volumes that emit AppleDouble `._*` sidecars next to real tables /
 * databases, those show up in `information_schema` and break metadata queries
 * with "Incorrect table name '#mysql50#._…'". Skip them everywhere.
 */
export function isFilesystemArtifactName(name: string): boolean {
  if (!name) return true
  if (name.startsWith('.')) return true
  if (name.startsWith('#mysql50#.')) return true
  // Encoded form of AppleDouble: `#mysql50#._foo` → artifact for real object `foo`.
  if (name.includes('#mysql50#._')) return true
  return false
}

/** SQL predicate fragment: keep only real user/system objects. */
export const REAL_TABLE_NAME_SQL = `t.TABLE_NAME NOT LIKE '.%' AND t.TABLE_NAME NOT LIKE '#mysql50#.%'`

export const DATABASE_LIST_SQL = `SELECT
    s.SCHEMA_NAME AS name,
    s.DEFAULT_CHARACTER_SET_NAME AS charset,
    s.DEFAULT_COLLATION_NAME AS collation,
    COALESCE(SUM(CASE WHEN t.TABLE_TYPE = 'BASE TABLE' THEN 1 ELSE 0 END), 0) AS tableCount,
    COALESCE(SUM(COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0)), 0) AS sizeBytes
  FROM information_schema.SCHEMATA AS s
  LEFT JOIN information_schema.TABLES AS t
    ON t.TABLE_SCHEMA = s.SCHEMA_NAME
   AND ${REAL_TABLE_NAME_SQL}
  WHERE s.SCHEMA_NAME NOT LIKE '.%'
    AND s.SCHEMA_NAME NOT LIKE '#mysql50#.%'
  GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME
  ORDER BY s.SCHEMA_NAME`

export function mapDatabaseRows(rows: Record<string, unknown>[]): DatabaseInfo[] {
  return rows
    .map((row) => {
      const name = toStringValue(row.name)
      return {
        name,
        charset: toStringValue(row.charset) || undefined,
        collation: toStringValue(row.collation) || undefined,
        sizeBytes: toNumber(row.sizeBytes, 0),
        tableCount: toNumber(row.tableCount, 0),
        isSystem: SYSTEM_DATABASES.has(name.toLowerCase())
      }
    })
    .filter((row) => !isFilesystemArtifactName(row.name))
}
