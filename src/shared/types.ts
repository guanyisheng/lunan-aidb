/**
 * AIDB Studio - shared domain types.
 *
 * This module is imported by BOTH the main (trusted) process and the renderer.
 * It must stay free of Node.js / Electron / DOM imports.
 *
 * Design rules that every module must respect:
 *  - Secrets (DB passwords, API keys) NEVER cross this boundary in plaintext.
 *    Renderers only ever see `hasStoredPassword` / `apiKeyStored` booleans.
 *  - Renderers never receive a database handle. All SQL/backup/restore work is
 *    executed by the trusted main-process service layer.
 *  - Every AI/agent output is untrusted input: it is data, not instructions.
 */

export type Id = string
/** ISO-8601 timestamp, e.g. `2026-10-22T14:00:00.000Z` */
export type IsoDate = string

/* ------------------------------------------------------------------ */
/* App / environment                                                   */
/* ------------------------------------------------------------------ */

export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  chrome: string
  platform: NodeJS.Platform | string
  arch: string
  userDataPath: string
  appDbPath: string
  /** Durable JSON mirror of model profiles (no API keys). Survives restarts. */
  modelsConfigPath: string
  license: string
}

export interface AppPaths {
  userData: string
  appDb: string
  backups: string
  recoveryPoints: string
  logs: string
  temp: string
  modelsConfig: string
}

export interface HealthReport {
  ok: boolean
  appDb: { path: string; ok: boolean; migrations: number; error?: string }
  memoryDb: { path: string; ok: boolean; error?: string }
  backupDir: { path: string; writable: boolean; freeBytes: number }
  toolSupport: { mysqldump: boolean; mysqldumpVersion?: string }
  /** OS keychain / credential vault used for DB passwords and API keys. */
  secrets: { backend: 'safeStorage' | 'memory'; available: boolean }
}

export interface AppSettings {
  /** Automatically create recovery points / backups before risky writes. */
  autoProtection: boolean
  /** Require an explicit user approval before any write/DDL/restore. */
  requireApprovalForWrites: boolean
  /** Allow guarded sample-row reads during schema scan. */
  allowSampling: boolean
  maxSampleRows: number
  sqlTimeoutMs: number
  maxResultRows: number
  maxAgentSteps: number
  agentTimeoutMs: number
  /** Absolute directory used for full backups. Empty => app default. */
  backupDir: string
  retentionDays: number
  maxBackupBytes: number
  diskWarnBytes: number
  defaultModelProfileId: Id | null
  /** Default JEV / decision-model profile (reviews plans & conclusions). */
  defaultDecisionModelProfileId: Id | null
  theme: 'dark' | 'light' | 'system'
  /**
   * When true, JEV must return a confidence score; below `jevMinConfidence`
   * the agent regenerates the answer once (quality gate).
   */
  jevQualityGateEnabled: boolean
  /** 0–100. Effective only when `jevQualityGateEnabled` is true. */
  jevMinConfidence: number
}

/** Scopes for portable config import/export (no live DB passwords by default). */
export type ConfigExportScope = 'settings' | 'models' | 'connections' | 'projects' | 'all'

export interface ConfigBundle {
  format: 'lunan-aidb-config'
  version: 1
  exportedAt: IsoDate
  app: string
  scopes: ConfigExportScope[]
  settings?: Partial<AppSettings>
  models?: Array<Omit<ModelProfile, 'apiKeyStored'> & { apiKeyStored: boolean }>
  connections?: Array<{
    id: Id
    name: string
    host: string
    port: number
    user: string
    database: string
    ssl: SslMode
    charset?: string
    connectTimeoutMs?: number
    color?: string
    /** Never includes plaintext password in export. */
    hasPassword: boolean
  }>
  projects?: Array<{
    id: Id
    name: string
    description: string
    connectionId: Id | null
    databaseBriefMd?: string | null
  }>
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

export type SslMode = 'disabled' | 'preferred' | 'required'

export interface ConnectionInput {
  name: string
  host: string
  port: number
  user: string
  /** Only sent renderer -> main; never returned. Omit to keep stored one. */
  password?: string
  database?: string
  ssl?: SslMode
  charset?: string
  connectTimeoutMs?: number
  color?: string
}

export interface ConnectionSummary {
  id: Id
  name: string
  host: string
  port: number
  user: string
  database: string
  ssl: SslMode
  charset: string
  hasStoredPassword: boolean
  color?: string
  createdAt: IsoDate
  updatedAt: IsoDate
  lastUsedAt?: IsoDate
  lastState: ConnectionState
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnectionStatus {
  connectionId: Id
  state: ConnectionState
  serverVersion?: string
  serverComment?: string
  serverFlavor?: 'mysql' | 'mariadb' | 'unknown'
  latencyMs?: number
  connectedAt?: IsoDate
  error?: string
}

export interface ConnectionTestResult {
  ok: boolean
  latencyMs: number
  host: string
  serverVersion?: string
  serverFlavor?: 'mysql' | 'mariadb' | 'unknown'
  sslActive?: boolean
  error?: string
  hint?: string
}

export interface DatabaseInfo {
  name: string
  charset?: string
  collation?: string
  sizeBytes?: number
  tableCount?: number
  isSystem?: boolean
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export interface Project {
  id: Id
  name: string
  description: string
  connectionId: Id | null
  schemaSnapshotId: Id | null
  createdAt: IsoDate
  updatedAt: IsoDate
  lastOpenedAt?: IsoDate
  /**
   * Markdown brief bound to this project: what the DB/app does, key tables,
   * business terms. Injected into Agent context so the model can map
   * natural-language requests (e.g. 「id=1 的订单」) to real tables/columns.
   */
  databaseBriefMd?: string | null
  /** UI convenience counters, filled by project.list */
  memoryCount?: number
  historyCount?: number
}

export interface ProjectInput {
  name: string
  description?: string
  connectionId?: Id | null
  databaseBriefMd?: string | null
}

export interface ProjectStats {
  historyCount: number
  memoryCount: number
  backupCount: number
  recoveryPointCount: number
  agentTaskCount: number
  lastActivityAt?: IsoDate
  schemaSnapshotId?: Id | null
  schemaTakenAt?: IsoDate
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export type SchemaObjectType = 'table' | 'view'

export interface ColumnInfo {
  name: string
  dataType: string
  columnType: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  isUnique: boolean
  isAutoIncrement: boolean
  isGenerated: boolean
  comment: string
  ordinal: number
  charset?: string | null
  collation?: string | null
}

export interface IndexInfo {
  name: string
  unique: boolean
  type: string
  columns: string[]
  cardinality?: number | null
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  referencedTable: string
  referencedColumns: string[]
  onUpdate: string
  onDelete: string
}

export interface CheckConstraintInfo {
  name: string
  expression: string
}

export interface TriggerInfo {
  name: string
  timing: string
  event: string
  statement: string
}

export interface TableSummary {
  name: string
  type: SchemaObjectType
  engine?: string | null
  rowEstimate?: number | null
  dataLength?: number | null
  indexLength?: number | null
  comment: string
  charset?: string | null
  collation?: string | null
}

export interface TableDetails extends TableSummary {
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  checkConstraints: CheckConstraintInfo[]
  triggers: TriggerInfo[]
  primaryKey: string[]
  createSql?: string
  rowCount?: number | null
  schemaHash: string
}

export interface SchemaSnapshotTable {
  name: string
  type: SchemaObjectType
  engine?: string | null
  comment: string
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  checkConstraints: CheckConstraintInfo[]
  primaryKey: string[]
  schemaHash: string
}

export interface SchemaSnapshot {
  id: Id
  projectId: Id | null
  connectionId: Id
  database: string
  serverVersion: string
  serverFlavor: 'mysql' | 'mariadb' | 'unknown'
  charset: string
  takenAt: IsoDate
  schemaHash: string
  objectCount: number
  /** Full table bodies are stored but only returned by schema.latest when requested. */
  tables: SchemaSnapshotTable[]
  version: number
  /** Guarded metadata-only sampling results (never full business data). */
  sampled?: SampledData[]
}

export interface SampledData {
  table: string
  columns: string[]
  rows: unknown[][]
  limit: number
  reason: string
}

export interface SchemaDiffColumnChange {
  name: string
  before: ColumnInfo | null
  after: ColumnInfo | null
}

export interface SchemaDiffTableChange {
  name: string
  addedColumns: ColumnInfo[]
  removedColumns: ColumnInfo[]
  changedColumns: SchemaDiffColumnChange[]
  addedIndexes: IndexInfo[]
  removedIndexes: IndexInfo[]
  foreignKeysChanged: boolean
  primaryKeyChanged: boolean
}

export interface SchemaDiff {
  snapshotAId: Id
  snapshotBId: Id
  addedTables: string[]
  removedTables: string[]
  changedTables: SchemaDiffTableChange[]
  identical: boolean
  takenAtA: IsoDate
  takenAtB: IsoDate
}

export interface SchemaChangeReport {
  changed: boolean
  diff: SchemaDiff | null
  newSnapshot?: SchemaSnapshot
  invalidatedMemories: number
  staleMemories: number
}

export interface SchemaScanRequest {
  connectionId: Id
  database?: string
  projectId?: Id
  includeRowCounts?: boolean
  includeSampleRows?: boolean
}

/* ------------------------------------------------------------------ */
/* SQL risk classification                                             */
/* ------------------------------------------------------------------ */

export type SqlStatementKind =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'replace'
  | 'create'
  | 'alter'
  | 'drop'
  | 'truncate'
  | 'rename'
  | 'procedure'
  | 'transaction'
  | 'set'
  | 'show'
  | 'explain'
  | 'load'
  | 'grant'
  | 'unknown'

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical'

export type StatementCategory = 'read' | 'dml' | 'ddl' | 'destructive' | 'complex' | 'unknown'

export type RecoveryStrategy =
  | 'none'
  | 'before_image'
  | 'schema_snapshot'
  | 'full_backup'
  | 'refuse_unsafe'

export interface StatementRisk {
  statementIndex: number
  sql: string
  kind: SqlStatementKind
  category: StatementCategory
  risk: RiskLevel
  targetTables: string[]
  reasons: string[]
  requiresApproval: boolean
  requiresBackup: boolean
  recoveryStrategy: RecoveryStrategy
  /** null => unknown / cannot be estimated safely */
  estimatedRows: number | null
  parser: 'ast' | 'fallback'
  parseError?: string
  hasWhereClause?: boolean
  /** DDL implicit commit => transaction rollback cannot undo it. */
  implicitCommit?: boolean
  /* ---- details used by the write-protection (time machine) layer ---- */
  /** Single primary target table for DML/DDL statements (first target). */
  targetTable?: string | null
  /** AST-reserialised WHERE predicate (validated by re-parsing on execute). */
  whereSql?: string | null
  /** Column list of INSERT / UPDATE SET clauses when statically known. */
  columnList?: string[]
  /** Literal PK values of an INSERT when statically parseable. */
  pkValues?: Record<string, unknown> | null
  /** Statement text had no LIMIT and can affect unbounded rows. */
  unbounded?: boolean
  /** Number of inserted value tuples for INSERT/REPLACE. */
  valueTuples?: number | null
}

export interface SqlAnalysis {
  statements: StatementRisk[]
  overallRisk: RiskLevel
  requiresApproval: boolean
  requiresBackup: boolean
  readOnly: boolean
  summary: string
  analyzer: 'ast' | 'mixed' | 'fallback'
}

/* ------------------------------------------------------------------ */
/* SQL planning / execution                                            */
/* ------------------------------------------------------------------ */

export interface SqlPlanRequest {
  connectionId: Id
  sql: string
  database?: string
  projectId?: Id
  /** Optional explicit row limit for read queries. */
  maxRows?: number
}

export interface RecoveryPlanSummary {
  strategy: RecoveryStrategy
  needsBackup: boolean
  backupScope?: 'database' | 'tables'
  backupTables?: string[]
  reason: string
  estimatedAffectedRows: number | null
  beforeImageSupported: boolean
  warnings: string[]
}

export interface SqlPlan {
  planId: Id
  planHash: string
  connectionId: Id
  projectId: Id | null
  database: string
  sql: string
  analysis: SqlAnalysis
  recoveryPlan: RecoveryPlanSummary
  impact: {
    statementCount: number
    affectedTables: string[]
    estimatedRows: number | null
    risk: RiskLevel
  }
  requiresApproval: boolean
  requiresBackup: boolean
  approvalToken?: string
  createdAt: IsoDate
  expiresAt: IsoDate
}

export interface SqlExecuteRequest {
  planId: Id
  approvalToken?: string
  /** Must be true: explicit, deliberate execution request. */
  confirmed: boolean
  maxRows?: number
}

export interface StatementExecution {
  statementIndex: number
  sql: string
  kind: SqlStatementKind
  ok: boolean
  affectedRows: number
  insertId: number | null
  rowCount: number
  warnings: string[]
  durationMs: number
  error?: AppErrorPayload
  recoveryPointId?: Id
}

export interface QueryColumn {
  name: string
  typeName: string
  fieldType: number
  nullable?: boolean
  table?: string
  database?: string
}

export interface QueryResultPage {
  columns: QueryColumn[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  maxRows: number
}

/** phpMyAdmin-style table data browse (readonly SELECT with pagination). */
export interface TableBrowseRequest {
  connectionId: Id
  database: string
  table: string
  projectId?: Id | null
  /** 0-based row offset. */
  offset?: number
  /** Page size (capped by settings.maxResultRows). */
  limit?: number
  /** Prefer local cache even if the connection is free (still refreshes when missing). */
  preferCache?: boolean
  /** Force a live query; fails with CONFLICT when an AI task holds this connection. */
  forceLive?: boolean
}

export interface TableBrowseResult {
  sql: string
  offset: number
  limit: number
  execution: ExecutionResult
  /** Approximate total from information_schema when available. */
  estimatedTotal: number | null
  /** True when served from local disk cache (e.g. AI holding the live connection). */
  fromCache?: boolean
  /** ISO time when this page was last fetched live and cached locally. */
  cachedAt?: IsoDate
  /** Human-readable reason when returning cache instead of live data. */
  cacheReason?: string
}

export interface ExecutionResult {
  executionId: Id
  planId: Id
  ok: boolean
  statements: StatementExecution[]
  result?: QueryResultPage
  error?: AppErrorPayload
  durationMs: number
  recoveryPointId?: Id | null
  backupId?: Id | null
  auditEventId: Id
  warning?: string
  startedAt: IsoDate
  finishedAt: IsoDate
}

export interface HistoryEntry {
  id: Id
  projectId: Id | null
  connectionId: Id
  database: string
  sql: string
  kind: SqlStatementKind
  risk: RiskLevel
  status: 'planned' | 'running' | 'success' | 'failed' | 'cancelled' | 'denied'
  rowCount: number
  affectedRows: number
  durationMs: number
  executedAt: IsoDate
  recoveryPointId?: Id | null
  backupId?: Id | null
  auditEventId?: Id
  trigger: 'user' | 'agent' | 'system'
  error?: string
}

export interface HistoryQuery {
  projectId?: Id
  connectionId?: Id
  status?: HistoryEntry['status']
  risk?: RiskLevel
  limit?: number
  offset?: number
}

/* ------------------------------------------------------------------ */
/* Time machine: recovery points, backups, restore                     */
/* ------------------------------------------------------------------ */

export type RecoveryPointKind =
  | 'dml_before_image'
  | 'ddl_schema_snapshot'
  | 'full_backup'
  | 'partial'
  | 'none'

export type RecoveryPointStatus = 'ready' | 'partial' | 'unusable' | 'restored' | 'expired'

export interface CapturedRowSet {
  table: string
  primaryKeyColumns: string[]
  rowCount: number
  truncated: boolean
}

export interface RecoveryPoint {
  id: Id
  executionId: Id
  planId: Id
  projectId: Id | null
  connectionId: Id
  database: string
  kind: RecoveryPointKind
  strategy: RecoveryStrategy
  risk: RiskLevel
  targetTables: string[]
  beforeImagePath?: string | null
  afterImagePath?: string | null
  schemaSnapshotId?: Id | null
  backupId?: Id | null
  captured: CapturedRowSet[]
  createdAt: IsoDate
  status: RecoveryPointStatus
  verified: boolean
  verifiedAt?: IsoDate | null
  note: string
  sizeBytes: number
  checksum?: string | null
  /** Explicit truthfulness flags shown in the UI instead of a vague "backed up". */
  coverage: {
    hasOperationLog: true
    hasBeforeImage: boolean
    hasFullBackup: boolean
    backupVerified: boolean
  }
}

export type BackupType = 'full' | 'schema_only' | 'data_only'
export type BackupScope = 'database' | 'tables'
export type BackupTool = 'internal' | 'mysqldump'
export type BackupStatus =
  | 'creating'
  | 'completed'
  | 'verified'
  | 'restore_tested'
  | 'failed'
  | 'deleted'

export interface BackupVerification {
  fileExists: boolean
  nonEmpty: boolean
  checksumOk: boolean
  structureOk: boolean
  tableCount: number | null
  rowDataPresent: boolean
  verifiedAt?: IsoDate | null
  restoreTestedAt?: IsoDate | null
  tempDatabase?: string | null
  notes: string[]
}

export interface BackupRecord {
  id: Id
  projectId: Id | null
  connectionId: Id
  database: string
  scope: BackupScope
  tables: string[]
  type: BackupType
  tool: BackupTool
  filePath: string
  fileName: string
  fileSize: number
  checksumSha256: string
  schemaHash: string
  serverVersion: string
  status: BackupStatus
  verification: BackupVerification
  createdAt: IsoDate
  completedAt?: IsoDate | null
  error?: string | null
  retentionUntil?: IsoDate | null
  referencedByRecoveryPoints: number
}

export interface BackupCreateRequest {
  connectionId: Id
  projectId?: Id | null
  database: string
  scope: BackupScope
  tables?: string[]
  type?: BackupType
  verify?: boolean
  restoreTest?: boolean
  label?: string
}

export interface RestorePreviewRequest {
  backupId?: Id
  recoveryPointId?: Id
  connectionId: Id
  mode: 'to_temp_database' | 'in_place'
  targetDatabase?: string
  /** Environment prefix used for temp database names. */
  tempDatabase?: string
}

export interface RestorePreview {
  source: {
    kind: 'backup' | 'recovery_point'
    id: Id
    database: string
    tables: string[]
    createdAt: IsoDate
    verified: boolean
  }
  mode: 'to_temp_database' | 'in_place'
  targetDatabase: string
  tempDatabase?: string | null
  schemaCompatible: boolean
  schemaIssues: string[]
  objectConflicts: string[]
  overwriteRisk: 'none' | 'low' | 'high'
  lossEstimate: { table: string; rowsAtRisk: number | null; reason: string }[]
  requiresApproval: boolean
  warnings: string[]
  steps: string[]
  approvalToken?: string
}

export interface RestoreStep {
  index: number
  title: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped'
  detail?: string
  startedAt?: IsoDate
  finishedAt?: IsoDate
}

export interface RestoreConflict {
  table: string
  primaryKey: Record<string, unknown>
  kind: 'row_changed_since_recovery' | 'row_missing' | 'row_added' | 'duplicate_key'
  beforeValue?: Record<string, unknown> | null
  currentValue?: Record<string, unknown> | null
  recoveryValue?: Record<string, unknown> | null
  message?: string
}

export type RestoreJobStatus =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'partial'
  | 'cancelled'

export interface RestoreJob {
  id: Id
  mode: 'to_temp_database' | 'in_place' | 'undo_last'
  backupId?: Id | null
  recoveryPointId?: Id | null
  projectId: Id | null
  connectionId: Id
  sourceDatabase: string
  targetDatabase: string
  tempDatabase?: string | null
  status: RestoreJobStatus
  progress: number
  steps: RestoreStep[]
  conflicts: RestoreConflict[]
  startedAt: IsoDate
  finishedAt?: IsoDate | null
  error?: string | null
  /** Whether the database may be left in a partially restored state. */
  mayBePartial: boolean
  logPath?: string | null
  verification?: {
    tablesRestored: number
    rowsMatched: boolean | null
    passed: boolean
    notes: string[]
  } | null
}

export interface UndoChangeSet {
  table: string
  operation: 'insert' | 'update' | 'delete'
  primaryKeyColumns: string[]
  rows: {
    primaryKey: Record<string, unknown>
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
    conflicts: RestoreConflict[]
  }[]
  canApply: boolean
  blockedReason?: string
}

export interface UndoPreview {
  recoveryPoint: RecoveryPoint
  changeSets: UndoChangeSet[]
  conflicts: RestoreConflict[]
  canUndo: boolean
  requiresApproval: boolean
  warnings: string[]
  sqlPreview: string
}

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export type MemoryType = 'schema' | 'business' | 'user_confirmed' | 'task' | 'sql' | 'operation'
export type MemorySource = 'user' | 'agent' | 'schema_scan' | 'execution' | 'import'
export type MemoryTrust = 'user_confirmed' | 'verified' | 'ai_inferred' | 'unverified'
export type MemoryStatus = 'active' | 'stale' | 'invalid'

export interface MemoryRef {
  kind:
    | 'table'
    | 'column'
    | 'connection'
    | 'execution'
    | 'backup'
    | 'recovery_point'
    | 'task'
    | 'snapshot'
  id?: string
  database?: string
  table?: string
  column?: string
}

export interface MemoryRecord {
  id: Id
  projectId: Id
  type: MemoryType
  title: string
  content: string
  source: MemorySource
  trust: MemoryTrust
  confidence: number
  tags: string[]
  refs: MemoryRef[]
  schemaSnapshotId?: Id | null
  schemaHash?: string | null
  status: MemoryStatus
  verifiedBy?: 'user' | 'agent' | 'execution' | null
  verifiedAt?: IsoDate | null
  invalidatedReason?: string | null
  createdAt: IsoDate
  updatedAt: IsoDate
  lastUsedAt?: IsoDate | null
  useCount: number
  supersedesId?: Id | null
}

export interface MemoryInput {
  projectId: Id
  type: MemoryType
  title: string
  content: string
  trust?: MemoryTrust
  source?: MemorySource
  tags?: string[]
  refs?: MemoryRef[]
  confidence?: number
  schemaSnapshotId?: Id | null
  schemaHash?: string | null
}

export interface MemorySearchQuery {
  projectId: Id
  query: string
  types?: MemoryType[]
  limit?: number
  includeStale?: boolean
}

export interface MemorySearchHit {
  memory: MemoryRecord
  score: number
  reason: string
}

export interface MemoryStats {
  total: number
  byType: Record<MemoryType, number>
  byTrust: Record<MemoryTrust, number>
  stale: number
  invalid: number
  lastUpdatedAt?: IsoDate | null
}

/* ------------------------------------------------------------------ */
/* Models (online API + Ollama)                                        */
/* ------------------------------------------------------------------ */

export type ModelProviderKind = 'openai' | 'ollama'

/** agent = tool-using DB agent; decision = JEV reviewer (no tools). */
export type ModelRole = 'agent' | 'decision'

export interface ModelProfile {
  id: Id
  name: string
  kind: ModelProviderKind
  baseUrl: string
  model: string
  apiKeyStored: boolean
  temperature: number
  maxTokens: number
  timeoutMs: number
  toolsEnabled: boolean
  isDefault: boolean
  /** Role tags; a profile may be both agent and decision (JEV). */
  roles: ModelRole[]
  notes: string
  createdAt: IsoDate
  updatedAt: IsoDate
  lastTestAt?: IsoDate | null
  lastTestOk?: boolean | null
}

export interface ModelProfileInput {
  id?: Id
  name: string
  kind: ModelProviderKind
  baseUrl: string
  model: string
  /** Only ever main-process inbound; omit to keep the stored key. */
  apiKey?: string
  /**
   * When creating a new profile without `apiKey`, copy the encrypted secret
   * from this existing profile (duplicate flow — key never leaves main process).
   */
  copyApiKeyFromProfileId?: Id
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  toolsEnabled?: boolean
  isDefault?: boolean
  roles?: ModelRole[]
  notes?: string
}

export interface ModelTestResult {
  ok: boolean
  latencyMs: number
  model: string
  provider: ModelProviderKind
  sample?: string
  error?: string
  hint?: string
  toolSupport: 'supported' | 'unsupported' | 'unknown'
}

/** Request body for probing a provider's available model list. */
export interface ModelDiscoverRequest {
  baseUrl: string
  kind?: ModelProviderKind
  /** Optional plaintext key for this probe only; never persisted by discover. */
  apiKey?: string
  /** When editing, reuse the stored key for the given profile id. */
  profileId?: Id
  timeoutMs?: number
}

export interface DiscoveredModel {
  id: string
  ownedBy?: string
  created?: number
}

export interface ModelDiscoverResult {
  ok: boolean
  kind: ModelProviderKind
  baseUrl: string
  latencyMs: number
  models: DiscoveredModel[]
  /** Suggested model id to auto-fill (first chat-capable / first entry). */
  suggestedModel?: string
  /** Suggested display name for a new profile. */
  suggestedName?: string
  error?: string
  hint?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
  name?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  rawArguments?: string
}

/* ------------------------------------------------------------------ */
/* Agent                                                               */
/* ------------------------------------------------------------------ */

export type AgentTaskStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'max_steps_reached'
  | 'timed_out'

export type AgentPhase =
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'verification'
  | 'final'

export interface AgentStep {
  index: number
  phase: AgentPhase
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResultSummary?: string
  text?: string
  status: 'running' | 'ok' | 'failed' | 'denied'
  startedAt: IsoDate
  finishedAt?: IsoDate | null
  durationMs?: number
  error?: string
  /** True when the tool touched the database in a write capacity. */
  writeOperation?: boolean
}

export interface AgentPlan {
  summary: string
  steps: string[]
  risk: RiskLevel
  requiresApproval: boolean
  targets: string[]
  sql?: string
  recoveryPlan?: RecoveryPlanSummary
}

export interface ApprovalRequest {
  id: Id
  taskId?: Id | null
  planId: Id
  kind: 'execute_sql' | 'restore' | 'backup_delete' | 'run_tool'
  summary: string
  sql?: string
  targets: string[]
  risk: RiskLevel
  impact: string
  recoveryPlan?: RecoveryPlanSummary
  createdAt: IsoDate
  expiresAt: IsoDate
  status: 'pending' | 'approved' | 'denied' | 'expired'
  comment?: string
}

/** One bubble in an Agent conversation (multi-turn within a single task). */
export interface AgentChatTurn {
  id: Id
  role: 'user' | 'assistant'
  content: string
  createdAt: IsoDate
}

export interface AgentTask {
  id: Id
  projectId: Id
  connectionId: Id
  database: string
  title: string
  userMessage: string
  status: AgentTaskStatus
  modelProfileId: Id | null
  /** JEV / decision model used for reviews (null = unused). */
  decisionModelProfileId?: Id | null
  steps: AgentStep[]
  plan?: AgentPlan
  finalAnswer?: string
  error?: string
  createdAt: IsoDate
  updatedAt: IsoDate
  finishedAt?: IsoDate | null
  stepCount: number
  maxSteps: number
  toolCallCount: number
  tokenUsage?: { prompt: number; completion: number; total: number }
  approvals: ApprovalRequest[]
  contextBudget: { usedChars: number; limitChars: number }
  /** Full chat transcript; first user turn mirrors `userMessage`. */
  turns?: AgentChatTurn[]
}

export interface AgentRunRequest {
  projectId: Id
  connectionId: Id
  /** Target database; defaults to the connection's saved default when omitted. */
  database?: string
  message: string
  modelProfileId?: Id
  /** Optional JEV / decision model for plan & answer review. */
  decisionModelProfileId?: Id
  maxSteps?: number
  /**
   * Continue an existing finished task as a follow-up reply (same conversation).
   * When set, project/connection/database should match the task (or are taken from it).
   */
  taskId?: Id
}

/** Snapshot of in-flight Agent tasks that may occupy a DB connection. */
export interface AgentBusyState {
  busy: boolean
  tasks: Array<{
    id: Id
    title: string
    connectionId: Id
    database: string
    status: AgentTaskStatus
    updatedAt: IsoDate
  }>
}

export type ToolPermission = 'read' | 'write' | 'sensitive'

export interface JsonSchemaLite {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaLite>
  items?: JsonSchemaLite
  required?: string[]
  enum?: (string | number)[]
  additionalProperties?: boolean | JsonSchemaLite
  default?: unknown
  oneOf?: JsonSchemaLite[]
  anyOf?: JsonSchemaLite[]
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaLite
  permission: ToolPermission
  requiresApproval: boolean
  timeoutMs: number
}

/** Union of AI streamed events delivered over the single `agent.event` channel. */
export type AgentEvent =
  | { type: 'task.started'; taskId: Id; task: AgentTask }
  | { type: 'task.status'; taskId: Id; status: AgentTaskStatus; message?: string }
  | { type: 'assistant.delta'; taskId: Id; delta: string }
  | { type: 'assistant.message'; taskId: Id; content: string }
  | { type: 'step'; taskId: Id; step: AgentStep }
  | { type: 'plan'; taskId: Id; plan: AgentPlan }
  | { type: 'approval.required'; taskId: Id; approval: ApprovalRequest }
  | { type: 'approval.resolved'; taskId: Id; approvalId: Id; approved: boolean }
  | { type: 'task.finished'; taskId: Id; task: AgentTask }
  | { type: 'error'; taskId: Id; error: AppErrorPayload }

/* ------------------------------------------------------------------ */
/* Jobs / progress events                                              */
/* ------------------------------------------------------------------ */

export type JobKind = 'backup' | 'restore' | 'undo' | 'verify' | 'schema_scan' | 'agent'
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface JobEvent {
  jobId: Id
  kind: JobKind
  status: JobStatus
  phase: string
  message: string
  progress: number
  at: IsoDate
  error?: string
  meta?: Record<string, unknown>
}

export interface SchemaChangedEvent {
  projectId: Id
  connectionId: Id
  database: string
  diff: SchemaDiff
  invalidatedMemories: number
  at: IsoDate
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export type AuditActor = 'user' | 'agent' | 'system'

export interface AuditEvent {
  id: Id
  ts: IsoDate
  actor: AuditActor
  action: string
  projectId?: Id | null
  connectionId?: Id | null
  target?: string | null
  risk?: RiskLevel | null
  sqlPreview?: string | null
  outcome: 'success' | 'failure' | 'denied' | 'info'
  detail?: string | null
  metadata?: Record<string, unknown>
}

export interface AuditQuery {
  projectId?: Id
  connectionId?: Id
  actor?: AuditActor
  outcome?: AuditEvent['outcome']
  limit?: number
  offset?: number
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_DENIED'
  | 'CONNECTION_FAILED'
  | 'QUERY_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CONFLICT'
  | 'PROTECTION_FAILED'
  | 'UNSAFE_OPERATION'
  | 'BACKUP_FAILED'
  | 'RESTORE_FAILED'
  | 'MODEL_ERROR'
  | 'SECRET_ERROR'
  | 'INTERNAL'

export interface AppErrorPayload {
  code: ErrorCode
  message: string
  details?: unknown
  hint?: string
}

export type InvokeResult<T> = { ok: true; data: T } | { ok: false; error: AppErrorPayload }

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export interface ListResult<T> {
  items: T[]
  total: number
}

export interface PageResult<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}
