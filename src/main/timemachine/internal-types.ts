/**
 * Time machine - internal (non-IPC) types.
 *
 * These types describe the on-disk image/backup formats produced by this
 * module. They are deliberately NOT part of the shared IPC contract: the
 * renderer never needs the raw row data of a recovery point, only the
 * RecoveryPoint metadata. Keeping them here makes the trust boundary obvious.
 */
import type { BackupScope, BackupTool, BackupType } from '@shared/types'

/** Current version of the logical backup file format. */
export const BACKUP_FORMAT_VERSION = 1 as const
/** Current version of the recovery-point image files. */
export const IMAGE_FORMAT_VERSION = 1 as const

export const BACKUP_HEADER = '-- AIDB-BACKUP v1'
export const BACKUP_META_PREFIX = '-- AIDB-META '
export const BACKUP_END = '-- AIDB-END'

export type ServerFlavor = 'mysql' | 'mariadb' | 'unknown'

/**
 * Metadata embedded in the backup header. It is written by the trusted main
 * process and read back during verification; it is never trusted blindly -
 * every field is cross-checked against the actual file contents.
 */
export interface BackupManifestV1 {
  version: typeof BACKUP_FORMAT_VERSION
  /** Marker so an unrelated .sql file cannot be mistaken for an AIDB backup. */
  format: 'aidb-backup'
  database: string
  scope: BackupScope
  type: BackupType
  tool: BackupTool
  /** Base tables included in the dump (views are listed separately). */
  tables: string[]
  views: string[]
  /** Every dumped object with its type, used for structure verification. */
  objects: { name: string; type: 'table' | 'view' }[]
  /** Rows actually written to the dump, per base table. */
  rowCounts: Record<string, number>
  /** COUNT(*) measured before streaming the data (detects concurrent writes). */
  countedRows: Record<string, number>
  /** Column names per base table, used for restore schema compatibility checks. */
  columnsByTable?: Record<string, string[]>
  /** Primary key columns per base table. */
  primaryKeysByTable?: Record<string, string[]>
  totalRows: number
  schemaHash: string
  serverVersion: string
  serverFlavor: ServerFlavor
  charset: string
  startedAt: string
  finishedAt: string
  dumper: string
  warnings: string[]
}

/** Result of writing a dump file. */
export interface DumpResult {
  filePath: string
  fileName: string
  fileSize: number
  checksumSha256: string
  manifest: BackupManifestV1
  startedAt: string
  finishedAt: string
}

export interface DumpOptions {
  database: string
  filePath: string
  scope: BackupScope
  type: BackupType
  /** Restrict to these base tables (scope=table). */
  tables?: string[]
  tool?: BackupTool
  batchSize?: number
  maxBatchBytes?: number
  onProgress?: (p: { phase: string; message: string; progress: number }) => void
  signal?: AbortSignal
  logger?: { debug(m: string, meta?: Record<string, unknown>): void; warn(m: string, meta?: Record<string, unknown>): void }
}

/* ------------------------------------------------------------------ */
/* Recovery point images                                               */
/* ------------------------------------------------------------------ */

/** A row with its column-name mapping, as returned by `SELECT *`. */
export type RowImage = Record<string, unknown>

export interface ImageStatement {
  statementIndex: number
  kind: string
  targetTable: string | null
  /** AST-reserialised predicate; null means "no WHERE / all rows". */
  whereSql: string | null
  primaryKeyColumns: string[]
  /** Rows as they were before the statement (empty for INSERT). */
  beforeRows: RowImage[]
  /** Rows as they are after the statement (empty for DELETE / DDL). */
  afterRows: RowImage[]
  /** Primary keys of rows touched by the statement (before + after). */
  primaryKeys: RowImage[]
  /** True when the capture was capped or the affected set could not be determined. */
  partial: boolean
  warnings: string[]
  affectedRows?: number
}

export interface SchemaImage {
  /** SHOW CREATE TABLE/VIEW output before the DDL. */
  before: Record<string, string>
  /** SHOW CREATE TABLE/VIEW output after the DDL (may be empty on failure). */
  after: Record<string, string>
  /** DDL implicitly commits; a transaction rollback can never undo this. */
  implicitCommit: true
}

export interface RecoveryImageFileV1 {
  version: typeof IMAGE_FORMAT_VERSION
  format: 'aidb-recovery-image'
  recoveryPointId: string
  executionId: string
  planId: string
  connectionId: string
  projectId: string | null
  database: string
  kind: 'before' | 'after'
  capturedAt: string
  statements: ImageStatement[]
  /** Only present for DDL schema snapshots. */
  schema?: SchemaImage
  /** Truthfulness: was anything captured incompletely? */
  partial: boolean
  warnings: string[]
}

/** Internal protection state carried through the WriteProtection contract. */
export interface CapturePlan {
  statementIndex: number
  kind: string
  targetTable: string | null
  whereSql: string | null
  primaryKeyColumns: string[]
  /** True when the table has no usable primary key. */
  noUsablePrimaryKey: boolean
  /** True when a trigger on the table makes before-image-only undo unreliable. */
  hasTriggers: boolean
  /** How many rows the capture is expected to touch (null = unknown). */
  estimatedRows: number | null
  warnings: string[]
}

export interface ProtectionState {
  recoveryPointId: string
  database: string
  strategy: string
  plans: CapturePlan[]
  /** Backup created in prepare(), before the transaction starts. */
  backupId: string | null
  backupVerified: boolean
  backupWarnings: string[]
  /** Set when capture exceeded the cap and a backup was created as a fallback. */
  upgradedToBackup: boolean
  before: ImageStatement[]
  after: ImageStatement[]
  /** DDL schema snapshot captured before execution. */
  schemaBefore: Record<string, string> | null
  schemaAfter: Record<string, string> | null
  warnings: string[]
  /** True when any capture was truncated / not reliable. */
  partial: boolean
  startedAt: string
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

export interface TableMeta {
  name: string
  type: 'table' | 'view'
  engine: string | null
  columns: {
    name: string
    dataType: string
    columnType: string
    generated: boolean
    autoIncrement: boolean
  }[]
  primaryKey: string[]
  triggers: string[]
}

/** Subset of mysql2 escape helpers used across the module (typed locally). */
export type Escaper = {
  escape(value: unknown): string
  escapeId(value: string): string
}
