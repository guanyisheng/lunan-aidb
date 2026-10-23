/**
 * AIDB Studio - IPC contract (single source of truth).
 *
 * Security model:
 *  - The renderer talks to the main process through exactly ONE validated
 *    channel. Every method below is an explicit allow-list entry with a zod
 *    schema on the main side (`src/main/ipc/registry.ts` + handlers).
 *  - Unknown method names are rejected. Payloads are parsed, not trusted.
 *  - Secrets never appear in request/response shapes.
 */
import type {
  AgentBusyState,
  AgentRunRequest,
  AgentTask,
  ApprovalRequest,
  AppInfo,
  AppPaths,
  AppSettings,
  AuditEvent,
  AuditQuery,
  BackupCreateRequest,
  BackupRecord,
  ConfigBundle,
  ConfigExportScope,
  ConnectionInput,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionTestResult,
  DatabaseInfo,
  ExecutionResult,
  HealthReport,
  HistoryEntry,
  HistoryQuery,
  TableBrowseRequest,
  TableBrowseResult,
  Id,
  InvokeResult,
  ListResult,
  MemoryInput,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryStats,
  MemoryStatus,
  MemoryType,
  ModelDiscoverRequest,
  ModelDiscoverResult,
  ModelProfile,
  ModelProfileInput,
  ModelTestResult,
  PageResult,
  Project,
  ProjectInput,
  ProjectStats,
  RecoveryPoint,
  RestoreJob,
  RestorePreview,
  RestorePreviewRequest,
  RiskLevel,
  SchemaChangeReport,
  SchemaDiff,
  SchemaScanRequest,
  SchemaSnapshot,
  SqlAnalysis,
  SqlExecuteRequest,
  SqlPlan,
  SqlPlanRequest,
  TableDetails,
  ToolDefinition,
  UndoPreview,
  AgentEvent,
  JobEvent,
  SchemaChangedEvent,
  QueryColumn,
  ModelProviderKind,
  MemoryTrust,
  AuditActor,
  SslMode,
  BackupType,
  BackupScope,
  Project as ProjectT,
  ExecutionResult as ExecutionResultT
} from './types'

export const IPC_INVOKE_CHANNEL = 'aidb:invoke'
export const IPC_EVENT_CHANNEL = 'aidb:event'
export const IPC_BRIDGE_VERSION = '1'

/** Renderer -> main request/response map. */
export interface MethodMap {
  /* app ---------------------------------------------------------------- */
  'app.info': { req: void; res: AppInfo }
  'app.paths': { req: void; res: AppPaths }
  'app.health': { req: void; res: HealthReport }
  'app.settings.get': { req: void; res: AppSettings }
  'app.settings.update': { req: { patch: Partial<AppSettings> }; res: AppSettings }
  'app.dialog.chooseDirectory': { req: { title?: string; defaultPath?: string }; res: { dir: string | null } }
  'app.dialog.chooseFile': {
    req: { title?: string; filters?: { name: string; extensions: string[] }[] }
    res: { path: string | null }
  }
  'app.showItemInFolder': { req: { path: string }; res: void }
  'app.exportText': { req: { suggestedName: string; content: string }; res: { path: string | null } }
  'app.openExternal': { req: { url: string }; res: void }

  /* portable config ---------------------------------------------------- */
  /** Export selected scopes to a JSON file (no passwords / API keys). */
  'config.export': {
    req: { scopes: ConfigExportScope[] }
    res: { path: string | null; bundle: ConfigBundle | null }
  }
  /** Import from a JSON file previously exported by Lunan AIDB. */
  'config.import': {
    req: { scopes?: ConfigExportScope[]; path?: string }
    res: { imported: ConfigExportScope[]; warnings: string[]; path: string | null }
  }

  /* projects ----------------------------------------------------------- */
  'project.list': { req: void; res: Project[] }
  'project.create': { req: ProjectInput; res: Project }
  'project.update': { req: { id: Id; patch: Partial<ProjectInput> }; res: Project }
  'project.delete': { req: { id: Id; deleteMemories?: boolean }; res: { ok: true } }
  'project.open': {
    req: { id: Id }
    res: { project: Project; connection: ConnectionSummary | null; snapshot: SchemaSnapshot | null }
  }
  'project.stats': { req: { id: Id }; res: ProjectStats }
  /** Auto-fill database brief MD from schema (no LLM). */
  'project.generateBrief': {
    req: { id: Id; connectionId?: Id; database?: string; save?: boolean }
    res: { markdown: string; saved: boolean; tableCount: number; source: 'snapshot' | 'live' }
  }

  /* connections -------------------------------------------------------- */
  'conn.list': { req: void; res: ConnectionSummary[] }
  'conn.save': { req: { id?: Id; input: ConnectionInput }; res: ConnectionSummary }
  'conn.delete': { req: { id: Id }; res: void }
  'conn.test': { req: { id?: Id; input: ConnectionInput }; res: ConnectionTestResult }
  'conn.connect': { req: { id: Id }; res: ConnectionStatus }
  'conn.disconnect': { req: { id: Id }; res: void }
  'conn.status': { req: { id: Id }; res: ConnectionStatus }
  'conn.listDatabases': { req: { id: Id }; res: DatabaseInfo[] }

  /* schema ------------------------------------------------------------- */
  'schema.scan': { req: SchemaScanRequest; res: SchemaSnapshot }
  'schema.latest': { req: { projectId: Id; includeTables?: boolean }; res: SchemaSnapshot | null }
  'schema.snapshots': { req: { projectId: Id; limit?: number }; res: SchemaSnapshot[] }
  'schema.getTable': { req: { connectionId: Id; database: string; table: string }; res: TableDetails }
  'schema.listTables': { req: { connectionId: Id; database: string }; res: { tables: string[]; views: string[] } }
  'schema.listDatabases': { req: { connectionId: Id }; res: DatabaseInfo[] }
  'schema.diff': { req: { snapshotAId: Id; snapshotBId: Id }; res: SchemaDiff }
  'schema.detectChanges': { req: { projectId: Id }; res: SchemaChangeReport }

  /* table browse (phpMyAdmin-style readonly data view) ----------------- */
  'table.browse': { req: TableBrowseRequest; res: TableBrowseResult }

  /* sql ---------------------------------------------------------------- */
  'sql.plan': { req: SqlPlanRequest; res: SqlPlan }
  'sql.execute': { req: SqlExecuteRequest; res: ExecutionResult }
  'sql.cancel': { req: { planId?: Id }; res: { cancelled: boolean } }
  'sql.classify': { req: { sql: string }; res: SqlAnalysis }
  'sql.explain': {
    req: { connectionId: Id; sql: string; database?: string }
    res: { columns: QueryColumn[]; rows: unknown[][] }
  }
  'sql.history.list': { req: HistoryQuery; res: PageResult<HistoryEntry> }
  'sql.history.get': { req: { id: Id }; res: HistoryEntry | null }

  /* approvals ---------------------------------------------------------- */
  'approval.pending': { req: { projectId?: Id }; res: ApprovalRequest[] }
  'approval.approve': { req: { planId: Id; comment?: string }; res: ApprovalRequest }
  'approval.deny': { req: { planId: Id; comment?: string }; res: ApprovalRequest }

  /* memory ------------------------------------------------------------- */
  'memory.list': {
    req: {
      projectId: Id
      types?: MemoryType[]
      status?: MemoryStatus
      trust?: MemoryTrust[]
      limit?: number
      offset?: number
    }
    res: PageResult<MemoryRecord>
  }
  'memory.search': { req: MemorySearchQuery; res: MemorySearchHit[] }
  'memory.get': { req: { id: Id }; res: MemoryRecord | null }
  'memory.create': { req: MemoryInput; res: MemoryRecord }
  'memory.update': {
    req: { id: Id; patch: Partial<MemoryInput> & { status?: MemoryStatus } }
    res: MemoryRecord
  }
  'memory.delete': { req: { id: Id }; res: void }
  'memory.confirm': { req: { id: Id; content?: string }; res: MemoryRecord }
  'memory.invalidate': { req: { id: Id; reason: string }; res: MemoryRecord }
  'memory.stats': { req: { projectId: Id }; res: MemoryStats }

  /* models ------------------------------------------------------------- */
  'model.list': { req: void; res: ModelProfile[] }
  'model.save': { req: ModelProfileInput; res: ModelProfile }
  'model.delete': { req: { id: Id }; res: void }
  'model.test': { req: { id: Id }; res: ModelTestResult }
  'model.setDefault': { req: { id: Id }; res: ModelProfile[] }
  'model.setDefaultDecision': { req: { id: Id | null }; res: ModelProfile[] }
  'model.duplicate': { req: { id: Id }; res: ModelProfile }
  'model.discover': { req: ModelDiscoverRequest; res: ModelDiscoverResult }
  'model.configPath': { req: void; res: { path: string } }

  /* agent -------------------------------------------------------------- */
  'agent.run': { req: AgentRunRequest; res: { task: AgentTask } }
  'agent.cancel': { req: { taskId: Id }; res: void }
  'agent.task.get': { req: { taskId: Id }; res: AgentTask | null }
  'agent.task.list': { req: { projectId?: Id; limit?: number }; res: ListResult<AgentTask> }
  'agent.task.delete': { req: { taskId: Id }; res: { ok: true } }
  'agent.approval.respond': { req: { approvalId: Id; approved: boolean; comment?: string }; res: void }
  'agent.tools.list': { req: void; res: ToolDefinition[] }
  'agent.busy': { req: { connectionId?: Id } | undefined; res: AgentBusyState }

  /* backups ------------------------------------------------------------ */
  'backup.create': { req: BackupCreateRequest; res: BackupRecord }
  'backup.list': {
    req: { projectId?: Id; connectionId?: Id; limit?: number }
    res: ListResult<BackupRecord>
  }
  'backup.get': { req: { id: Id }; res: BackupRecord | null }
  'backup.verify': { req: { id: Id; restoreTest?: boolean }; res: BackupRecord }
  'backup.delete': { req: { id: Id; force?: boolean }; res: void }
  'backup.stats': {
    req: { projectId?: Id }
    res: {
      count: number
      totalBytes: number
      backupDir: string
      freeBytes: number
      retentionDays: number
      maxBackupBytes: number
      dumperAvailable: boolean
    }
  }

  /* recovery / time machine ------------------------------------------- */
  'recovery.list': {
    req: { projectId?: Id; connectionId?: Id; limit?: number }
    res: ListResult<RecoveryPoint>
  }
  'recovery.get': { req: { id: Id }; res: RecoveryPoint | null }
  'recovery.previewUndo': { req: { recoveryPointId: Id }; res: UndoPreview }
  'recovery.undo': { req: { recoveryPointId: Id; approvalToken?: string; confirmed: boolean }; res: RestoreJob }
  'recovery.previewRestore': { req: RestorePreviewRequest; res: RestorePreview }
  'recovery.restoreToTemp': {
    req: { backupId: Id; projectId?: Id }
    res: RestoreJob
  }
  'recovery.restoreInPlace': {
    req: { backupId: Id; approvalToken: string; confirmed: boolean }
    res: RestoreJob
  }
  'recovery.job.get': { req: { jobId: Id }; res: RestoreJob | null }
  'recovery.job.list': {
    req: { projectId?: Id; limit?: number }
    res: ListResult<RestoreJob>
  }

  /* audit -------------------------------------------------------------- */
  'audit.list': { req: AuditQuery; res: PageResult<AuditEvent> }
  'audit.export': {
    req: { projectId?: Id; format: 'json' | 'csv' }
    res: { path: string | null; count: number }
  }
}

export type MethodName = keyof MethodMap
export type MethodReq<K extends MethodName> = MethodMap[K]['req']
export type MethodRes<K extends MethodName> = MethodMap[K]['res']

/** Main -> renderer push events (single channel, discriminated by `type`). */
export interface EventMap {
  'agent.event': AgentEvent
  'job.event': JobEvent
  'conn.state': ConnectionStatus
  'audit.event': AuditEvent
  'schema.changed': SchemaChangedEvent
}

export type EventName = keyof EventMap

export interface AidbBridge {
  readonly version: string
  readonly platform: string
  invoke<K extends MethodName>(method: K, payload: MethodMap[K]['req']): Promise<InvokeResult<MethodMap[K]['res']>>
  on<K extends EventName>(type: K, listener: (payload: EventMap[K]) => void): () => void
  /** Returns a promise resolved to `InvokeResult` rather than throwing, used by UI helpers. */
  invokeSafe<K extends MethodName>(
    method: K,
    payload: MethodMap[K]['req']
  ): Promise<InvokeResult<MethodMap[K]['res']>>
}

export type { ProjectT, ExecutionResultT }
