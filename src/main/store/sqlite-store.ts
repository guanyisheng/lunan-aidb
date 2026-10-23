/**
 * AIDB Studio - local SQLite persistence.
 *
 * The single source of truth for all locally persisted state. Backed by the
 * built-in `node:sqlite` module (Electron 45 bundles Node 22/24 with SQLite
 * compiled in), so the app ships without any native module rebuilds.
 *
 * Design rules (see task / service-contracts):
 *  - `AppStore` in `src/main/service-contracts.ts` is the authoritative
 *    contract; this file only implements it.
 *  - SQL is always parameterised. Table / column names are hard-coded string
 *    literals in this file (never interpolated from caller input), so dynamic
 *    WHERE/SET clauses cannot be used for SQL injection.
 *  - Column names are snake_case, domain objects are camelCase. Every mapper
 *    between the two lives in this file.
 *  - Complex values (arrays / objects) are stored as JSON TEXT and only
 *    serialised / parsed at the mapper boundary.
 *  - All timestamps are ISO-8601 strings so plain lexicographic ordering on the
 *    TEXT columns is a valid time ordering.
 *  - Schema upgrades go through `PRAGMA user_version` + an ordered migration
 *    array; every migration runs in its own transaction.
 *  - Every DB failure is converted to `AppError('INTERNAL')` with operation /
 *    table context. Message text never includes parameter values, so secrets
 *    (DB passwords, API keys) cannot leak through error paths.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  AgentTask,
  AppSettings,
  ApprovalRequest,
  AuditEvent,
  AuditQuery,
  BackupRecord,
  ConnectionState,
  HistoryEntry,
  HistoryQuery,
  Id,
  IsoDate,
  ListResult,
  MemoryRecord,
  MemoryStats,
  MemoryStatus,
  MemoryTrust,
  MemoryType,
  ModelProfile,
  PageResult,
  Project,
  ProjectInput,
  ProjectStats,
  RecoveryPoint,
  RecoveryPlanSummary,
  RestoreJob,
  RiskLevel,
  SampledData,
  SchemaSnapshot,
  SchemaSnapshotTable,
  SslMode
} from '../../shared/types'
import type { AppStore, ApprovalRecord, ConnectionRecord, HistoryTrigger } from '../service-contracts'
import { AppError, isAppError } from '../util/errors'
import { newId } from '../util/id'
import { nowIso } from '../util/time'

/* ------------------------------------------------------------------ */
/* Low level types + scalar helpers                                    */
/* ------------------------------------------------------------------ */

/** Values accepted by node:sqlite bindings (booleans are stored as 0/1). */
type SqlValue = string | number | bigint | null
/** Raw row shape returned by node:sqlite (null-prototype records). */
type Row = Record<string, unknown>

type Encoder = (value: unknown) => SqlValue
interface FieldSpec {
  column: string
  encode: Encoder
}
type FieldMap = Record<string, FieldSpec>

const encText: Encoder = (v) => (v === null || v === undefined ? null : String(v))
const encInteger: Encoder = (v) => asInt(v, 0)
const encNumber: Encoder = (v) => asNumber(v, 0)
const encBool: Encoder = (v) => (v ? 1 : 0)
const encJson: Encoder = (v) => (v === undefined ? null : JSON.stringify(v))
const encJsonOrNull: Encoder = (v) => (v === null || v === undefined ? null : JSON.stringify(v))

function asText(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

function asNullableText(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
  if (typeof v === 'bigint') return Number(v)
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function asInt(v: unknown, fallback = 0): number {
  const n = asNumber(v, fallback)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function asBool(v: unknown): boolean {
  return asNumber(v, 0) !== 0
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = asInt(value, fallback)
  return Math.min(max, Math.max(min, n))
}

/** Small helper to build optional scalar filters for dynamic WHERE clauses. */
function buildWhere(parts: Array<[string, SqlValue | undefined]>): { sql: string; params: SqlValue[] } {
  const clauses: string[] = []
  const params: SqlValue[] = []
  for (const [clause, value] of parts) {
    if (value === undefined) continue
    clauses.push(clause)
    params.push(value)
  }
  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params }
}

/* ------------------------------------------------------------------ */
/* Row -> domain mappers                                               */
/* ------------------------------------------------------------------ */

function projectFromRow(r: Row): Project {
  const project: Project = {
    id: asText(r.id),
    name: asText(r.name),
    description: asText(r.description),
    connectionId: asNullableText(r.connection_id),
    schemaSnapshotId: asNullableText(r.schema_snapshot_id),
    createdAt: asText(r.created_at),
    updatedAt: asText(r.updated_at)
  }
  const lastOpenedAt = asNullableText(r.last_opened_at)
  if (lastOpenedAt !== null) project.lastOpenedAt = lastOpenedAt
  const brief = asNullableText(r.database_brief_md)
  if (brief !== null) project.databaseBriefMd = brief
  else project.databaseBriefMd = null
  if (r.memory_count !== undefined) project.memoryCount = asInt(r.memory_count, 0)
  if (r.history_count !== undefined) project.historyCount = asInt(r.history_count, 0)
  return project
}

function connectionFromRow(r: Row): ConnectionRecord {
  const record: ConnectionRecord = {
    id: asText(r.id),
    name: asText(r.name),
    host: asText(r.host),
    port: asNumber(r.port, 3306),
    user: asText(r.user_name),
    database: asText(r.database_name),
    ssl: (asText(r.ssl) || 'preferred') as SslMode,
    charset: asText(r.charset) || 'utf8mb4',
    hasStoredPassword: asBool(r.has_stored_password),
    connectTimeoutMs: asInt(r.connect_timeout_ms, 10000),
    createdAt: asText(r.created_at),
    updatedAt: asText(r.updated_at),
    lastState: (asText(r.last_state) || 'disconnected') as ConnectionState,
    secretCipher: asNullableText(r.secret_cipher)
  }
  const color = asNullableText(r.color)
  if (color !== null) record.color = color
  const lastUsedAt = asNullableText(r.last_used_at)
  if (lastUsedAt !== null) record.lastUsedAt = lastUsedAt
  return record
}

function snapshotFromRow(r: Row, includeTables: boolean): SchemaSnapshot {
  const snapshot: SchemaSnapshot = {
    id: asText(r.id),
    projectId: asNullableText(r.project_id),
    connectionId: asText(r.connection_id),
    database: asText(r.database_name),
    serverVersion: asText(r.server_version),
    serverFlavor: (asText(r.server_flavor) || 'unknown') as SchemaSnapshot['serverFlavor'],
    charset: asText(r.charset),
    takenAt: asText(r.taken_at),
    schemaHash: asText(r.schema_hash),
    objectCount: asInt(r.object_count, 0),
    // Full table bodies are heavy: only parsed when explicitly requested.
    tables: includeTables ? parseJson<SchemaSnapshotTable[]>(r.tables_json, []) : [],
    version: asInt(r.version, 1)
  }
  if (r.sampled_json !== null && r.sampled_json !== undefined) {
    snapshot.sampled = parseJson<SampledData[]>(r.sampled_json, [])
  }
  return snapshot
}

function historyFromRow(r: Row): HistoryEntry {
  const entry: HistoryEntry = {
    id: asText(r.id),
    projectId: asNullableText(r.project_id),
    connectionId: asText(r.connection_id),
    database: asText(r.database_name),
    sql: asText(r.sql_text),
    kind: asText(r.kind) as HistoryEntry['kind'],
    risk: asText(r.risk) as RiskLevel,
    status: asText(r.status) as HistoryEntry['status'],
    rowCount: asInt(r.row_count, 0),
    affectedRows: asInt(r.affected_rows, 0),
    durationMs: asInt(r.duration_ms, 0),
    executedAt: asText(r.executed_at),
    trigger: (asText(r.trigger_kind) || 'user') as HistoryEntry['trigger']
  }
  const recoveryPointId = asNullableText(r.recovery_point_id)
  if (recoveryPointId !== null) entry.recoveryPointId = recoveryPointId
  const backupId = asNullableText(r.backup_id)
  if (backupId !== null) entry.backupId = backupId
  const auditEventId = asNullableText(r.audit_event_id)
  if (auditEventId !== null) entry.auditEventId = auditEventId
  const error = asNullableText(r.error)
  if (error !== null) entry.error = error
  return entry
}

function approvalFromRow(r: Row): ApprovalRecord {
  const record: ApprovalRecord = {
    id: asText(r.id),
    planId: asText(r.plan_id),
    kind: asText(r.kind) as ApprovalRequest['kind'],
    summary: asText(r.summary),
    targets: parseJson<string[]>(r.targets_json, []),
    risk: asText(r.risk) as RiskLevel,
    impact: asText(r.impact),
    createdAt: asText(r.created_at),
    expiresAt: asText(r.expires_at),
    status: asText(r.status) as ApprovalRequest['status'],
    planHash: asText(r.plan_hash),
    trigger: (asText(r.trigger_kind) || 'user') as HistoryTrigger
  }
  const taskId = asNullableText(r.task_id)
  if (taskId !== null) record.taskId = taskId
  const sql = asNullableText(r.sql_text)
  if (sql !== null) record.sql = sql
  if (r.recovery_plan_json !== null && r.recovery_plan_json !== undefined) {
    record.recoveryPlan = parseJson<RecoveryPlanSummary>(r.recovery_plan_json, {
      strategy: 'none',
      needsBackup: false,
      reason: '',
      estimatedAffectedRows: null,
      beforeImageSupported: false,
      warnings: []
    })
  }
  const comment = asNullableText(r.comment)
  if (comment !== null) record.comment = comment
  return record
}

function memoryFromRow(r: Row): MemoryRecord {
  return {
    id: asText(r.id),
    projectId: asText(r.project_id),
    type: asText(r.type) as MemoryType,
    title: asText(r.title),
    content: asText(r.content),
    source: asText(r.source) as MemoryRecord['source'],
    trust: asText(r.trust) as MemoryTrust,
    confidence: asNumber(r.confidence, 0.5),
    tags: parseJson<string[]>(r.tags_json, []),
    refs: parseJson<MemoryRecord['refs']>(r.refs_json, []),
    schemaSnapshotId: asNullableText(r.schema_snapshot_id),
    schemaHash: asNullableText(r.schema_hash),
    status: asText(r.status) as MemoryStatus,
    verifiedBy: asNullableText(r.verified_by) as MemoryRecord['verifiedBy'],
    verifiedAt: asNullableText(r.verified_at),
    invalidatedReason: asNullableText(r.invalidated_reason),
    createdAt: asText(r.created_at),
    updatedAt: asText(r.updated_at),
    lastUsedAt: asNullableText(r.last_used_at),
    useCount: asInt(r.use_count, 0),
    supersedesId: asNullableText(r.supersedes_id)
  }
}

function taskFromRow(r: Row): AgentTask {
  const task: AgentTask = {
    id: asText(r.id),
    projectId: asText(r.project_id),
    connectionId: asText(r.connection_id),
    database: asText(r.database_name),
    title: asText(r.title),
    userMessage: asText(r.user_message),
    status: asText(r.status) as AgentTask['status'],
    modelProfileId: asNullableText(r.model_profile_id),
    decisionModelProfileId: asNullableText(r.decision_model_profile_id),
    steps: parseJson<AgentTask['steps']>(r.steps_json, []),
    createdAt: asText(r.created_at),
    updatedAt: asText(r.updated_at),
    stepCount: asInt(r.step_count, 0),
    maxSteps: asInt(r.max_steps, 0),
    toolCallCount: asInt(r.tool_call_count, 0),
    approvals: parseJson<AgentTask['approvals']>(r.approvals_json, []),
    contextBudget: parseJson<AgentTask['contextBudget']>(r.context_budget_json, {
      usedChars: 0,
      limitChars: 0
    })
  }
  if (r.plan_json !== null && r.plan_json !== undefined) {
    task.plan = parseJson<NonNullable<AgentTask['plan']>>(r.plan_json, {
      summary: '',
      steps: [],
      risk: 'none',
      requiresApproval: false,
      targets: []
    })
  }
  const finalAnswer = asNullableText(r.final_answer)
  if (finalAnswer !== null) task.finalAnswer = finalAnswer
  const error = asNullableText(r.error)
  if (error !== null) task.error = error
  const finishedAt = asNullableText(r.finished_at)
  if (finishedAt !== null) task.finishedAt = finishedAt
  if (r.token_usage_json !== null && r.token_usage_json !== undefined) {
    task.tokenUsage = parseJson<NonNullable<AgentTask['tokenUsage']>>(r.token_usage_json, {
      prompt: 0,
      completion: 0,
      total: 0
    })
  }
  const turns = parseJson<NonNullable<AgentTask['turns']>>(r.turns_json, [])
  if (turns.length > 0) {
    task.turns = turns
  } else {
    // Backfill transcript for tasks created before turns_json existed.
    const seeded: NonNullable<AgentTask['turns']> = [
      {
        id: `${task.id}-u0`,
        role: 'user',
        content: task.userMessage,
        createdAt: task.createdAt
      }
    ]
    if (task.finalAnswer) {
      seeded.push({
        id: `${task.id}-a0`,
        role: 'assistant',
        content: task.finalAnswer,
        createdAt: task.finishedAt ?? task.updatedAt
      })
    }
    task.turns = seeded
  }
  return task
}

function restoreJobFromRow(r: Row): RestoreJob {
  const job: RestoreJob = {
    id: asText(r.id),
    mode: asText(r.mode) as RestoreJob['mode'],
    backupId: asNullableText(r.backup_id),
    recoveryPointId: asNullableText(r.recovery_point_id),
    projectId: asNullableText(r.project_id),
    connectionId: asText(r.connection_id),
    sourceDatabase: asText(r.source_database),
    targetDatabase: asText(r.target_database),
    tempDatabase: asNullableText(r.temp_database),
    status: asText(r.status) as RestoreJob['status'],
    progress: asNumber(r.progress, 0),
    steps: parseJson<RestoreJob['steps']>(r.steps_json, []),
    conflicts: parseJson<RestoreJob['conflicts']>(r.conflicts_json, []),
    startedAt: asText(r.started_at),
    finishedAt: asNullableText(r.finished_at),
    error: asNullableText(r.error),
    mayBePartial: asBool(r.may_be_partial),
    logPath: asNullableText(r.log_path),
    verification:
      r.verification_json === null || r.verification_json === undefined
        ? null
        : parseJson<NonNullable<RestoreJob['verification']> | null>(r.verification_json, null)
  }
  return job
}

function recoveryPointFromRow(r: Row): RecoveryPoint {
  const point: RecoveryPoint = {
    id: asText(r.id),
    executionId: asText(r.execution_id),
    planId: asText(r.plan_id),
    projectId: asNullableText(r.project_id),
    connectionId: asText(r.connection_id),
    database: asText(r.database_name),
    kind: asText(r.kind) as RecoveryPoint['kind'],
    strategy: asText(r.strategy) as RecoveryPoint['strategy'],
    risk: asText(r.risk) as RiskLevel,
    targetTables: parseJson<string[]>(r.target_tables_json, []),
    captured: parseJson<RecoveryPoint['captured']>(r.captured_json, []),
    createdAt: asText(r.created_at),
    status: asText(r.status) as RecoveryPoint['status'],
    verified: asBool(r.verified),
    note: asText(r.note),
    sizeBytes: asInt(r.size_bytes, 0),
    coverage: parseJson<RecoveryPoint['coverage']>(r.coverage_json, {
      hasOperationLog: true,
      hasBeforeImage: false,
      hasFullBackup: false,
      backupVerified: false
    })
  }
  const beforeImagePath = asNullableText(r.before_image_path)
  if (beforeImagePath !== null) point.beforeImagePath = beforeImagePath
  const afterImagePath = asNullableText(r.after_image_path)
  if (afterImagePath !== null) point.afterImagePath = afterImagePath
  const schemaSnapshotId = asNullableText(r.schema_snapshot_id)
  if (schemaSnapshotId !== null) point.schemaSnapshotId = schemaSnapshotId
  const backupId = asNullableText(r.backup_id)
  if (backupId !== null) point.backupId = backupId
  const verifiedAt = asNullableText(r.verified_at)
  if (verifiedAt !== null) point.verifiedAt = verifiedAt
  const checksum = asNullableText(r.checksum)
  if (checksum !== null) point.checksum = checksum
  return point
}

function backupFromRow(r: Row): BackupRecord {
  const record: BackupRecord = {
    id: asText(r.id),
    projectId: asNullableText(r.project_id),
    connectionId: asText(r.connection_id),
    database: asText(r.database_name),
    scope: asText(r.scope) as BackupRecord['scope'],
    tables: parseJson<string[]>(r.tables_json, []),
    type: asText(r.type) as BackupRecord['type'],
    tool: asText(r.tool) as BackupRecord['tool'],
    filePath: asText(r.file_path),
    fileName: asText(r.file_name),
    fileSize: asInt(r.file_size, 0),
    checksumSha256: asText(r.checksum_sha256),
    schemaHash: asText(r.schema_hash),
    serverVersion: asText(r.server_version),
    status: asText(r.status) as BackupRecord['status'],
    verification: parseJson<BackupRecord['verification']>(r.verification_json, {
      fileExists: false,
      nonEmpty: false,
      checksumOk: false,
      structureOk: false,
      tableCount: null,
      rowDataPresent: false,
      notes: []
    }),
    createdAt: asText(r.created_at),
    completedAt: asNullableText(r.completed_at),
    error: asNullableText(r.error),
    retentionUntil: asNullableText(r.retention_until),
    // Live count wins over the denormalised column so the UI never goes stale.
    referencedByRecoveryPoints:
      r.ref_count !== undefined ? asInt(r.ref_count, 0) : asInt(r.referenced_by_recovery_points, 0)
  }
  return record
}

function parseModelRoles(raw: unknown): ModelProfile['roles'] {
  const fallback: ModelProfile['roles'] = ['agent']
  if (raw === null || raw === undefined || raw === '') return fallback
  try {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
    if (!Array.isArray(parsed)) return fallback
    const roles = parsed.filter((item): item is 'agent' | 'decision' => item === 'agent' || item === 'decision')
    return roles.length ? Array.from(new Set(roles)) : fallback
  } catch {
    return fallback
  }
}

function modelProfileFromRow(r: Row): ModelProfile {
  const profile: ModelProfile = {
    id: asText(r.id),
    name: asText(r.name),
    kind: asText(r.kind) as ModelProfile['kind'],
    baseUrl: asText(r.base_url),
    model: asText(r.model),
    apiKeyStored: asBool(r.api_key_stored),
    temperature: asNumber(r.temperature, 0.2),
    maxTokens: asInt(r.max_tokens, 4096),
    timeoutMs: asInt(r.timeout_ms, 60000),
    toolsEnabled: asBool(r.tools_enabled),
    isDefault: asBool(r.is_default),
    roles: parseModelRoles(r.roles_json),
    notes: asText(r.notes),
    createdAt: asText(r.created_at),
    updatedAt: asText(r.updated_at)
  }
  const lastTestAt = asNullableText(r.last_test_at)
  if (lastTestAt !== null) profile.lastTestAt = lastTestAt
  if (r.last_test_ok !== null && r.last_test_ok !== undefined) {
    profile.lastTestOk = asBool(r.last_test_ok)
  }
  return profile
}

function auditFromRow(r: Row): AuditEvent {
  const event: AuditEvent = {
    id: asText(r.id),
    ts: asText(r.ts),
    actor: asText(r.actor) as AuditEvent['actor'],
    action: asText(r.action),
    outcome: asText(r.outcome) as AuditEvent['outcome'],
    projectId: asNullableText(r.project_id),
    connectionId: asNullableText(r.connection_id),
    target: asNullableText(r.target),
    risk: r.risk === null || r.risk === undefined ? null : (asText(r.risk) as RiskLevel),
    sqlPreview: asNullableText(r.sql_preview),
    detail: asNullableText(r.detail),
    metadata: parseJson<Record<string, unknown>>(r.metadata_json, {})
  }
  return event
}

/* ------------------------------------------------------------------ */
/* Domain -> column field maps used by partial UPDATEs                 */
/* ------------------------------------------------------------------ */

const PROJECT_FIELDS: FieldMap = {
  name: { column: 'name', encode: encText },
  description: { column: 'description', encode: encText },
  connectionId: { column: 'connection_id', encode: encText },
  schemaSnapshotId: { column: 'schema_snapshot_id', encode: encText },
  lastOpenedAt: { column: 'last_opened_at', encode: encText },
  createdAt: { column: 'created_at', encode: encText },
  updatedAt: { column: 'updated_at', encode: encText },
  databaseBriefMd: { column: 'database_brief_md', encode: encText }
}

const HISTORY_FIELDS: FieldMap = {
  projectId: { column: 'project_id', encode: encText },
  connectionId: { column: 'connection_id', encode: encText },
  database: { column: 'database_name', encode: encText },
  sql: { column: 'sql_text', encode: encText },
  kind: { column: 'kind', encode: encText },
  risk: { column: 'risk', encode: encText },
  status: { column: 'status', encode: encText },
  rowCount: { column: 'row_count', encode: encInteger },
  affectedRows: { column: 'affected_rows', encode: encInteger },
  durationMs: { column: 'duration_ms', encode: encInteger },
  executedAt: { column: 'executed_at', encode: encText },
  recoveryPointId: { column: 'recovery_point_id', encode: encText },
  backupId: { column: 'backup_id', encode: encText },
  auditEventId: { column: 'audit_event_id', encode: encText },
  trigger: { column: 'trigger_kind', encode: encText },
  error: { column: 'error', encode: encText }
}

const MEMORY_FIELDS: FieldMap = {
  projectId: { column: 'project_id', encode: encText },
  type: { column: 'type', encode: encText },
  title: { column: 'title', encode: encText },
  content: { column: 'content', encode: encText },
  source: { column: 'source', encode: encText },
  trust: { column: 'trust', encode: encText },
  confidence: { column: 'confidence', encode: encNumber },
  tags: { column: 'tags_json', encode: encJson },
  refs: { column: 'refs_json', encode: encJson },
  schemaSnapshotId: { column: 'schema_snapshot_id', encode: encText },
  schemaHash: { column: 'schema_hash', encode: encText },
  status: { column: 'status', encode: encText },
  verifiedBy: { column: 'verified_by', encode: encText },
  verifiedAt: { column: 'verified_at', encode: encText },
  invalidatedReason: { column: 'invalidated_reason', encode: encText },
  createdAt: { column: 'created_at', encode: encText },
  updatedAt: { column: 'updated_at', encode: encText },
  lastUsedAt: { column: 'last_used_at', encode: encText },
  useCount: { column: 'use_count', encode: encInteger },
  supersedesId: { column: 'supersedes_id', encode: encText }
}

const TASK_FIELDS: FieldMap = {
  projectId: { column: 'project_id', encode: encText },
  connectionId: { column: 'connection_id', encode: encText },
  database: { column: 'database_name', encode: encText },
  title: { column: 'title', encode: encText },
  userMessage: { column: 'user_message', encode: encText },
  status: { column: 'status', encode: encText },
  modelProfileId: { column: 'model_profile_id', encode: encText },
  decisionModelProfileId: { column: 'decision_model_profile_id', encode: encText },
  steps: { column: 'steps_json', encode: encJson },
  plan: { column: 'plan_json', encode: encJsonOrNull },
  finalAnswer: { column: 'final_answer', encode: encText },
  error: { column: 'error', encode: encText },
  createdAt: { column: 'created_at', encode: encText },
  updatedAt: { column: 'updated_at', encode: encText },
  finishedAt: { column: 'finished_at', encode: encText },
  stepCount: { column: 'step_count', encode: encInteger },
  maxSteps: { column: 'max_steps', encode: encInteger },
  toolCallCount: { column: 'tool_call_count', encode: encInteger },
  tokenUsage: { column: 'token_usage_json', encode: encJsonOrNull },
  approvals: { column: 'approvals_json', encode: encJson },
  contextBudget: { column: 'context_budget_json', encode: encJson },
  turns: { column: 'turns_json', encode: encJson }
}

const JOB_FIELDS: FieldMap = {
  mode: { column: 'mode', encode: encText },
  backupId: { column: 'backup_id', encode: encText },
  recoveryPointId: { column: 'recovery_point_id', encode: encText },
  projectId: { column: 'project_id', encode: encText },
  connectionId: { column: 'connection_id', encode: encText },
  sourceDatabase: { column: 'source_database', encode: encText },
  targetDatabase: { column: 'target_database', encode: encText },
  tempDatabase: { column: 'temp_database', encode: encText },
  status: { column: 'status', encode: encText },
  progress: { column: 'progress', encode: encNumber },
  steps: { column: 'steps_json', encode: encJson },
  conflicts: { column: 'conflicts_json', encode: encJson },
  startedAt: { column: 'started_at', encode: encText },
  finishedAt: { column: 'finished_at', encode: encText },
  error: { column: 'error', encode: encText },
  mayBePartial: { column: 'may_be_partial', encode: encBool },
  logPath: { column: 'log_path', encode: encText },
  verification: { column: 'verification_json', encode: encJsonOrNull }
}

const RECOVERY_FIELDS: FieldMap = {
  executionId: { column: 'execution_id', encode: encText },
  planId: { column: 'plan_id', encode: encText },
  projectId: { column: 'project_id', encode: encText },
  connectionId: { column: 'connection_id', encode: encText },
  database: { column: 'database_name', encode: encText },
  kind: { column: 'kind', encode: encText },
  strategy: { column: 'strategy', encode: encText },
  risk: { column: 'risk', encode: encText },
  targetTables: { column: 'target_tables_json', encode: encJson },
  beforeImagePath: { column: 'before_image_path', encode: encText },
  afterImagePath: { column: 'after_image_path', encode: encText },
  schemaSnapshotId: { column: 'schema_snapshot_id', encode: encText },
  backupId: { column: 'backup_id', encode: encText },
  captured: { column: 'captured_json', encode: encJson },
  createdAt: { column: 'created_at', encode: encText },
  status: { column: 'status', encode: encText },
  verified: { column: 'verified', encode: encBool },
  verifiedAt: { column: 'verified_at', encode: encText },
  note: { column: 'note', encode: encText },
  sizeBytes: { column: 'size_bytes', encode: encInteger },
  checksum: { column: 'checksum', encode: encText },
  coverage: { column: 'coverage_json', encode: encJson }
}

const BACKUP_FIELDS: FieldMap = {
  projectId: { column: 'project_id', encode: encText },
  connectionId: { column: 'connection_id', encode: encText },
  database: { column: 'database_name', encode: encText },
  scope: { column: 'scope', encode: encText },
  tables: { column: 'tables_json', encode: encJson },
  type: { column: 'type', encode: encText },
  tool: { column: 'tool', encode: encText },
  filePath: { column: 'file_path', encode: encText },
  fileName: { column: 'file_name', encode: encText },
  fileSize: { column: 'file_size', encode: encInteger },
  checksumSha256: { column: 'checksum_sha256', encode: encText },
  schemaHash: { column: 'schema_hash', encode: encText },
  serverVersion: { column: 'server_version', encode: encText },
  status: { column: 'status', encode: encText },
  verification: { column: 'verification_json', encode: encJson },
  createdAt: { column: 'created_at', encode: encText },
  completedAt: { column: 'completed_at', encode: encText },
  error: { column: 'error', encode: encText },
  retentionUntil: { column: 'retention_until', encode: encText }
}

/* ------------------------------------------------------------------ */
/* Schema migrations                                                   */
/* ------------------------------------------------------------------ */

/**
 * Ordered, append-only migration list. Index N upgrades `user_version` from N
 * to N + 1. NEVER edit an already-released migration; append a new one.
 *
 * Table names / columns are static strings - no user input reaches DDL.
 */
const MIGRATIONS: ReadonlyArray<(db: DatabaseSync) => void> = [
  // ---- v1: core app data ------------------------------------------------
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id   INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connections (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL,
        host                TEXT NOT NULL,
        port                INTEGER NOT NULL DEFAULT 3306,
        user_name           TEXT NOT NULL DEFAULT '',
        database_name       TEXT NOT NULL DEFAULT '',
        ssl                 TEXT NOT NULL DEFAULT 'preferred',
        charset             TEXT NOT NULL DEFAULT 'utf8mb4',
        has_stored_password INTEGER NOT NULL DEFAULT 0,
        connect_timeout_ms  INTEGER NOT NULL DEFAULT 10000,
        color               TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        last_used_at        TEXT,
        last_state          TEXT NOT NULL DEFAULT 'disconnected',
        secret_cipher       TEXT
      );

      CREATE TABLE IF NOT EXISTS projects (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        connection_id      TEXT REFERENCES connections(id) ON DELETE SET NULL,
        schema_snapshot_id TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        last_opened_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS schema_snapshots (
        id             TEXT PRIMARY KEY,
        project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
        connection_id  TEXT NOT NULL,
        database_name  TEXT NOT NULL,
        server_version TEXT NOT NULL DEFAULT '',
        server_flavor  TEXT NOT NULL DEFAULT 'unknown',
        charset        TEXT NOT NULL DEFAULT '',
        taken_at       TEXT NOT NULL,
        schema_hash    TEXT NOT NULL DEFAULT '',
        object_count   INTEGER NOT NULL DEFAULT 0,
        tables_json    TEXT NOT NULL DEFAULT '[]',
        version        INTEGER NOT NULL DEFAULT 1,
        sampled_json   TEXT
      );

      CREATE TABLE IF NOT EXISTS history (
        id                TEXT PRIMARY KEY,
        project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
        connection_id     TEXT NOT NULL,
        database_name     TEXT NOT NULL,
        sql_text          TEXT NOT NULL,
        kind              TEXT NOT NULL,
        risk              TEXT NOT NULL,
        status            TEXT NOT NULL,
        row_count         INTEGER NOT NULL DEFAULT 0,
        affected_rows     INTEGER NOT NULL DEFAULT 0,
        duration_ms       INTEGER NOT NULL DEFAULT 0,
        executed_at       TEXT NOT NULL,
        recovery_point_id TEXT,
        backup_id         TEXT,
        audit_event_id    TEXT,
        trigger_kind      TEXT NOT NULL DEFAULT 'user',
        error             TEXT
      );

      CREATE TABLE IF NOT EXISTS memories (
        id                 TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type               TEXT NOT NULL,
        title              TEXT NOT NULL,
        content            TEXT NOT NULL,
        source             TEXT NOT NULL,
        trust              TEXT NOT NULL,
        confidence         REAL NOT NULL DEFAULT 0.5,
        tags_json          TEXT NOT NULL DEFAULT '[]',
        refs_json          TEXT NOT NULL DEFAULT '[]',
        schema_snapshot_id TEXT,
        schema_hash        TEXT,
        status             TEXT NOT NULL DEFAULT 'active',
        verified_by        TEXT,
        verified_at        TEXT,
        invalidated_reason TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        last_used_at       TEXT,
        use_count          INTEGER NOT NULL DEFAULT 0,
        supersedes_id      TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id                  TEXT PRIMARY KEY,
        project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        connection_id       TEXT NOT NULL,
        database_name       TEXT NOT NULL,
        title               TEXT NOT NULL,
        user_message        TEXT NOT NULL,
        status              TEXT NOT NULL,
        model_profile_id    TEXT,
        steps_json          TEXT NOT NULL DEFAULT '[]',
        plan_json           TEXT,
        final_answer        TEXT,
        error               TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        finished_at         TEXT,
        step_count          INTEGER NOT NULL DEFAULT 0,
        max_steps           INTEGER NOT NULL DEFAULT 0,
        tool_call_count     INTEGER NOT NULL DEFAULT 0,
        token_usage_json    TEXT,
        approvals_json      TEXT NOT NULL DEFAULT '[]',
        context_budget_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id                 TEXT PRIMARY KEY,
        task_id            TEXT REFERENCES agent_tasks(id) ON DELETE CASCADE,
        project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
        plan_id            TEXT NOT NULL,
        kind               TEXT NOT NULL,
        summary            TEXT NOT NULL,
        sql_text           TEXT,
        targets_json       TEXT NOT NULL DEFAULT '[]',
        risk               TEXT NOT NULL,
        impact             TEXT NOT NULL DEFAULT '',
        recovery_plan_json TEXT,
        created_at         TEXT NOT NULL,
        expires_at         TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending',
        comment            TEXT,
        plan_hash          TEXT NOT NULL DEFAULT '',
        trigger_kind       TEXT NOT NULL DEFAULT 'user'
      );

      CREATE TABLE IF NOT EXISTS model_profiles (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        base_url       TEXT NOT NULL DEFAULT '',
        model          TEXT NOT NULL DEFAULT '',
        api_key_stored INTEGER NOT NULL DEFAULT 0,
        secret_cipher  TEXT,
        temperature    REAL NOT NULL DEFAULT 0.2,
        max_tokens     INTEGER NOT NULL DEFAULT 4096,
        timeout_ms     INTEGER NOT NULL DEFAULT 60000,
        tools_enabled  INTEGER NOT NULL DEFAULT 0,
        is_default     INTEGER NOT NULL DEFAULT 0,
        notes          TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        last_test_at   TEXT,
        last_test_ok   INTEGER
      );
    `)
  },
  // ---- v2: time machine + audit ----------------------------------------
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS restore_jobs (
        id                TEXT PRIMARY KEY,
        mode              TEXT NOT NULL DEFAULT 'undo_last',
        backup_id         TEXT,
        recovery_point_id TEXT,
        project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
        connection_id     TEXT NOT NULL DEFAULT '',
        source_database   TEXT NOT NULL DEFAULT '',
        target_database   TEXT NOT NULL DEFAULT '',
        temp_database     TEXT,
        status            TEXT NOT NULL DEFAULT 'preparing',
        progress          REAL NOT NULL DEFAULT 0,
        steps_json        TEXT NOT NULL DEFAULT '[]',
        conflicts_json    TEXT NOT NULL DEFAULT '[]',
        started_at        TEXT NOT NULL,
        finished_at       TEXT,
        error             TEXT,
        may_be_partial    INTEGER NOT NULL DEFAULT 0,
        log_path          TEXT,
        verification_json TEXT
      );

      CREATE TABLE IF NOT EXISTS recovery_points (
        id                 TEXT PRIMARY KEY,
        execution_id       TEXT NOT NULL,
        plan_id            TEXT NOT NULL,
        project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
        connection_id      TEXT NOT NULL,
        database_name      TEXT NOT NULL,
        kind               TEXT NOT NULL,
        strategy           TEXT NOT NULL,
        risk               TEXT NOT NULL,
        target_tables_json TEXT NOT NULL DEFAULT '[]',
        before_image_path  TEXT,
        after_image_path   TEXT,
        schema_snapshot_id TEXT,
        backup_id          TEXT,
        captured_json      TEXT NOT NULL DEFAULT '[]',
        created_at         TEXT NOT NULL,
        status             TEXT NOT NULL,
        verified           INTEGER NOT NULL DEFAULT 0,
        verified_at        TEXT,
        note               TEXT NOT NULL DEFAULT '',
        size_bytes         INTEGER NOT NULL DEFAULT 0,
        checksum           TEXT,
        coverage_json      TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS backups (
        id                           TEXT PRIMARY KEY,
        project_id                   TEXT REFERENCES projects(id) ON DELETE SET NULL,
        connection_id                TEXT NOT NULL,
        database_name                TEXT NOT NULL,
        scope                        TEXT NOT NULL,
        tables_json                  TEXT NOT NULL DEFAULT '[]',
        type                         TEXT NOT NULL,
        tool                         TEXT NOT NULL,
        file_path                    TEXT NOT NULL,
        file_name                    TEXT NOT NULL,
        file_size                    INTEGER NOT NULL DEFAULT 0,
        checksum_sha256              TEXT NOT NULL DEFAULT '',
        schema_hash                  TEXT NOT NULL DEFAULT '',
        server_version               TEXT NOT NULL DEFAULT '',
        status                       TEXT NOT NULL,
        verification_json            TEXT NOT NULL DEFAULT '{}',
        created_at                   TEXT NOT NULL,
        completed_at                 TEXT,
        error                        TEXT,
        retention_until              TEXT,
        referenced_by_recovery_points INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id            TEXT PRIMARY KEY,
        ts            TEXT NOT NULL,
        actor         TEXT NOT NULL,
        action        TEXT NOT NULL,
        project_id    TEXT,
        connection_id TEXT,
        target        TEXT,
        risk          TEXT,
        sql_preview   TEXT,
        outcome       TEXT NOT NULL,
        detail        TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_projects_connection        ON projects(connection_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_project          ON schema_snapshots(project_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_connection       ON schema_snapshots(connection_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_taken            ON schema_snapshots(taken_at);
      CREATE INDEX IF NOT EXISTS idx_history_project            ON history(project_id);
      CREATE INDEX IF NOT EXISTS idx_history_connection         ON history(connection_id);
      CREATE INDEX IF NOT EXISTS idx_history_executed           ON history(executed_at);
      CREATE INDEX IF NOT EXISTS idx_history_status             ON history(status);
      CREATE INDEX IF NOT EXISTS idx_memories_project           ON memories(project_id);
      CREATE INDEX IF NOT EXISTS idx_memories_project_type      ON memories(project_id, type);
      CREATE INDEX IF NOT EXISTS idx_memories_status            ON memories(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_plan             ON approvals(plan_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status           ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_expires          ON approvals(expires_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_project          ON approvals(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_project              ON agent_tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_connection           ON agent_tasks(connection_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_created              ON agent_tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_project               ON restore_jobs(project_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_connection            ON restore_jobs(connection_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_started               ON restore_jobs(started_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_status                ON restore_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_recovery_project           ON recovery_points(project_id);
      CREATE INDEX IF NOT EXISTS idx_recovery_connection        ON recovery_points(connection_id);
      CREATE INDEX IF NOT EXISTS idx_recovery_created           ON recovery_points(created_at);
      CREATE INDEX IF NOT EXISTS idx_recovery_status            ON recovery_points(status);
      CREATE INDEX IF NOT EXISTS idx_recovery_backup            ON recovery_points(backup_id);
      CREATE INDEX IF NOT EXISTS idx_backups_project            ON backups(project_id);
      CREATE INDEX IF NOT EXISTS idx_backups_connection         ON backups(connection_id);
      CREATE INDEX IF NOT EXISTS idx_backups_created            ON backups(created_at);
      CREATE INDEX IF NOT EXISTS idx_backups_status             ON backups(status);
      CREATE INDEX IF NOT EXISTS idx_backups_retention          ON backups(retention_until);
      CREATE INDEX IF NOT EXISTS idx_audit_project              ON audit_events(project_id);
      CREATE INDEX IF NOT EXISTS idx_audit_connection           ON audit_events(connection_id);
      CREATE INDEX IF NOT EXISTS idx_audit_ts                   ON audit_events(ts);
      CREATE INDEX IF NOT EXISTS idx_models_default             ON model_profiles(is_default);
    `)
  },
  // ---- v3: persisted per-connection connect timeout --------------------
  // Databases created before v1 gained this column (see ConnectionRecord)
  // are upgraded in place; fresh databases already have it from v1.
  (db) => {
    const columns = db.prepare('PRAGMA table_info(connections)').all() as Array<Record<string, unknown>>
    const hasColumn = columns.some((column) => column.name === 'connect_timeout_ms')
    if (!hasColumn) {
      db.exec('ALTER TABLE connections ADD COLUMN connect_timeout_ms INTEGER NOT NULL DEFAULT 10000')
    }
  },
  // ---- v4: model roles (agent / decision-JEV) ---------------------------
  (db) => {
    const columns = db.prepare('PRAGMA table_info(model_profiles)').all() as Array<Record<string, unknown>>
    const hasRoles = columns.some((column) => column.name === 'roles_json')
    if (!hasRoles) {
      db.exec(`ALTER TABLE model_profiles ADD COLUMN roles_json TEXT NOT NULL DEFAULT '["agent"]'`)
    }
  },
  // ---- v5: agent task decision model id --------------------------------
  (db) => {
    const columns = db.prepare('PRAGMA table_info(agent_tasks)').all() as Array<Record<string, unknown>>
    const hasColumn = columns.some((column) => column.name === 'decision_model_profile_id')
    if (!hasColumn) {
      db.exec('ALTER TABLE agent_tasks ADD COLUMN decision_model_profile_id TEXT')
    }
  },
  // ---- v6: multi-turn chat transcript on agent tasks -------------------
  (db) => {
    const columns = db.prepare('PRAGMA table_info(agent_tasks)').all() as Array<Record<string, unknown>>
    const hasColumn = columns.some((column) => column.name === 'turns_json')
    if (!hasColumn) {
      db.exec(`ALTER TABLE agent_tasks ADD COLUMN turns_json TEXT NOT NULL DEFAULT '[]'`)
    }
  },
  // ---- v7: project-bound database brief (Agent understanding MD) -------
  (db) => {
    const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<Record<string, unknown>>
    const hasColumn = columns.some((column) => column.name === 'database_brief_md')
    if (!hasColumn) {
      db.exec('ALTER TABLE projects ADD COLUMN database_brief_md TEXT')
    }
  }
]

/* ------------------------------------------------------------------ */
/* SqliteAppStore                                                      */
/* ------------------------------------------------------------------ */

export class SqliteAppStore implements AppStore {
  private db!: DatabaseSync
  private readonly _dbPath: string
  private readonly defaults: AppSettings
  private _schemaVersion = 0
  private closed = false
  private txDepth = 0

  constructor(dbPath: string, defaults: AppSettings) {
    this._dbPath = dbPath
    this.defaults = { ...defaults }

    let db: DatabaseSync | null = null
    try {
      if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
        mkdirSync(dirname(dbPath), { recursive: true })
      }
      db = new DatabaseSync(dbPath)
      // WAL keeps readers non-blocking while the app writes history/audit rows.
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA synchronous = NORMAL')
      this.db = db
      this.migrate()
      // Settings are stored as a patch applied on top of constructor defaults.
      this.db.prepare("INSERT OR IGNORE INTO settings (id, json) VALUES (1, '{}')").run()
      // Shrink leftover WAL from a previous crash before the UI allocates heap.
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* best-effort */
      }
    } catch (cause) {
      try {
        db?.close()
      } catch {
        /* ignore close failures while unwinding */
      }
      if (isAppError(cause)) throw cause
      throw this.dbError('open', 'database', cause)
    }
  }

  /* ------------------------------ primitives ------------------------ */

  get dbPath(): string {
    return this._dbPath
  }

  get schemaVersion(): number {
    return this._schemaVersion
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* best-effort before close */
      }
      this.db.close()
    } catch (cause) {
      throw this.dbError('close', 'database', cause)
    }
  }

  /**
   * Runs `fn` inside `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. Nested calls
   * join the outer transaction (depth counter), so services can compose
   * transactional helpers freely without SQLite "cannot start a transaction
   * within a transaction" errors.
   */
  withTransaction<T>(fn: () => T): T {
    this.ensureOpen()
    if (this.txDepth > 0) {
      this.txDepth += 1
      try {
        return fn()
      } finally {
        this.txDepth -= 1
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.txDepth = 1
    try {
      const result = fn()
      this.db.exec('COMMIT')
      this.txDepth = 0
      return result
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* transaction may already be unwound by SQLite */
      }
      this.txDepth = 0
      if (isAppError(cause)) throw cause
      throw this.dbError('transaction', 'withTransaction', cause)
    }
  }

  /* ------------------------------ helpers --------------------------- */

  private ensureOpen(): void {
    if (this.closed) {
      throw new AppError('INTERNAL', 'Store is closed', { details: { table: 'database' } })
    }
  }

  private wrap<T>(operation: string, table: string, fn: () => T): T {
    this.ensureOpen()
    try {
      return fn()
    } catch (cause) {
      if (isAppError(cause)) throw cause
      throw this.dbError(operation, table, cause)
    }
  }

  private dbError(operation: string, table: string, cause: unknown): AppError {
    const raw = cause instanceof Error ? cause.message : String(cause)
    const message = raw.length > 300 ? `${raw.slice(0, 297)}...` : raw
    return new AppError('INTERNAL', `Store ${operation} failed (${table}): ${message}`, {
      cause,
      details: { operation, table }
    })
  }

  private one(sql: string, params: SqlValue[] = []): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private many(sql: string, params: SqlValue[] = []): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private run(sql: string, params: SqlValue[] = []): number {
    return Number(this.db.prepare(sql).run(...params).changes)
  }

  private count(sql: string, params: SqlValue[] = []): number {
    return asInt(this.one(sql, params)?.c, 0)
  }

  private readUserVersion(): number {
    return asInt(this.one('PRAGMA user_version')?.user_version, 0)
  }

  /**
   * Applies only fields present (and not `undefined`) in `patch`. `table` and
   * the field map are internal constants, never caller input.
   */
  private updateById(table: string, id: Id, fields: FieldMap, patch: Record<string, unknown>): number {
    const sets: string[] = []
    const params: SqlValue[] = []
    for (const [key, spec] of Object.entries(fields)) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
      const value = patch[key]
      if (value === undefined) continue
      sets.push(`${spec.column} = ?`)
      params.push(spec.encode(value))
    }
    if (sets.length === 0) return 0
    params.push(id)
    return this.run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, params)
  }

  private migrate(): void {
    const current = this.readUserVersion()
    if (current > MIGRATIONS.length) {
      throw new AppError(
        'INTERNAL',
        `Database schema version ${current} is newer than this app supports (${MIGRATIONS.length})`,
        { details: { table: 'schema', version: current } }
      )
    }
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      const next = version + 1
      try {
        this.withTransaction(() => {
          MIGRATIONS[version](this.db)
          // PRAGMA does not accept bind parameters, but the value is a local
          // integer derived from the migration index - not user input.
          this.db.exec(`PRAGMA user_version = ${next}`)
        })
      } catch (cause) {
        if (isAppError(cause)) throw cause
        throw this.dbError(`migrate_v${next}`, 'schema', cause)
      }
    }
    this._schemaVersion = this.readUserVersion()
  }

  /* ------------------------------ settings + meta -------------------- */

  getSettings(): AppSettings {
    return this.wrap('getSettings', 'settings', () => {
      const row = this.one('SELECT json FROM settings WHERE id = 1')
      const patch = parseJson<Partial<AppSettings>>(row?.json, {})
      return { ...this.defaults, ...patch }
    })
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    return this.wrap('updateSettings', 'settings', () => {
      const merged: AppSettings = { ...this.getSettings(), ...patch }
      // Strip keys explicitly set to undefined so they do not poison the JSON.
      const clean: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(merged)) {
        if (value !== undefined) clean[key] = value
      }
      this.run(
        `INSERT INTO settings (id, json) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
        [JSON.stringify(clean)]
      )
      return merged
    })
  }

  getMeta(key: string): string | null {
    return this.wrap('getMeta', 'meta', () => asNullableText(this.one('SELECT value FROM meta WHERE key = ?', [key])?.value))
  }

  setMeta(key: string, value: string): void {
    this.wrap('setMeta', 'meta', () => {
      this.run(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value]
      )
    })
  }

  /* ------------------------------ projects -------------------------- */

  listProjects(): Project[] {
    return this.wrap('listProjects', 'projects', () => {
      const rows = this.many(`
        SELECT p.*,
          (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id) AS memory_count,
          (SELECT COUNT(*) FROM history h WHERE h.project_id = p.id) AS history_count
        FROM projects p
        ORDER BY COALESCE(p.last_opened_at, p.updated_at) DESC, p.created_at DESC
      `)
      return rows.map(projectFromRow)
    })
  }

  getProject(id: Id): Project | null {
    return this.wrap('getProject', 'projects', () => {
      const row = this.one('SELECT * FROM projects WHERE id = ?', [id])
      return row ? projectFromRow(row) : null
    })
  }

  createProject(input: ProjectInput): Project {
    return this.wrap('createProject', 'projects', () => {
      const name = String(input.name ?? '').trim()
      if (!name) throw new AppError('VALIDATION', 'Project name is required', { details: { table: 'projects' } })
      const now = nowIso()
      const project: Project = {
        id: newId('prj'),
        name,
        description: input.description ?? '',
        connectionId: input.connectionId ?? null,
        schemaSnapshotId: null,
        createdAt: now,
        updatedAt: now,
        databaseBriefMd: input.databaseBriefMd ?? null
      }
      this.run(
        `INSERT INTO projects (id, name, description, connection_id, schema_snapshot_id, created_at, updated_at, last_opened_at, database_brief_md)
         VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
        [
          project.id,
          project.name,
          project.description,
          project.connectionId,
          project.createdAt,
          project.updatedAt,
          project.databaseBriefMd ?? null
        ]
      )
      return project
    })
  }

  updateProject(id: Id, patch: Partial<ProjectInput> & { schemaSnapshotId?: Id | null }): Project {
    return this.wrap('updateProject', 'projects', () => {
      const existing = this.getProject(id)
      if (!existing) throw new AppError('NOT_FOUND', `Project not found: ${id}`, { details: { table: 'projects', id } })
      if (patch.name !== undefined) {
        const name = String(patch.name ?? '').trim()
        if (!name) throw new AppError('VALIDATION', 'Project name is required', { details: { table: 'projects' } })
      }
      const briefPatch =
        patch.databaseBriefMd !== undefined
          ? {
              databaseBriefMd:
                patch.databaseBriefMd === null
                  ? null
                  : String(patch.databaseBriefMd).slice(0, 200_000)
            }
          : {}
      const changed = this.updateById('projects', id, PROJECT_FIELDS, {
        ...patch,
        ...briefPatch,
        name: patch.name !== undefined ? String(patch.name).trim() : undefined,
        updatedAt: nowIso()
      })
      if (changed === 0) throw new AppError('NOT_FOUND', `Project not found: ${id}`, { details: { table: 'projects' } })
      return this.getProject(id) as Project
    })
  }

  deleteProject(id: Id, deleteMemories: boolean): void {
    this.wrap('deleteProject', 'projects', () => {
      const exists = this.one('SELECT id FROM projects WHERE id = ?', [id])
      if (!exists) throw new AppError('NOT_FOUND', `Project not found: ${id}`, { details: { table: 'projects', id } })
      this.withTransaction(() => {
        // MemoryRecord.projectId is REQUIRED by the shared contract, so memories
        // cannot survive without their project without becoming unreachable
        // orphan rows (and the column is NOT NULL + FK CASCADE). They are always
        // removed; `deleteMemories` is kept for contract compatibility and future
        // "archive memories" semantics.
        void deleteMemories
        this.run('DELETE FROM memories WHERE project_id = ?', [id])
        this.run('DELETE FROM schema_snapshots WHERE project_id = ?', [id])
        this.run('DELETE FROM history WHERE project_id = ?', [id])
        this.run('DELETE FROM approvals WHERE project_id = ?', [id])
        this.run('DELETE FROM agent_tasks WHERE project_id = ?', [id])
        this.run('DELETE FROM restore_jobs WHERE project_id = ?', [id])
        this.run('DELETE FROM recovery_points WHERE project_id = ?', [id])
        // Backups are kept as evidence; they simply lose their project link.
        this.run('UPDATE backups SET project_id = NULL WHERE project_id = ?', [id])
        this.run('DELETE FROM projects WHERE id = ?', [id])
      })
    })
  }

  touchProject(id: Id): void {
    this.wrap('touchProject', 'projects', () => {
      const now = nowIso()
      this.run('UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
    })
  }

  projectStats(id: Id): ProjectStats {
    return this.wrap('projectStats', 'projects', () => {
      const project = this.getProject(id)
      if (!project) throw new AppError('NOT_FOUND', `Project not found: ${id}`, { details: { table: 'projects' } })
      const historyCount = this.count('SELECT COUNT(*) AS c FROM history WHERE project_id = ?', [id])
      const memoryCount = this.count('SELECT COUNT(*) AS c FROM memories WHERE project_id = ?', [id])
      const backupCount = this.count('SELECT COUNT(*) AS c FROM backups WHERE project_id = ?', [id])
      const recoveryPointCount = this.count('SELECT COUNT(*) AS c FROM recovery_points WHERE project_id = ?', [id])
      const agentTaskCount = this.count('SELECT COUNT(*) AS c FROM agent_tasks WHERE project_id = ?', [id])

      const candidates: string[] = [project.updatedAt]
      const lastHistory = asNullableText(this.one('SELECT MAX(executed_at) AS v FROM history WHERE project_id = ?', [id])?.v)
      if (lastHistory) candidates.push(lastHistory)
      const lastMemory = asNullableText(this.one('SELECT MAX(updated_at) AS v FROM memories WHERE project_id = ?', [id])?.v)
      if (lastMemory) candidates.push(lastMemory)
      const lastTask = asNullableText(this.one('SELECT MAX(updated_at) AS v FROM agent_tasks WHERE project_id = ?', [id])?.v)
      if (lastTask) candidates.push(lastTask)
      const lastActivityAt = candidates.filter((c) => c.length > 0).sort().pop()

      const stats: ProjectStats = {
        historyCount,
        memoryCount,
        backupCount,
        recoveryPointCount,
        agentTaskCount,
        schemaSnapshotId: project.schemaSnapshotId
      }
      if (lastActivityAt) stats.lastActivityAt = lastActivityAt
      if (project.schemaSnapshotId) {
        const snapshot = this.one('SELECT taken_at FROM schema_snapshots WHERE id = ?', [project.schemaSnapshotId])
        const takenAt = asNullableText(snapshot?.taken_at)
        if (takenAt !== null) stats.schemaTakenAt = takenAt
      }
      return stats
    })
  }

  setProjectSnapshot(id: Id, snapshotId: Id | null): void {
    this.wrap('setProjectSnapshot', 'projects', () => {
      this.run('UPDATE projects SET schema_snapshot_id = ?, updated_at = ? WHERE id = ?', [
        snapshotId,
        nowIso(),
        id
      ])
    })
  }

  /* ------------------------------ connections ----------------------- */

  listConnectionRecords(): ConnectionRecord[] {
    return this.wrap('listConnectionRecords', 'connections', () => {
      const rows = this.many('SELECT * FROM connections ORDER BY name ASC, created_at ASC')
      return rows.map(connectionFromRow)
    })
  }

  getConnectionRecord(id: Id): ConnectionRecord | null {
    return this.wrap('getConnectionRecord', 'connections', () => {
      const row = this.one('SELECT * FROM connections WHERE id = ?', [id])
      return row ? connectionFromRow(row) : null
    })
  }

  saveConnectionRecord(record: ConnectionRecord): ConnectionRecord {
    return this.wrap('saveConnectionRecord', 'connections', () => {
      const now = nowIso()
      const stored: ConnectionRecord = {
        ...record,
        createdAt: record.createdAt || now,
        updatedAt: record.updatedAt || now
      }
      this.run(
        `INSERT INTO connections
          (id, name, host, port, user_name, database_name, ssl, charset,
           has_stored_password, connect_timeout_ms, color, created_at, updated_at,
           last_used_at, last_state, secret_cipher)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           port = excluded.port,
           user_name = excluded.user_name,
           database_name = excluded.database_name,
           ssl = excluded.ssl,
           charset = excluded.charset,
           has_stored_password = excluded.has_stored_password,
           connect_timeout_ms = excluded.connect_timeout_ms,
           color = excluded.color,
           updated_at = excluded.updated_at,
           last_used_at = excluded.last_used_at,
           last_state = excluded.last_state,
           secret_cipher = excluded.secret_cipher`,
        [
          stored.id,
          stored.name,
          stored.host,
          stored.port,
          stored.user,
          stored.database,
          stored.ssl,
          stored.charset,
          stored.hasStoredPassword ? 1 : 0,
          stored.connectTimeoutMs,
          stored.color ?? null,
          stored.createdAt,
          stored.updatedAt,
          stored.lastUsedAt ?? null,
          stored.lastState,
          stored.secretCipher
        ]
      )
      return this.getConnectionRecord(record.id) ?? stored
    })
  }

  deleteConnectionRecord(id: Id): void {
    this.wrap('deleteConnectionRecord', 'connections', () => {
      // projects.connection_id is FK ON DELETE SET NULL, so projects survive the
      // removal; history / approvals / snapshots intentionally keep their
      // connection_id (they are historical evidence, the type requires an id).
      this.run('DELETE FROM connections WHERE id = ?', [id])
    })
  }

  touchConnection(id: Id): void {
    this.wrap('touchConnection', 'connections', () => {
      const now = nowIso()
      this.run('UPDATE connections SET last_used_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
    })
  }

  setConnectionLastState(id: Id, state: ConnectionState): void {
    this.wrap('setConnectionLastState', 'connections', () => {
      this.run('UPDATE connections SET last_state = ?, updated_at = ? WHERE id = ?', [state, nowIso(), id])
    })
  }

  /* ------------------------------ schema snapshots ------------------ */

  insertSchemaSnapshot(snapshot: SchemaSnapshot): SchemaSnapshot {
    return this.wrap('insertSchemaSnapshot', 'schema_snapshots', () => {
      this.run(
        `INSERT INTO schema_snapshots
          (id, project_id, connection_id, database_name, server_version, server_flavor,
           charset, taken_at, schema_hash, object_count, tables_json, version, sampled_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.id,
          snapshot.projectId,
          snapshot.connectionId,
          snapshot.database,
          snapshot.serverVersion,
          snapshot.serverFlavor,
          snapshot.charset,
          snapshot.takenAt,
          snapshot.schemaHash,
          snapshot.objectCount,
          JSON.stringify(snapshot.tables ?? []),
          snapshot.version,
          snapshot.sampled === undefined ? null : JSON.stringify(snapshot.sampled)
        ]
      )
      return snapshot
    })
  }

  getSchemaSnapshot(id: Id, includeTables: boolean): SchemaSnapshot | null {
    return this.wrap('getSchemaSnapshot', 'schema_snapshots', () => {
      const row = this.one('SELECT * FROM schema_snapshots WHERE id = ?', [id])
      return row ? snapshotFromRow(row, includeTables) : null
    })
  }

  getLatestSchemaSnapshot(projectId: Id, includeTables: boolean): SchemaSnapshot | null {
    return this.wrap('getLatestSchemaSnapshot', 'schema_snapshots', () => {
      const row = this.one(
        `SELECT * FROM schema_snapshots WHERE project_id = ?
         ORDER BY taken_at DESC, version DESC, id DESC LIMIT 1`,
        [projectId]
      )
      return row ? snapshotFromRow(row, includeTables) : null
    })
  }

  listSchemaSnapshots(projectId: Id, limit: number): SchemaSnapshot[] {
    return this.wrap('listSchemaSnapshots', 'schema_snapshots', () => {
      const lim = clampInt(limit, 1, 1000, 50)
      const rows = this.many(
        `SELECT * FROM schema_snapshots WHERE project_id = ?
         ORDER BY taken_at DESC, version DESC LIMIT ?`,
        [projectId, lim]
      )
      // List views never need the (potentially multi-MB) table bodies.
      return rows.map((row) => snapshotFromRow(row, false))
    })
  }

  /* ------------------------------ history --------------------------- */

  insertHistory(entry: HistoryEntry): HistoryEntry {
    return this.wrap('insertHistory', 'history', () => {
      this.run(
        `INSERT INTO history
          (id, project_id, connection_id, database_name, sql_text, kind, risk, status,
           row_count, affected_rows, duration_ms, executed_at, recovery_point_id, backup_id,
           audit_event_id, trigger_kind, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.projectId,
          entry.connectionId,
          entry.database,
          entry.sql,
          entry.kind,
          entry.risk,
          entry.status,
          entry.rowCount,
          entry.affectedRows,
          entry.durationMs,
          entry.executedAt,
          entry.recoveryPointId ?? null,
          entry.backupId ?? null,
          entry.auditEventId ?? null,
          entry.trigger,
          entry.error ?? null
        ]
      )
      return entry
    })
  }

  updateHistory(id: Id, patch: Partial<HistoryEntry>): void {
    this.wrap('updateHistory', 'history', () => {
      const changed = this.updateById('history', id, HISTORY_FIELDS, patch as Record<string, unknown>)
      if (changed === 0) {
        const exists = this.one('SELECT id FROM history WHERE id = ?', [id])
        if (!exists) throw new AppError('NOT_FOUND', `History entry not found: ${id}`, { details: { table: 'history' } })
      }
    })
  }

  getHistory(id: Id): HistoryEntry | null {
    return this.wrap('getHistory', 'history', () => {
      const row = this.one('SELECT * FROM history WHERE id = ?', [id])
      return row ? historyFromRow(row) : null
    })
  }

  listHistory(q: HistoryQuery): PageResult<HistoryEntry> {
    return this.wrap('listHistory', 'history', () => {
      const limit = clampInt(q.limit, 1, 1000, 50)
      const offset = clampInt(q.offset, 0, 10_000_000, 0)
      const where = buildWhere([
        ['project_id = ?', q.projectId],
        ['connection_id = ?', q.connectionId],
        ['status = ?', q.status],
        ['risk = ?', q.risk]
      ])
      const total = this.count(`SELECT COUNT(*) AS c FROM history${where.sql}`, where.params)
      const rows = this.many(
        `SELECT * FROM history${where.sql}
         ORDER BY executed_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset]
      )
      return { items: rows.map(historyFromRow), total, offset, limit }
    })
  }

  /* ------------------------------ approvals ------------------------- */

  insertApproval(record: ApprovalRecord): ApprovalRecord {
    return this.wrap('insertApproval', 'approvals', () => {
      // ApprovalRequest carries no projectId, so derive it: an agent approval
      // inherits the task's project; callers may also pass `projectId` as an
      // extra runtime property (structurally allowed) for manual SQL plans.
      const explicit = (record as ApprovalRecord & { projectId?: Id | null }).projectId
      let projectId: Id | null = explicit ?? null
      if (projectId === null && record.taskId) {
        projectId = asNullableText(this.one('SELECT project_id FROM agent_tasks WHERE id = ?', [record.taskId])?.project_id)
      }
      this.run(
        `INSERT INTO approvals
          (id, task_id, project_id, plan_id, kind, summary, sql_text, targets_json, risk,
           impact, recovery_plan_json, created_at, expires_at, status, comment, plan_hash, trigger_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.taskId ?? null,
          projectId,
          record.planId,
          record.kind,
          record.summary,
          record.sql ?? null,
          JSON.stringify(record.targets ?? []),
          record.risk,
          record.impact,
          record.recoveryPlan === undefined ? null : JSON.stringify(record.recoveryPlan),
          record.createdAt,
          record.expiresAt,
          record.status,
          record.comment ?? null,
          record.planHash,
          record.trigger
        ]
      )
      return record
    })
  }

  getApproval(id: Id): ApprovalRecord | null {
    return this.wrap('getApproval', 'approvals', () => {
      const row = this.one('SELECT * FROM approvals WHERE id = ?', [id])
      return row ? approvalFromRow(row) : null
    })
  }

  getApprovalByPlan(planId: Id): ApprovalRecord | null {
    return this.wrap('getApprovalByPlan', 'approvals', () => {
      const row = this.one(
        'SELECT * FROM approvals WHERE plan_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        [planId]
      )
      return row ? approvalFromRow(row) : null
    })
  }

  listApprovals(q: { projectId?: Id; status?: ApprovalRecord['status']; limit?: number }): ApprovalRecord[] {
    return this.wrap('listApprovals', 'approvals', () => {
      const limit = clampInt(q.limit, 1, 1000, 100)
      const where = buildWhere([
        ['project_id = ?', q.projectId],
        ['status = ?', q.status]
      ])
      const rows = this.many(
        `SELECT * FROM approvals${where.sql}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        [...where.params, limit]
      )
      return rows.map(approvalFromRow)
    })
  }

  resolveApproval(
    id: Id,
    status: ApprovalRecord['status'],
    comment?: string
  ): ApprovalRecord | null {
    return this.wrap('resolveApproval', 'approvals', () => {
      // COALESCE keeps an existing comment when no new one is supplied.
      this.run('UPDATE approvals SET status = ?, comment = COALESCE(?, comment) WHERE id = ?', [
        status,
        comment ?? null,
        id
      ])
      return this.getApproval(id)
    })
  }

  expireStaleApprovals(now: IsoDate): number {
    return this.wrap('expireStaleApprovals', 'approvals', () => {
      return this.run(
        `UPDATE approvals SET status = 'expired'
         WHERE status = 'pending' AND expires_at <= ?`,
        [now]
      )
    })
  }

  /* ------------------------------ memory ---------------------------- */

  insertMemory(memory: MemoryRecord): MemoryRecord {
    return this.wrap('insertMemory', 'memories', () => {
      this.run(
        `INSERT INTO memories
          (id, project_id, type, title, content, source, trust, confidence, tags_json,
           refs_json, schema_snapshot_id, schema_hash, status, verified_by, verified_at,
           invalidated_reason, created_at, updated_at, last_used_at, use_count, supersedes_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          memory.id,
          memory.projectId,
          memory.type,
          memory.title,
          memory.content,
          memory.source,
          memory.trust,
          memory.confidence,
          JSON.stringify(memory.tags ?? []),
          JSON.stringify(memory.refs ?? []),
          memory.schemaSnapshotId ?? null,
          memory.schemaHash ?? null,
          memory.status,
          memory.verifiedBy ?? null,
          memory.verifiedAt ?? null,
          memory.invalidatedReason ?? null,
          memory.createdAt,
          memory.updatedAt,
          memory.lastUsedAt ?? null,
          memory.useCount,
          memory.supersedesId ?? null
        ]
      )
      return memory
    })
  }

  getMemory(id: Id): MemoryRecord | null {
    return this.wrap('getMemory', 'memories', () => {
      const row = this.one('SELECT * FROM memories WHERE id = ?', [id])
      return row ? memoryFromRow(row) : null
    })
  }

  updateMemory(id: Id, patch: Partial<MemoryRecord>): MemoryRecord {
    return this.wrap('updateMemory', 'memories', () => {
      const existing = this.getMemory(id)
      if (!existing) throw new AppError('NOT_FOUND', `Memory not found: ${id}`, { details: { table: 'memories' } })
      const effective: Record<string, unknown> = { ...patch }
      if (effective.updatedAt === undefined) effective.updatedAt = nowIso()
      this.updateById('memories', id, MEMORY_FIELDS, effective)
      return this.getMemory(id) as MemoryRecord
    })
  }

  deleteMemory(id: Id): void {
    this.wrap('deleteMemory', 'memories', () => {
      this.run('DELETE FROM memories WHERE id = ?', [id])
    })
  }

  deleteMemoriesOfProject(projectId: Id): number {
    return this.wrap('deleteMemoriesOfProject', 'memories', () => {
      return this.run('DELETE FROM memories WHERE project_id = ?', [projectId])
    })
  }

  listMemories(q: {
    projectId: Id
    types?: MemoryType[]
    status?: MemoryStatus
    trust?: MemoryTrust[]
    limit: number
    offset: number
  }): PageResult<MemoryRecord> {
    return this.wrap('listMemories', 'memories', () => {
      const limit = clampInt(q.limit, 1, 500, 50)
      const offset = clampInt(q.offset, 0, 10_000_000, 0)
      const where: string[] = ['project_id = ?']
      const params: SqlValue[] = [q.projectId]
      if (q.types && q.types.length > 0) {
        where.push(`type IN (${q.types.map(() => '?').join(', ')})`)
        params.push(...q.types)
      }
      if (q.status) {
        where.push('status = ?')
        params.push(q.status)
      }
      if (q.trust && q.trust.length > 0) {
        where.push(`trust IN (${q.trust.map(() => '?').join(', ')})`)
        params.push(...q.trust)
      }
      const whereSql = ` WHERE ${where.join(' AND ')}`
      const total = this.count(`SELECT COUNT(*) AS c FROM memories${whereSql}`, params)
      const rows = this.many(
        `SELECT * FROM memories${whereSql}
         ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      )
      return { items: rows.map(memoryFromRow), total, offset, limit }
    })
  }

  listMemoriesForSearch(
    projectId: Id,
    types: MemoryType[] | undefined,
    includeStale: boolean,
    limit: number
  ): MemoryRecord[] {
    return this.wrap('listMemoriesForSearch', 'memories', () => {
      const lim = clampInt(limit, 1, 200, 200)
      const where: string[] = ['project_id = ?']
      const params: SqlValue[] = [projectId]
      if (types && types.length > 0) {
        where.push(`type IN (${types.map(() => '?').join(', ')})`)
        params.push(...types)
      }
      // Invalid memories are never retrieval candidates. `includeStale` only
      // widens the window from active-only to active + stale.
      if (includeStale) {
        where.push("status <> 'invalid'")
      } else {
        where.push("status = 'active'")
      }
      const whereSql = ` WHERE ${where.join(' AND ')}`
      const rows = this.many(
        `SELECT * FROM memories${whereSql}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        [...params, lim]
      )
      return rows.map(memoryFromRow)
    })
  }

  memoryStats(projectId: Id): MemoryStats {
    return this.wrap('memoryStats', 'memories', () => {
      const byType: Record<MemoryType, number> = {
        schema: 0,
        business: 0,
        user_confirmed: 0,
        task: 0,
        sql: 0,
        operation: 0
      }
      const byTrust: Record<MemoryTrust, number> = {
        user_confirmed: 0,
        verified: 0,
        ai_inferred: 0,
        unverified: 0
      }
      for (const row of this.many(
        'SELECT type, COUNT(*) AS c FROM memories WHERE project_id = ? GROUP BY type',
        [projectId]
      )) {
        const key = asText(row.type)
        if (key in byType) byType[key as MemoryType] = asInt(row.c, 0)
      }
      for (const row of this.many(
        'SELECT trust, COUNT(*) AS c FROM memories WHERE project_id = ? GROUP BY trust',
        [projectId]
      )) {
        const key = asText(row.trust)
        if (key in byTrust) byTrust[key as MemoryTrust] = asInt(row.c, 0)
      }
      const total = this.count('SELECT COUNT(*) AS c FROM memories WHERE project_id = ?', [projectId])
      const stale = this.count(
        "SELECT COUNT(*) AS c FROM memories WHERE project_id = ? AND status = 'stale'",
        [projectId]
      )
      const invalid = this.count(
        "SELECT COUNT(*) AS c FROM memories WHERE project_id = ? AND status = 'invalid'",
        [projectId]
      )
      const lastUpdatedAt = asNullableText(
        this.one('SELECT MAX(updated_at) AS v FROM memories WHERE project_id = ?', [projectId])?.v
      )
      return { total, byType, byTrust, stale, invalid, lastUpdatedAt }
    })
  }

  bumpMemoryUsage(id: Id, delta: number): void {
    this.wrap('bumpMemoryUsage', 'memories', () => {
      const step = asInt(delta, 0)
      this.run(
        `UPDATE memories
         SET use_count = MAX(0, use_count + ?), last_used_at = ?
         WHERE id = ?`,
        [step, nowIso(), id]
      )
    })
  }

  expireMemories(projectId: Id, status: MemoryStatus, reason: string, onlyUntrusted: boolean): number {
    return this.wrap('expireMemories', 'memories', () => {
      // invalid is terminal: never demote invalid -> stale. stale only replaces
      // active rows so repeated schema diffs stay idempotent.
      const statusClause = status === 'invalid' ? "status <> 'invalid'" : "status = 'active'"
      const trustClause = onlyUntrusted ? " AND trust IN ('ai_inferred', 'unverified')" : ''
      return this.run(
        `UPDATE memories
         SET status = ?, invalidated_reason = ?, updated_at = ?
         WHERE project_id = ? AND ${statusClause}${trustClause}`,
        [status, reason, nowIso(), projectId]
      )
    })
  }

  /* ------------------------------ agent tasks ----------------------- */

  insertTask(task: AgentTask): AgentTask {
    return this.wrap('insertTask', 'agent_tasks', () => {
      this.run(
        `INSERT INTO agent_tasks
          (id, project_id, connection_id, database_name, title, user_message, status,
           model_profile_id, decision_model_profile_id, steps_json, plan_json, final_answer, error, created_at,
           updated_at, finished_at, step_count, max_steps, tool_call_count,
           token_usage_json, approvals_json, context_budget_json, turns_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task.id,
          task.projectId,
          task.connectionId,
          task.database,
          task.title,
          task.userMessage,
          task.status,
          task.modelProfileId,
          task.decisionModelProfileId ?? null,
          JSON.stringify(task.steps ?? []),
          task.plan === undefined ? null : JSON.stringify(task.plan),
          task.finalAnswer ?? null,
          task.error ?? null,
          task.createdAt,
          task.updatedAt,
          task.finishedAt ?? null,
          task.stepCount,
          task.maxSteps,
          task.toolCallCount,
          task.tokenUsage === undefined ? null : JSON.stringify(task.tokenUsage),
          JSON.stringify(task.approvals ?? []),
          JSON.stringify(task.contextBudget ?? { usedChars: 0, limitChars: 0 }),
          JSON.stringify(task.turns ?? [])
        ]
      )
      return task
    })
  }

  updateTask(id: Id, patch: Partial<AgentTask>): AgentTask | null {
    return this.wrap('updateTask', 'agent_tasks', () => {
      const existing = this.getTask(id)
      if (!existing) return null
      const effective: Record<string, unknown> = { ...patch }
      if (effective.updatedAt === undefined) effective.updatedAt = nowIso()
      this.updateById('agent_tasks', id, TASK_FIELDS, effective)
      return this.getTask(id)
    })
  }

  getTask(id: Id): AgentTask | null {
    return this.wrap('getTask', 'agent_tasks', () => {
      const row = this.one('SELECT * FROM agent_tasks WHERE id = ?', [id])
      return row ? taskFromRow(row) : null
    })
  }

  listTasks(q: { projectId?: Id; limit: number }): ListResult<AgentTask> {
    return this.wrap('listTasks', 'agent_tasks', () => {
      const limit = clampInt(q.limit, 1, 1000, 50)
      const where = buildWhere([['project_id = ?', q.projectId]])
      const total = this.count(`SELECT COUNT(*) AS c FROM agent_tasks${where.sql}`, where.params)
      const rows = this.many(
        `SELECT * FROM agent_tasks${where.sql}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        [...where.params, limit]
      )
      return { items: rows.map(taskFromRow), total }
    })
  }

  deleteTask(id: Id): boolean {
    return this.wrap('deleteTask', 'agent_tasks', () => {
      const changes = this.run('DELETE FROM agent_tasks WHERE id = ?', [id])
      return changes > 0
    })
  }

  /* ------------------------------ jobs (restore) -------------------- */

  insertJob<T extends { id: Id }>(table: 'restore_jobs', job: T): T {
    return this.wrap('insertJob', table, () => {
      if (table !== 'restore_jobs') {
        throw new AppError('VALIDATION', `Unsupported job table: ${String(table)}`, {
          details: { table }
        })
      }
      const now = nowIso()
      const partial = job as unknown as Partial<RestoreJob> & { id: Id }
      this.run(
        `INSERT INTO restore_jobs
          (id, mode, backup_id, recovery_point_id, project_id, connection_id, source_database,
           target_database, temp_database, status, progress, steps_json, conflicts_json,
           started_at, finished_at, error, may_be_partial, log_path, verification_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          partial.id,
          partial.mode ?? 'undo_last',
          partial.backupId ?? null,
          partial.recoveryPointId ?? null,
          partial.projectId ?? null,
          partial.connectionId ?? '',
          partial.sourceDatabase ?? '',
          partial.targetDatabase ?? '',
          partial.tempDatabase ?? null,
          partial.status ?? 'preparing',
          partial.progress ?? 0,
          JSON.stringify(partial.steps ?? []),
          JSON.stringify(partial.conflicts ?? []),
          partial.startedAt ?? now,
          partial.finishedAt ?? null,
          partial.error ?? null,
          partial.mayBePartial ? 1 : 0,
          partial.logPath ?? null,
          partial.verification === undefined || partial.verification === null
            ? null
            : JSON.stringify(partial.verification)
        ]
      )
      return job
    })
  }

  updateJob(table: 'restore_jobs', id: Id, patch: Record<string, unknown>): void {
    this.wrap('updateJob', table, () => {
      if (table !== 'restore_jobs') {
        throw new AppError('VALIDATION', `Unsupported job table: ${String(table)}`, {
          details: { table }
        })
      }
      const changed = this.updateById('restore_jobs', id, JOB_FIELDS, patch)
      if (changed === 0) {
        const existing = this.one('SELECT id FROM restore_jobs WHERE id = ?', [id])
        if (!existing) {
          throw new AppError('NOT_FOUND', `Restore job not found: ${id}`, { details: { table } })
        }
      }
    })
  }

  getJob(table: 'restore_jobs', id: Id): RestoreJob | null {
    return this.wrap('getJob', table, () => {
      const row = this.one('SELECT * FROM restore_jobs WHERE id = ?', [id])
      return row ? restoreJobFromRow(row) : null
    })
  }

  listRestoreJobs(q: { projectId?: Id; limit: number }): ListResult<RestoreJob> {
    return this.wrap('listRestoreJobs', 'restore_jobs', () => {
      const limit = clampInt(q.limit, 1, 1000, 50)
      const where = buildWhere([['project_id = ?', q.projectId]])
      const total = this.count(`SELECT COUNT(*) AS c FROM restore_jobs${where.sql}`, where.params)
      const rows = this.many(
        `SELECT * FROM restore_jobs${where.sql}
         ORDER BY started_at DESC, id DESC LIMIT ?`,
        [...where.params, limit]
      )
      return { items: rows.map(restoreJobFromRow), total }
    })
  }

  /* ------------------------------ recovery points ------------------- */

  insertRecoveryPoint(point: RecoveryPoint): RecoveryPoint {
    return this.wrap('insertRecoveryPoint', 'recovery_points', () => {
      this.run(
        `INSERT INTO recovery_points
          (id, execution_id, plan_id, project_id, connection_id, database_name, kind, strategy,
           risk, target_tables_json, before_image_path, after_image_path, schema_snapshot_id,
           backup_id, captured_json, created_at, status, verified, verified_at, note, size_bytes,
           checksum, coverage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          point.id,
          point.executionId,
          point.planId,
          point.projectId,
          point.connectionId,
          point.database,
          point.kind,
          point.strategy,
          point.risk,
          JSON.stringify(point.targetTables ?? []),
          point.beforeImagePath ?? null,
          point.afterImagePath ?? null,
          point.schemaSnapshotId ?? null,
          point.backupId ?? null,
          JSON.stringify(point.captured ?? []),
          point.createdAt,
          point.status,
          point.verified ? 1 : 0,
          point.verifiedAt ?? null,
          point.note,
          point.sizeBytes,
          point.checksum ?? null,
          JSON.stringify(
            point.coverage ?? {
              hasOperationLog: true,
              hasBeforeImage: false,
              hasFullBackup: false,
              backupVerified: false
            }
          )
        ]
      )
      return point
    })
  }

  updateRecoveryPoint(id: Id, patch: Partial<RecoveryPoint>): RecoveryPoint {
    return this.wrap('updateRecoveryPoint', 'recovery_points', () => {
      const existing = this.getRecoveryPoint(id)
      if (!existing) {
        throw new AppError('NOT_FOUND', `Recovery point not found: ${id}`, {
          details: { table: 'recovery_points', id }
        })
      }
      this.updateById('recovery_points', id, RECOVERY_FIELDS, patch as Record<string, unknown>)
      return this.getRecoveryPoint(id) as RecoveryPoint
    })
  }

  getRecoveryPoint(id: Id): RecoveryPoint | null {
    return this.wrap('getRecoveryPoint', 'recovery_points', () => {
      const row = this.one('SELECT * FROM recovery_points WHERE id = ?', [id])
      return row ? recoveryPointFromRow(row) : null
    })
  }

  listRecoveryPoints(q: { projectId?: Id; connectionId?: Id; limit: number }): ListResult<RecoveryPoint> {
    return this.wrap('listRecoveryPoints', 'recovery_points', () => {
      const limit = clampInt(q.limit, 1, 1000, 100)
      const where = buildWhere([
        ['project_id = ?', q.projectId],
        ['connection_id = ?', q.connectionId]
      ])
      const total = this.count(`SELECT COUNT(*) AS c FROM recovery_points${where.sql}`, where.params)
      const rows = this.many(
        `SELECT * FROM recovery_points${where.sql}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        [...where.params, limit]
      )
      return { items: rows.map(recoveryPointFromRow), total }
    })
  }

  countRecoveryPointsReferencingBackup(backupId: Id): number {
    return this.wrap('countRecoveryPointsReferencingBackup', 'recovery_points', () => {
      return this.count('SELECT COUNT(*) AS c FROM recovery_points WHERE backup_id = ?', [backupId])
    })
  }

  markRecoveryPointsExpired(ids: Id[]): number {
    return this.wrap('markRecoveryPointsExpired', 'recovery_points', () => {
      const unique = [...new Set(ids)].filter((id) => typeof id === 'string' && id.length > 0)
      if (unique.length === 0) return 0
      // Placeholder count is derived from the array length; values stay bound.
      const placeholders = unique.map(() => '?').join(', ')
      return this.run(
        `UPDATE recovery_points SET status = 'expired'
         WHERE id IN (${placeholders}) AND status <> 'expired'`,
        unique
      )
    })
  }

  /* ------------------------------ backups --------------------------- */

  insertBackup(backup: BackupRecord): BackupRecord {
    return this.wrap('insertBackup', 'backups', () => {
      this.run(
        `INSERT INTO backups
          (id, project_id, connection_id, database_name, scope, tables_json, type, tool,
           file_path, file_name, file_size, checksum_sha256, schema_hash, server_version,
           status, verification_json, created_at, completed_at, error, retention_until,
           referenced_by_recovery_points)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          backup.id,
          backup.projectId,
          backup.connectionId,
          backup.database,
          backup.scope,
          JSON.stringify(backup.tables ?? []),
          backup.type,
          backup.tool,
          backup.filePath,
          backup.fileName,
          backup.fileSize,
          backup.checksumSha256,
          backup.schemaHash,
          backup.serverVersion,
          backup.status,
          JSON.stringify(
            backup.verification ?? {
              fileExists: false,
              nonEmpty: false,
              checksumOk: false,
              structureOk: false,
              tableCount: null,
              rowDataPresent: false,
              notes: []
            }
          ),
          backup.createdAt,
          backup.completedAt ?? null,
          backup.error ?? null,
          backup.retentionUntil ?? null,
          backup.referencedByRecoveryPoints
        ]
      )
      return backup
    })
  }

  updateBackup(id: Id, patch: Partial<BackupRecord>): BackupRecord {
    return this.wrap('updateBackup', 'backups', () => {
      const existing = this.getBackup(id)
      if (!existing) throw new AppError('NOT_FOUND', `Backup not found: ${id}`, { details: { table: 'backups', id } })
      this.updateById('backups', id, BACKUP_FIELDS, patch as Record<string, unknown>)
      return this.getBackup(id) as BackupRecord
    })
  }

  /** Always computes the live reference count from recovery_points. */
  private backupSelect(): string {
    return `SELECT b.*,
        (SELECT COUNT(*) FROM recovery_points r WHERE r.backup_id = b.id) AS ref_count
      FROM backups b`
  }

  getBackup(id: Id): BackupRecord | null {
    return this.wrap('getBackup', 'backups', () => {
      const row = this.one(`${this.backupSelect()} WHERE b.id = ?`, [id])
      return row ? backupFromRow(row) : null
    })
  }

  listBackups(q: { projectId?: Id; connectionId?: Id; limit: number }): ListResult<BackupRecord> {
    return this.wrap('listBackups', 'backups', () => {
      const limit = clampInt(q.limit, 1, 1000, 100)
      const where = buildWhere([
        ['b.project_id = ?', q.projectId],
        ['b.connection_id = ?', q.connectionId]
      ])
      const total = this.count(`SELECT COUNT(*) AS c FROM backups b${where.sql}`, where.params)
      const rows = this.many(
        `${this.backupSelect()}${where.sql}
         ORDER BY b.created_at DESC, b.id DESC LIMIT ?`,
        [...where.params, limit]
      )
      return { items: rows.map(backupFromRow), total }
    })
  }

  listExpiredBackups(now: IsoDate): BackupRecord[] {
    return this.wrap('listExpiredBackups', 'backups', () => {
      const rows = this.many(
        `${this.backupSelect()}
         WHERE b.retention_until IS NOT NULL AND b.retention_until <> ''
           AND b.retention_until <= ? AND b.status <> 'deleted'
         ORDER BY b.retention_until ASC, b.id ASC
         LIMIT 500`,
        [now]
      )
      return rows.map(backupFromRow)
    })
  }

  /* ------------------------------ model profiles -------------------- */

  listModelProfiles(): ModelProfile[] {
    return this.wrap('listModelProfiles', 'model_profiles', () => {
      const rows = this.many('SELECT * FROM model_profiles ORDER BY is_default DESC, name ASC, created_at ASC')
      return rows.map(modelProfileFromRow)
    })
  }

  getModelProfile(id: Id): ModelProfile | null {
    return this.wrap('getModelProfile', 'model_profiles', () => {
      const row = this.one('SELECT * FROM model_profiles WHERE id = ?', [id])
      return row ? modelProfileFromRow(row) : null
    })
  }

  saveModelProfile(profile: ModelProfile): ModelProfile {
    return this.wrap('saveModelProfile', 'model_profiles', () => {
      const stored: ModelProfile = {
        ...profile,
        id: profile.id || newId('mdl'),
        createdAt: profile.createdAt || nowIso(),
        updatedAt: profile.updatedAt || nowIso()
      }
      this.withTransaction(() => {
        if (stored.isDefault) {
          this.run('UPDATE model_profiles SET is_default = 0 WHERE id <> ?', [stored.id])
        }
        const rolesJson = JSON.stringify(
          Array.isArray(stored.roles) && stored.roles.length > 0 ? stored.roles : ['agent']
        )
        this.run(
          `INSERT INTO model_profiles
            (id, name, kind, base_url, model, api_key_stored, temperature, max_tokens,
             timeout_ms, tools_enabled, is_default, roles_json, notes, created_at, updated_at,
             last_test_at, last_test_ok)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             kind = excluded.kind,
             base_url = excluded.base_url,
             model = excluded.model,
             api_key_stored = excluded.api_key_stored,
             temperature = excluded.temperature,
             max_tokens = excluded.max_tokens,
             timeout_ms = excluded.timeout_ms,
             tools_enabled = excluded.tools_enabled,
             is_default = excluded.is_default,
             roles_json = excluded.roles_json,
             notes = excluded.notes,
             updated_at = excluded.updated_at,
             last_test_at = excluded.last_test_at,
             last_test_ok = excluded.last_test_ok`,
          [
            stored.id,
            stored.name,
            stored.kind,
            stored.baseUrl,
            stored.model,
            stored.apiKeyStored ? 1 : 0,
            stored.temperature,
            stored.maxTokens,
            stored.timeoutMs,
            stored.toolsEnabled ? 1 : 0,
            stored.isDefault ? 1 : 0,
            rolesJson,
            stored.notes,
            stored.createdAt,
            stored.updatedAt,
            stored.lastTestAt ?? null,
            stored.lastTestOk === undefined || stored.lastTestOk === null ? null : stored.lastTestOk ? 1 : 0
          ]
        )
      })
      return this.getModelProfile(stored.id) as ModelProfile
    })
  }

  deleteModelProfile(id: Id): void {
    this.wrap('deleteModelProfile', 'model_profiles', () => {
      const removed = this.run('DELETE FROM model_profiles WHERE id = ?', [id])
      if (removed === 0) return
      // Keep settings consistent: a deleted default profile must not dangle.
      const settings = this.getSettings()
      const patch: Partial<AppSettings> = {}
      if (settings.defaultModelProfileId === id) patch.defaultModelProfileId = null
      if (settings.defaultDecisionModelProfileId === id) patch.defaultDecisionModelProfileId = null
      if (Object.keys(patch).length) this.updateSettings(patch)
    })
  }

  getModelSecretCipher(profileId: Id): string | null {
    return this.wrap('getModelSecretCipher', 'model_profiles', () => {
      const row = this.one('SELECT secret_cipher FROM model_profiles WHERE id = ?', [profileId])
      return asNullableText(row?.secret_cipher)
    })
  }

  setModelSecretCipher(profileId: Id, cipher: string | null): void {
    this.wrap('setModelSecretCipher', 'model_profiles', () => {
      const changed = this.run(
        'UPDATE model_profiles SET secret_cipher = ?, api_key_stored = ?, updated_at = ? WHERE id = ?',
        [cipher, cipher ? 1 : 0, nowIso(), profileId]
      )
      if (changed === 0) {
        throw new AppError('NOT_FOUND', `Model profile not found: ${profileId}`, {
          details: { table: 'model_profiles', id: profileId }
        })
      }
    })
  }

  /* ------------------------------ audit ----------------------------- */

  insertAudit(event: AuditEvent): AuditEvent {
    return this.wrap('insertAudit', 'audit_events', () => {
      const stored: AuditEvent = {
        ...event,
        id: event.id || newId('aud'),
        ts: event.ts || nowIso()
      }
      this.run(
        `INSERT INTO audit_events
          (id, ts, actor, action, project_id, connection_id, target, risk, sql_preview,
           outcome, detail, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          stored.id,
          stored.ts,
          stored.actor,
          stored.action,
          stored.projectId ?? null,
          stored.connectionId ?? null,
          stored.target ?? null,
          stored.risk ?? null,
          stored.sqlPreview ?? null,
          stored.outcome,
          stored.detail ?? null,
          stored.metadata === undefined ? null : JSON.stringify(stored.metadata)
        ]
      )
      return stored
    })
  }

  listAudit(q: AuditQuery): PageResult<AuditEvent> {
    return this.wrap('listAudit', 'audit_events', () => {
      const limit = clampInt(q.limit, 1, 2000, 100)
      const offset = clampInt(q.offset, 0, 10_000_000, 0)
      const where = buildWhere([
        ['project_id = ?', q.projectId],
        ['connection_id = ?', q.connectionId],
        ['actor = ?', q.actor],
        ['outcome = ?', q.outcome]
      ])
      const total = this.count(`SELECT COUNT(*) AS c FROM audit_events${where.sql}`, where.params)
      const rows = this.many(
        `SELECT * FROM audit_events${where.sql}
         ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
        [...where.params, limit, offset]
      )
      return { items: rows.map(auditFromRow), total, offset, limit }
    })
  }
}
