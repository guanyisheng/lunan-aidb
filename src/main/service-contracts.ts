/**
 * AIDB Studio - trusted main-process service contracts.
 *
 * All business logic lives behind these interfaces. Feature modules are wired
 * together in `src/main/container.ts`; IPC handlers only ever call services.
 */
import type {
  AgentBusyState,
  AgentEvent,
  AgentPlan,
  AgentRunRequest,
  AgentTask,
  AppSettings,
  ApprovalRequest,
  AuditEvent,
  AuditQuery,
  BackupCreateRequest,
  BackupRecord,
  BackupScope,
  BackupType,
  ChatMessage,
  ConnectionInput,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionTestResult,
  DatabaseInfo,
  ErrorCode,
  ExecutionResult,
  HistoryEntry,
  HistoryQuery,
  Id,
  IsoDate,
  JobEvent,
  ListResult,
  MemoryInput,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryStats,
  MemoryStatus,
  MemoryTrust,
  MemoryType,
  ModelDiscoverRequest,
  ModelDiscoverResult,
  ModelProfile,
  ModelProfileInput,
  ModelProviderKind,
  ModelTestResult,
  PageResult,
  Project,
  ProjectInput,
  ProjectStats,
  QueryColumn,
  QueryResultPage,
  RecoveryPlanSummary,
  RecoveryPoint,
  RecoveryPointStatus,
  RestoreJob,
  RestorePreview,
  RestorePreviewRequest,
  RiskLevel,
  SchemaChangeReport,
  SchemaDiff,
  SchemaSnapshot,
  SchemaSnapshotTable,
  StatementExecution,
  StatementRisk,
  SqlAnalysis,
  SqlExecuteRequest,
  SqlPlan,
  SqlPlanRequest,
  SqlStatementKind,
  TableDetails,
  TableSummary,
  ToolCall,
  ToolDefinition,
  UndoPreview
} from '@shared/types'
import type { EventMap } from '@shared/ipc'

/* ------------------------------------------------------------------ */
/* Cross-cutting infrastructure                                        */
/* ------------------------------------------------------------------ */

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  child(scope: string): Logger
}

export interface EventBus {
  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void
  on<K extends keyof EventMap>(type: K, listener: (payload: EventMap[K]) => void): () => void
  /** Optional sink installed by the Electron main process. */
  attach(sink: (type: string, payload: unknown) => void): void
}

export interface SecretStore {
  available(): boolean
  /** Encrypts and stores a secret. Returns the opaque ciphertext reference. */
  encrypt(plaintext: string): string | null
  /** Decrypts a stored ciphertext. */
  decrypt(cipher: string): string | null
  backend(): 'safeStorage' | 'memory'
}

export interface AuditService {
  record(event: Omit<AuditEvent, 'id' | 'ts'> & { ts?: IsoDate }): AuditEvent
  list(q: AuditQuery): PageResult<AuditEvent>
  export(q: AuditQuery & { format: 'json' | 'csv' }): { path: string; count: number }
  /** Redacts secrets from arbitrary text destined for logs / audits. */
  redact(text: string): string
}

export interface SettingsService {
  get(): AppSettings
  update(patch: Partial<AppSettings>): AppSettings
}

/* ------------------------------------------------------------------ */
/* Persistence (node:sqlite local store)                               */
/* ------------------------------------------------------------------ */

export interface ConnectionCredential {
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl: 'disabled' | 'preferred' | 'required'
  charset: string
  connectTimeoutMs: number
}

export interface ConnectionRecord extends ConnectionSummary {
  /** safeStorage ciphertext; never leaves the main process. */
  secretCipher: string | null
  /** Persisted so a saved connection keeps its timeout across restarts. */
  connectTimeoutMs: number
}

export interface ApprovalRecord extends ApprovalRequest {
  /** Hash of the SQL / operation the approval covers, to detect tampering. */
  planHash: string
  trigger: HistoryTrigger
}

export type HistoryTrigger = 'user' | 'agent' | 'system'

export interface MemoryUsagePatch {
  lastUsedAt: IsoDate
  useCountDelta: number
}

export interface MemorySearchRow extends MemoryRecord {}

export interface AppStore {
  readonly dbPath: string
  readonly schemaVersion: number
  close(): void

  /* settings + meta */
  getSettings(): AppSettings
  updateSettings(patch: Partial<AppSettings>): AppSettings
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void

  /* projects */
  listProjects(): Project[]
  getProject(id: Id): Project | null
  createProject(input: ProjectInput): Project
  updateProject(id: Id, patch: Partial<ProjectInput> & { schemaSnapshotId?: Id | null }): Project
  deleteProject(id: Id, deleteMemories: boolean): void
  touchProject(id: Id): void
  projectStats(id: Id): ProjectStats
  setProjectSnapshot(id: Id, snapshotId: Id | null): void

  /* connections */
  listConnectionRecords(): ConnectionRecord[]
  getConnectionRecord(id: Id): ConnectionRecord | null
  saveConnectionRecord(record: ConnectionRecord): ConnectionRecord
  deleteConnectionRecord(id: Id): void
  touchConnection(id: Id): void
  setConnectionLastState(id: Id, state: ConnectionStatus['state']): void

  /* schema snapshots */
  insertSchemaSnapshot(snapshot: SchemaSnapshot): SchemaSnapshot
  getSchemaSnapshot(id: Id, includeTables: boolean): SchemaSnapshot | null
  getLatestSchemaSnapshot(projectId: Id, includeTables: boolean): SchemaSnapshot | null
  listSchemaSnapshots(projectId: Id, limit: number): SchemaSnapshot[]

  /* execution history */
  insertHistory(entry: HistoryEntry): HistoryEntry
  updateHistory(id: Id, patch: Partial<HistoryEntry>): void
  getHistory(id: Id): HistoryEntry | null
  listHistory(q: HistoryQuery): PageResult<HistoryEntry>

  /* approvals */
  insertApproval(record: ApprovalRecord): ApprovalRecord
  getApproval(id: Id): ApprovalRecord | null
  getApprovalByPlan(planId: Id): ApprovalRecord | null
  listApprovals(q: { projectId?: Id; status?: ApprovalRecord['status']; limit?: number }): ApprovalRecord[]
  resolveApproval(id: Id, status: ApprovalRecord['status'], comment?: string): ApprovalRecord | null
  expireStaleApprovals(now: IsoDate): number

  /* memory */
  insertMemory(memory: MemoryRecord): MemoryRecord
  getMemory(id: Id): MemoryRecord | null
  updateMemory(id: Id, patch: Partial<MemoryRecord>): MemoryRecord
  deleteMemory(id: Id): void
  deleteMemoriesOfProject(projectId: Id): number
  listMemories(q: {
    projectId: Id
    types?: MemoryType[]
    status?: MemoryStatus
    trust?: MemoryTrust[]
    limit: number
    offset: number
  }): PageResult<MemoryRecord>
  listMemoriesForSearch(projectId: Id, types: MemoryType[] | undefined, includeStale: boolean, limit: number): MemoryRecord[]
  memoryStats(projectId: Id): MemoryStats
  bumpMemoryUsage(id: Id, delta: number): void
  expireMemories(projectId: Id, status: MemoryStatus, reason: string, onlyUntrusted: boolean): number

  /* agent tasks */
  insertTask(task: AgentTask): AgentTask
  updateTask(id: Id, patch: Partial<AgentTask>): AgentTask | null
  getTask(id: Id): AgentTask | null
  listTasks(q: { projectId?: Id; limit: number }): ListResult<AgentTask>
  deleteTask(id: Id): boolean

  /* jobs (backup / restore / verify progress) */
  insertJob<T extends { id: Id }>(table: 'restore_jobs', job: T): T
  updateJob(table: 'restore_jobs', id: Id, patch: Record<string, unknown>): void
  getJob(table: 'restore_jobs', id: Id): RestoreJob | null
  listRestoreJobs(q: { projectId?: Id; limit: number }): ListResult<RestoreJob>

  /* recovery points */
  insertRecoveryPoint(point: RecoveryPoint): RecoveryPoint
  updateRecoveryPoint(id: Id, patch: Partial<RecoveryPoint>): RecoveryPoint
  getRecoveryPoint(id: Id): RecoveryPoint | null
  listRecoveryPoints(q: { projectId?: Id; connectionId?: Id; limit: number }): ListResult<RecoveryPoint>
  countRecoveryPointsReferencingBackup(backupId: Id): number
  markRecoveryPointsExpired(ids: Id[]): number

  /* backups */
  insertBackup(backup: BackupRecord): BackupRecord
  updateBackup(id: Id, patch: Partial<BackupRecord>): BackupRecord
  getBackup(id: Id): BackupRecord | null
  listBackups(q: { projectId?: Id; connectionId?: Id; limit: number }): ListResult<BackupRecord>
  listExpiredBackups(now: IsoDate): BackupRecord[]

  /* model profiles */
  listModelProfiles(): ModelProfile[]
  getModelProfile(id: Id): ModelProfile | null
  saveModelProfile(profile: ModelProfile): ModelProfile
  deleteModelProfile(id: Id): void
  getModelSecretCipher(profileId: Id): string | null
  setModelSecretCipher(profileId: Id, cipher: string | null): void

  /* audit */
  insertAudit(event: AuditEvent): AuditEvent
  listAudit(q: AuditQuery): PageResult<AuditEvent>
}

/* ------------------------------------------------------------------ */
/* Database session / schema / execution                               */
/* ------------------------------------------------------------------ */

export interface QueryHandle {
  columns: QueryColumn[]
  rows: unknown[][]
  rowCount: number
  affectedRows: number
  insertId: number | null
  warnings: string[]
  durationMs: number
  truncated: boolean
}

export interface RawQueryResult<T = Record<string, unknown>> {
  rows: T[]
  columns: QueryColumn[]
  affectedRows: number
  insertId: number | null
  warnings: string[]
}

export interface DbSession {
  readonly connectionId: Id
  readonly database: string
  readonly serverFlavor: 'mysql' | 'mariadb' | 'unknown'
  readonly serverVersion: string
  readonly charset: string

  setDatabase(name: string): Promise<void>
  ping(): Promise<void>
  /** Raw SQL with optional placeholders; used by scanners / time machine / tools. */
  rawQuery<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RawQueryResult<T>>
  /** Guarded user-facing query with row limiting + column metadata. */
  query(
    sql: string,
    opts: { maxRows: number; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<QueryHandle>

  /* Explicit transaction control (used by the executor for DML). */
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  inTransaction(): boolean

  release(): Promise<void>
}

export interface ConnectionManager {
  list(): ConnectionSummary[]
  save(input: { id?: Id; input: ConnectionInput }): Promise<ConnectionSummary>
  remove(id: Id): Promise<void>
  test(input: { id?: Id; input: ConnectionInput }): Promise<ConnectionTestResult>
  connect(id: Id): Promise<ConnectionStatus>
  disconnect(id: Id): Promise<void>
  status(id: Id): Promise<ConnectionStatus>
  listDatabases(id: Id): Promise<DatabaseInfo[]>
  /** Opens (or reuses) a session. Throws AppError when unreachable. */
  openSession(id: Id, database?: string): Promise<DbSession>
  credential(id: Id): ConnectionCredential
  hasCredential(id: Id): boolean
  closeAll(): Promise<void>
}

export interface SchemaScanOptions {
  connectionId: Id
  database: string
  projectId?: Id | null
  includeRowCounts?: boolean
  includeSampleRows?: boolean
  sampling?: { allowed: boolean; maxRows: number; blockedColumns?: string[] }
  onProgress?: (p: { phase: string; message: string; progress: number }) => void
}

export interface SchemaService {
  listDatabases(session: DbSession): Promise<DatabaseInfo[]>
  listTables(session: DbSession, database: string): Promise<TableSummary[]>
  getTable(session: DbSession, database: string, table: string): Promise<TableDetails>
  scan(session: DbSession, options: SchemaScanOptions): Promise<SchemaSnapshot>
  hashTable(table: {
    name: string
    columns: unknown[]
    indexes: unknown[]
    foreignKeys: unknown[]
    primaryKey: string[]
  }): string
  hashSnapshot(tables: SchemaSnapshotTable[]): string
  diff(a: SchemaSnapshot, b: SchemaSnapshot): SchemaDiff
  /** Compares the stored snapshot with live schema; marks affected memories stale. */
  detectChanges(services: Services, projectId: Id): Promise<SchemaChangeReport>
}

export interface SqlRiskClassifier {
  splitStatements(sql: string): string[]
  classify(sql: string): SqlAnalysis
  classifyStatement(statement: string, index: number): StatementRisk
  estimateImpact(analysis: SqlAnalysis): { risk: RiskLevel; requiresApproval: boolean; requiresBackup: boolean }
}

/* ---------------------------- write protection --------------------- */

export interface ProtectionContext {
  session: DbSession
  database: string
  executionId: Id
  planId: Id
  projectId: Id | null
  connectionId: Id
  sql: string
  analysis: SqlAnalysis
  trigger: HistoryTrigger
  recoveryPlan: RecoveryPlanSummary
  settings: AppSettings
  emitProgress?: (p: { phase: string; message: string; progress: number }) => void
  signal?: AbortSignal
}

export interface ProtectionPreparation {
  recoveryPointId: Id | null
  backupId: Id | null
  warnings: string[]
  preparedAt: IsoDate
  /** implementation-private state */
  state: unknown
}

export interface CapturedBefore {
  /** implementation-private state */
  state: unknown
  warnings: string[]
  capturedRows: number
}

export interface ProtectionResult {
  recoveryPointId: Id | null
  backupId: Id | null
  warnings: string[]
  coverage: RecoveryPoint['coverage'] | null
}

/**
 * Write protection is implemented by the time-machine module and invoked by the
 * SQL executor. Contract:
 *  - prepare(): pre-flight, runs BEFORE any write statement. May create a
 *    verified full backup; MUST throw when a required backup cannot be produced
 *    (the executor then refuses to execute). Runs outside the transaction.
 *  - captureBefore(): inside the transaction, before a write statement.
 *  - captureAfter(): inside the transaction, after a write statement.
 *  - finalize(): after commit/rollback; persists the recovery point state.
 *  - abort(): on refusal / hard failure; cleans partial artifacts.
 */
export interface WriteProtection {
  prepare(ctx: ProtectionContext): Promise<ProtectionPreparation>
  captureBefore(
    ctx: ProtectionContext,
    prep: ProtectionPreparation,
    statement: StatementRisk
  ): Promise<CapturedBefore>
  captureAfter(
    ctx: ProtectionContext,
    prep: ProtectionPreparation,
    before: CapturedBefore,
    outcome: StatementExecution
  ): Promise<void>
  finalize(
    ctx: ProtectionContext,
    prep: ProtectionPreparation,
    result: ExecutionProtectionOutcome
  ): Promise<ProtectionResult>
  abort(ctx: ProtectionContext, prep: ProtectionPreparation | null, error: Error): Promise<void>
}

export interface ExecutionProtectionOutcome {
  ok: boolean
  transaction: ExecutorTransactionOutcome
  statements: StatementExecution[]
  error?: { code: ErrorCode; message: string }
}

export type ExecutorTransactionOutcome = 'none' | 'committed' | 'rolled_back' | 'implicit_ddl' | 'partial'

export interface ExecutorInput {
  sql: string
  analysis: SqlAnalysis
  database: string
  trigger: HistoryTrigger
  maxRows: number
  timeoutMs: number
}

export interface ExecutorHooks {
  protection?: WriteProtection
  protectionContext?: ProtectionContext
  signal?: AbortSignal
  onStatement?: (statement: StatementExecution, index: number) => void
}

export interface ExecutorResult {
  ok: boolean
  statements: StatementExecution[]
  result?: QueryResultPage
  transaction: ExecutorTransactionOutcome
  durationMs: number
  warnings: string[]
  protection?: ProtectionResult
  error?: { code: ErrorCode; message: string; details?: unknown }
}

export interface SqlExecutor {
  execute(session: DbSession, input: ExecutorInput, hooks?: ExecutorHooks): Promise<ExecutorResult>
  explain(
    session: DbSession,
    sql: string,
    database?: string
  ): Promise<{ columns: QueryColumn[]; rows: unknown[][] }>
  /** Estimates affected rows for a predicate via EXPLAIN; null when unreliable. */
  estimateRows(session: DbSession, sql: string): Promise<number | null>
}

/* ------------------------------------------------------------------ */
/* SQL execution service (plan / approval / execute orchestration)     */
/* ------------------------------------------------------------------ */

export interface SqlExecutionService {
  plan(req: SqlPlanRequest, trigger: HistoryTrigger): Promise<SqlPlan>
  execute(req: SqlExecuteRequest, trigger: HistoryTrigger): Promise<ExecutionResult>
  cancel(planId?: Id): { cancelled: boolean }
  getPlan(planId: Id): SqlPlan | null
  getApprovalForPlan(planId: Id): ApprovalRequest | null
  approve(planId: Id, comment?: string): ApprovalRequest
  deny(planId: Id, comment?: string): ApprovalRequest
  listPendingApprovals(projectId?: Id): ApprovalRequest[]
  activatePlan(planId: Id): void
  classify(sql: string): Promise<SqlAnalysis>
  explain(connectionId: Id, sql: string, database?: string): Promise<{ columns: QueryColumn[]; rows: unknown[][] }>
  listHistory(q: HistoryQuery): PageResult<HistoryEntry>
  getHistory(id: Id): HistoryEntry | null
  /** Read-only query helper shared by AI tools. */
  runReadonlyQuery(
    input: { connectionId: Id; database?: string; projectId?: Id | null; sql: string; maxRows?: number },
    trigger: HistoryTrigger
  ): Promise<ExecutionResult>
}

/* ------------------------------------------------------------------ */
/* Time machine                                                        */
/* ------------------------------------------------------------------ */

export interface RecoveryService {
  /** Builds the recovery plan summary shown to the user before execution. */
  buildPlan(input: {
    connectionId: Id
    projectId: Id | null
    database: string
    sql: string
    analysis: SqlAnalysis
    session: DbSession
    settings: AppSettings
  }): Promise<RecoveryPlanSummary>
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
  }): WriteProtection
  get(id: Id): RecoveryPoint | null
  list(q: { projectId?: Id; connectionId?: Id; limit?: number }): ListResult<RecoveryPoint>
  previewUndo(recoveryPointId: Id): Promise<UndoPreview>
  undo(recoveryPointId: Id, options: { confirmed: boolean; approvalId?: Id | null }): Promise<RestoreJob>
  refreshStatus(recoveryPointId: Id): Promise<RecoveryPoint>
}

export interface BackupService {
  create(
    req: BackupCreateRequest,
    ctx: { projectId?: Id | null; emitProgress?: (p: { phase: string; message: string; progress: number }) => void; signal?: AbortSignal }
  ): Promise<BackupRecord>
  verify(id: Id, opts: { restoreTest?: boolean }): Promise<BackupRecord>
  get(id: Id): BackupRecord | null
  list(q: { projectId?: Id; connectionId?: Id; limit?: number }): ListResult<BackupRecord>
  remove(id: Id, opts: { force?: boolean }): Promise<void>
  stats(projectId?: Id): {
    count: number
    totalBytes: number
    backupDir: string
    freeBytes: number
    retentionDays: number
    maxBackupBytes: number
    dumperAvailable: boolean
  }
  retentionSweep(): Promise<{ deleted: Id[]; freedBytes: number; skippedReferenced: Id[]; warnings: string[] }>
}

export interface RestoreService {
  preview(req: RestorePreviewRequest, trigger: HistoryTrigger): Promise<RestorePreview>
  toTempDatabase(req: { backupId: Id; projectId?: Id | null }, trigger: HistoryTrigger): Promise<RestoreJob>
  inPlace(
    req: { backupId: Id; approvalId?: Id | null; confirmed: boolean },
    trigger: HistoryTrigger
  ): Promise<RestoreJob>
  getJob(id: Id): RestoreJob | null
  listJobs(q: { projectId?: Id; limit?: number }): ListResult<RestoreJob>
}

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export interface MemoryService {
  search(q: MemorySearchQuery): Promise<MemorySearchHit[]>
  list(q: {
    projectId: Id
    types?: MemoryType[]
    status?: MemoryStatus
    trust?: MemoryTrust[]
    limit: number
    offset: number
  }): PageResult<MemoryRecord>
  get(id: Id): MemoryRecord | null
  create(input: MemoryInput): Promise<MemoryRecord>
  update(id: Id, patch: Partial<MemoryInput> & { status?: MemoryStatus }): MemoryRecord
  remove(id: Id): void
  confirm(id: Id, content?: string): MemoryRecord
  invalidate(id: Id, reason: string): MemoryRecord
  stats(projectId: Id): MemoryStats
  /** Marks schema-linked memories stale/invalid after a schema diff. */
  applySchemaDiff(projectId: Id, diff: SchemaDiff): Promise<{ invalidated: number; stale: number }>
  /** Generates / refreshes schema memory entries after a scan. */
  syncSchemaMemory(snapshot: SchemaSnapshot): Promise<{ created: number; updated: number }>
  /** Retrieval as used by agent tools (bounded, ranked). */
  searchForAgent(projectId: Id, query: string, limit?: number): Promise<MemorySearchHit[]>
  bumpUsage(ids: Id[]): void
  /** Auto-captures a task memory after a completed agent task. */
  recordTaskMemory(projectId: Id, payload: { title: string; content: string; refs?: MemoryRecord['refs']; trust?: MemoryTrust }): Promise<MemoryRecord>
}

/* ------------------------------------------------------------------ */
/* Models + agent                                                      */
/* ------------------------------------------------------------------ */

export interface ResolvedModel {
  profileId: Id | null
  kind: ModelProviderKind
  baseUrl: string
  model: string
  apiKey: string | null
  temperature: number
  maxTokens: number
  timeoutMs: number
  toolsEnabled: boolean
}

export interface ChatStreamOptions {
  tools?: ToolDefinition[]
  signal?: AbortSignal
  onDelta?: (delta: string) => void
  jsonMode?: boolean
}

export interface ChatCompletion {
  content: string
  toolCalls: ToolCall[]
  finishReason: string
  usage: { prompt: number; completion: number; total: number }
}

export interface ModelService {
  list(): ModelProfile[]
  save(input: ModelProfileInput): ModelProfile
  remove(id: Id): void
  setDefault(id: Id): ModelProfile[]
  /** Set default JEV / decision-model profile (settings only; does not clear Agent default). */
  setDefaultDecision(id: Id | null): ModelProfile[]
  /** Clone a profile including encrypted API key (no plaintext exposure). */
  duplicate(id: Id): ModelProfile
  test(id: Id): Promise<ModelTestResult>
  discover(req: ModelDiscoverRequest): Promise<ModelDiscoverResult>
  configPath(): string
  /** Restore profiles from the durable JSON mirror when the DB is empty. */
  hydrateFromConfigFile(): number
  resolve(profileId?: Id | null): ResolvedModel
  /**
   * Resolve JEV / decision model.
   * Prefer explicit profileId → settings.defaultDecision → first profile with `decision` role.
   * Returns null when none available (caller may skip review).
   */
  resolveDecision(profileId?: Id | null): ResolvedModel | null
  chat(model: ResolvedModel, messages: ChatMessage[], opts?: ChatStreamOptions): Promise<ChatCompletion>
}

export interface AgentService {
  run(req: AgentRunRequest): Promise<AgentTask>
  cancel(taskId: Id): void
  get(taskId: Id): AgentTask | null
  list(q: { projectId?: Id; limit: number }): ListResult<AgentTask>
  delete(taskId: Id): void
  respondToApproval(approvalId: Id, approved: boolean, comment?: string): void
  pendingApprovals(projectId?: Id): ApprovalRequest[]
  tools(): ToolDefinition[]
  /** True when a model profile is configured and reachable enough to start. */
  canRun(): { ok: boolean; reason?: string }
  /** In-flight agent tasks (optionally filtered by connection). */
  getBusyState(connectionId?: Id | null): AgentBusyState
}

/* ------------------------------------------------------------------ */
/* Service container                                                   */
/* ------------------------------------------------------------------ */

export interface Services {
  paths: {
    userData: string
    appDb: string
    backups: string
    recoveryPoints: string
    logs: string
    temp: string
    modelsConfig: string
  }
  logger: Logger
  store: AppStore
  settings: SettingsService
  secrets: SecretStore
  audit: AuditService
  events: EventBus
  connections: ConnectionManager
  schema: SchemaService
  classifier: SqlRiskClassifier
  executor: SqlExecutor
  execution: SqlExecutionService
  recovery: RecoveryService
  backups: BackupService
  restore: RestoreService
  memory: MemoryService
  models: ModelService
  agent: AgentService
}

/* ------------------------------------------------------------------ */
/* Helpers shared across modules                                       */
/* ------------------------------------------------------------------ */

export interface ProtectionArtifacts {
  beforeImagePath: string | null
  afterImagePath: string | null
  rowSets: unknown[]
}

export type { BackupScope, BackupType, JobEvent }
