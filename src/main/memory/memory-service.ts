/**
 * AIDB Studio - local, model-agnostic project memory.
 *
 * Design:
 *  - Everything is persisted through `AppStore` (node:sqlite). This class keeps
 *    no authoritative state in memory, so a restart loses nothing.
 *  - Six memory types (schema / business / user_confirmed / task / sql /
 *    operation); every record carries source, timestamps, trust, confidence,
 *    refs, schema snapshot/hash, status and verification metadata.
 *  - Retrieval is keyword based (ASCII words + CJK character bigrams) with
 *    weighted field scoring. No vector service and no network are involved.
 *  - Trust rules: AI writes are `ai_inferred` by default; only an explicit user
 *    confirmation upgrades to `user_confirmed`. AI code never upgrades trust.
 *  - Schema drift: `applySchemaDiff` marks affected memories stale/invalid with
 *    a human readable reason; `syncSchemaMemory` keeps one compact memory per
 *    table (never one per column).
 */
import type {
  Id,
  MemoryInput,
  MemoryRecord,
  MemoryRef,
  MemorySearchHit,
  MemorySearchQuery,
  MemorySource,
  MemoryStats,
  MemoryStatus,
  MemoryTrust,
  MemoryType,
  SchemaDiff,
  SchemaSnapshot,
  SchemaSnapshotTable
} from '@shared/types'
import type { AppStore, Logger, MemoryService } from '../service-contracts'
import { AppError } from '../util/errors'
import { newId } from '../util/id'
import { nowIso } from '../util/time'

export const MEMORY_TYPES: readonly MemoryType[] = [
  'schema',
  'business',
  'user_confirmed',
  'task',
  'sql',
  'operation'
]

export const MEMORY_TRUST_LEVELS: readonly MemoryTrust[] = [
  'user_confirmed',
  'verified',
  'ai_inferred',
  'unverified'
]

const MEMORY_SOURCES: readonly MemorySource[] = ['user', 'agent', 'schema_scan', 'execution', 'import']
const MEMORY_STATUSES: readonly MemoryStatus[] = ['active', 'stale', 'invalid']
const REF_KINDS: readonly MemoryRef['kind'][] = [
  'table',
  'column',
  'connection',
  'execution',
  'backup',
  'recovery_point',
  'task',
  'snapshot'
]

export interface MemoryServiceOptions {
  store: AppStore
  logger?: Logger
}

/* ------------------------------------------------------------------ */
/* Small validation helpers                                            */
/* ------------------------------------------------------------------ */

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, n))
}

function fail(code: ConstructorParameters<typeof AppError>[0], message: string, hint?: string): never {
  throw new AppError(code, message, hint ? { hint } : undefined)
}

function requireNonEmptyString(value: unknown, field: string, max = 20000): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('VALIDATION', `字段 ${field} 不能为空`)
  }
  const trimmed = value.trim()
  if (trimmed.length > max) fail('VALIDATION', `字段 ${field} 超过最大长度 ${max}`)
  return trimmed
}

function requireMemoryType(value: unknown): MemoryType {
  if (typeof value !== 'string' || !MEMORY_TYPES.includes(value as MemoryType)) {
    fail('VALIDATION', `未知的记忆类型: ${String(value)}`)
  }
  return value as MemoryType
}

function optionalTrust(value: unknown): MemoryTrust | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !MEMORY_TRUST_LEVELS.includes(value as MemoryTrust)) {
    fail('VALIDATION', `未知的可信状态: ${String(value)}`)
  }
  return value as MemoryTrust
}

function normalizeTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return []
  if (!Array.isArray(tags)) fail('VALIDATION', 'tags 必须是字符串数组')
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (!t) continue
    if (t.length > 60) fail('VALIDATION', '单个标签长度不能超过 60')
    if (!out.includes(t)) out.push(t)
    if (out.length >= 30) break
  }
  return out
}

function normalizeRefs(refs: unknown): MemoryRef[] {
  if (refs === undefined || refs === null) return []
  if (!Array.isArray(refs)) fail('VALIDATION', 'refs 必须是对象数组')
  const out: MemoryRef[] = []
  for (const raw of refs) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.kind !== 'string' || !REF_KINDS.includes(r.kind as MemoryRef['kind'])) {
      fail('VALIDATION', `未知的记忆引用类型: ${String(r.kind)}`)
    }
    const ref: MemoryRef = { kind: r.kind as MemoryRef['kind'] }
    if (typeof r.id === 'string' && r.id.trim()) ref.id = r.id.trim().slice(0, 200)
    if (typeof r.database === 'string' && r.database.trim()) ref.database = r.database.trim().slice(0, 128)
    if (typeof r.table === 'string' && r.table.trim()) ref.table = r.table.trim().slice(0, 128)
    if (typeof r.column === 'string' && r.column.trim()) ref.column = r.column.trim().slice(0, 128)
    if (ref.kind === 'table' || ref.kind === 'column') {
      if (!ref.table) fail('VALIDATION', 'table/column 类型的引用必须包含 table 字段')
    }
    if (ref.kind === 'column' && !ref.column) fail('VALIDATION', 'column 类型的引用必须包含 column 字段')
    out.push(ref)
    if (out.length >= 50) break
  }
  return out
}

function normalizeConfidence(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) fail('VALIDATION', 'confidence 必须是 0-1 之间的数字')
  return Math.min(1, Math.max(0, n))
}

/* ------------------------------------------------------------------ */
/* Keyword tokenisation / scoring (exported for tests)                 */
/* ------------------------------------------------------------------ */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const ASCII_WORD = /[a-z0-9_$@.\-]+/g

/**
 * Tokenises a query for keyword scoring:
 *  - ASCII identifiers / words (also split on `_ . -` so `user_orders` matches
 *    `orders`), lower-cased.
 *  - CJK text is split into character bigrams (and the whole run when short),
 *    because Chinese has no whitespace delimiters.
 */
export function tokenize(text: string): string[] {
  if (typeof text !== 'string' || !text.trim()) return []
  const lower = text.toLowerCase()
  const out = new Set<string>()
  for (const match of lower.matchAll(ASCII_WORD)) {
    const word = match[0].replace(/[.\-]+$/, '')
    if (!word) continue
    if (word.length >= 2) out.add(word)
    if (/[_\-.]/.test(word)) {
      for (const part of word.split(/[_\-.]/)) {
        if (part.length >= 2) out.add(part)
      }
    }
  }
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      out.add(run)
      continue
    }
    if (run.length <= 8) out.add(run)
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return Array.from(out).slice(0, 64)
}

export interface NormalizedQuery {
  raw: string
  lower: string
  tokens: string[]
}

export function normalizeQuery(query: string): NormalizedQuery {
  const raw = (query ?? '').trim()
  return { raw, lower: raw.toLowerCase(), tokens: tokenize(raw) }
}

const TRUST_BONUS: Record<MemoryTrust, number> = {
  user_confirmed: 3,
  verified: 1.5,
  ai_inferred: 0,
  unverified: -0.5
}

const TYPE_WEIGHT: Record<MemoryType, number> = {
  schema: 0.9,
  business: 0.9,
  user_confirmed: 1,
  task: 0.75,
  sql: 0.8,
  operation: 0.6
}

/**
 * Scores one memory against an already-tokenised query. Exposed (pure) so the
 * ranking behaviour can be unit-tested without a database.
 */
export function scoreMemory(
  memory: MemoryRecord,
  query: NormalizedQuery,
  options: { includeStale?: boolean } = {}
): MemorySearchHit {
  const title = memory.title.toLowerCase()
  const content = memory.content.toLowerCase()
  const tags = memory.tags.map((t) => t.toLowerCase())
  const tableRefs = memory.refs
    .filter((r) => r.kind === 'table' && r.table)
    .map((r) => r.table!.toLowerCase())
  const columnRefs = memory.refs
    .filter((r) => r.kind === 'column' && r.column)
    .map((r) => `${r.table ?? ''}.${r.column ?? ''}`.toLowerCase())

  let score = 0
  const reasons: string[] = []
  const matched = new Set<string>()

  for (const token of query.tokens) {
    if (token.length < 2 && !/[\u3400-\u4dbf\u4e00-\u9fff]/.test(token)) continue
    let tokenScore = 0
    if (title.includes(token)) {
      tokenScore += 4
      reasons.push(`标题:${token}`)
    }
    if (tags.some((tag) => tag === token || tag.includes(token))) {
      tokenScore += 3
      reasons.push(`标签:${token}`)
    }
    if (tableRefs.some((table) => table === token || table.includes(token) || token.includes(table))) {
      tokenScore += 3.5
      reasons.push(`表:${token}`)
    }
    if (columnRefs.some((col) => col.includes(token))) {
      tokenScore += 2.5
      reasons.push(`字段:${token}`)
    }
    if (content.includes(token)) tokenScore += 1.2
    if (tokenScore > 0) {
      score += tokenScore
      matched.add(token)
    }
  }

  // Whole-phrase bonus for short precise queries.
  if (query.lower.length >= 2) {
    if (title.includes(query.lower)) score += 6
    if (content.includes(query.lower)) score += 2
  }

  // Schema memories that mention a table named in the query are prioritised.
  if (memory.type === 'schema') {
    const tableHit = tableRefs.find((table) => query.lower.includes(table) || matched.has(table))
    if (tableHit) {
      score += 5
      reasons.push(`schema命中表:${tableHit}`)
    } else if (matched.size === 0) {
      score = 0 // unrelated schema memory must not be injected for free
    }
  }

  const typeBase = TYPE_WEIGHT[memory.type] ?? 0.5
  if (score <= 0) {
    return { memory, score: 0, reason: 'no-keyword-match' }
  }
  score += typeBase
  score += TRUST_BONUS[memory.trust] ?? 0
  if (memory.status === 'stale') score *= 0.4

  // Slight recency / usage affinity; never enough to outweigh a real match.
  const updated = Date.parse(memory.updatedAt)
  if (Number.isFinite(updated)) {
    const ageDays = (Date.now() - updated) / 86_400_000
    if (ageDays <= 7) score += 0.6
    else if (ageDays <= 30) score += 0.3
  }
  score += Math.min(memory.useCount, 20) * 0.03
  if (memory.status === 'active' && options.includeStale) score += 0.05

  const reason =
    reasons.slice(0, 6).join(', ') +
    `${reasons.length ? '; ' : ''}trust:${memory.trust}${memory.status !== 'active' ? `; status:${memory.status}` : ''}`

  return {
    memory,
    score: Math.round(score * 1000) / 1000,
    reason
  }
}

/* ------------------------------------------------------------------ */
/* Schema memory helpers                                               */
/* ------------------------------------------------------------------ */

function sanitizeInline(value: unknown, max: number): string {
  if (value === undefined || value === null) return ''
  let text = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > max) text = text.slice(0, max - 1) + '…'
  return text
}

/** One compact, human/model readable memory body per table (never per column). */
export function buildSchemaMemoryContent(snapshot: SchemaSnapshot, table: SchemaSnapshotTable): string {
  const lines: string[] = []
  const kind = table.type === 'view' ? '视图' : '表'
  const headerBits: string[] = [`${kind} ${snapshot.database}.${table.name}`]
  if (table.engine) headerBits.push(`引擎=${table.engine}`)
  lines.push(headerBits.join(' | '))
  if (table.comment) lines.push(`说明: ${sanitizeInline(table.comment, 160)}`)

  const MAX_COLUMNS = 60
  const columns = table.columns.slice(0, MAX_COLUMNS).map((column) => {
    const flags: string[] = []
    if (column.isPrimaryKey) flags.push('PK')
    if (column.isAutoIncrement) flags.push('AUTO_INCREMENT')
    if (column.isUnique) flags.push('UNIQUE')
    if (!column.nullable) flags.push('NOT NULL')
    if (column.defaultValue !== null && column.defaultValue !== undefined) {
      flags.push(`DEFAULT ${sanitizeInline(column.defaultValue, 40)}`)
    }
    const comment = column.comment ? ` // ${sanitizeInline(column.comment, 80)}` : ''
    return `${sanitizeInline(column.name, 64)} ${sanitizeInline(column.columnType, 80)}${
      flags.length ? ` ${flags.join(' ')}` : ''
    }${comment}`
  })
  lines.push(`列(${table.columns.length}): ${columns.join('; ')}`)
  if (table.columns.length > MAX_COLUMNS) {
    lines.push(`…其余 ${table.columns.length - MAX_COLUMNS} 列未展开，可用 inspect_schema 查看`)
  }

  if (table.primaryKey.length) lines.push(`主键: ${table.primaryKey.map((c) => sanitizeInline(c, 64)).join(', ')}`)
  if (table.indexes.length) {
    const idx = table.indexes
      .slice(0, 15)
      .map(
        (index) =>
          `${sanitizeInline(index.name, 64)}(${index.columns.map((c) => sanitizeInline(c, 64)).join(', ')})${
            index.unique ? ' UNIQUE' : ''
          }`
      )
    lines.push(`索引(${table.indexes.length}): ${idx.join('; ')}`)
  }
  if (table.foreignKeys.length) {
    const fks = table.foreignKeys
      .slice(0, 15)
      .map(
        (fk) =>
          `${sanitizeInline(fk.name, 64)}(${fk.columns.join(', ')}) -> ${sanitizeInline(fk.referencedTable, 64)}(${fk.referencedColumns.join(', ')}) ON UPDATE ${sanitizeInline(fk.onUpdate, 30)} ON DELETE ${sanitizeInline(fk.onDelete, 30)}`
      )
    lines.push(`外键(${table.foreignKeys.length}): ${fks.join('; ')}`)
  }
  if (table.checkConstraints.length) {
    const checks = table.checkConstraints
      .slice(0, 5)
      .map((c) => `${sanitizeInline(c.name, 64)} CHECK(${sanitizeInline(c.expression, 200)})`)
    lines.push(`检查约束(${table.checkConstraints.length}): ${checks.join('; ')}`)
  }
  lines.push(`结构哈希: ${table.schemaHash}`)
  lines.push(`快照: ${snapshot.id} @ ${snapshot.takenAt}`)

  const content = lines.join('\n')
  const MAX_CONTENT = 6000
  return content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT - 20) + '\n…内容已截断' : content
}

function emptyTypeCounts(): Record<MemoryType, number> {
  return MEMORY_TYPES.reduce(
    (acc, type) => {
      acc[type] = 0
      return acc
    },
    {} as Record<MemoryType, number>
  )
}

function emptyTrustCounts(): Record<MemoryTrust, number> {
  return MEMORY_TRUST_LEVELS.reduce(
    (acc, trust) => {
      acc[trust] = 0
      return acc
    },
    {} as Record<MemoryTrust, number>
  )
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export class SqliteMemoryService implements MemoryService {
  private readonly store: AppStore
  private readonly logger?: Logger

  constructor(deps: MemoryServiceOptions | AppStore, logger?: Logger) {
    if (isAppStoreLike(deps)) {
      this.store = deps
      this.logger = logger
    } else {
      this.store = deps.store
      this.logger = deps.logger
    }
  }

  /* ------------------------------ read ---------------------------- */

  async search(q: MemorySearchQuery): Promise<MemorySearchHit[]> {
    if (!q || typeof q !== 'object') fail('VALIDATION', '缺少检索参数')
    const projectId = requireNonEmptyString(q.projectId, 'projectId', 128)
    if (!this.store.getProject(projectId)) fail('NOT_FOUND', `项目不存在: ${projectId}`)
    const limit = clampInt(q.limit, 10, 1, 50)
    const includeStale = q.includeStale === true
    const types = Array.isArray(q.types) && q.types.length ? q.types.map((t) => requireMemoryType(t)) : undefined
    const fetchLimit = clampInt(Math.max(limit * 40, 200), 200, 200, 1000)
    const rows = this.store.listMemoriesForSearch(
      projectId,
      types,
      includeStale,
      fetchLimit
    )

    const normalized = normalizeQuery(typeof q.query === 'string' ? q.query : '')
    let hits: MemorySearchHit[]
    if (!normalized.raw) {
      // Empty query = "show me the most relevant recent memories".
      hits = rows
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, limit)
        .map((memory) => ({ memory, score: 0.5, reason: '最近更新的记忆' }))
    } else {
      hits = rows
        .map((memory) => scoreMemory(memory, normalized, { includeStale }))
        .filter((hit) => hit.score > 0.3)
        .sort((a, b) => b.score - a.score || Date.parse(b.memory.updatedAt) - Date.parse(a.memory.updatedAt))
        .slice(0, limit)
    }
    this.bumpUsage(hits.map((hit) => hit.memory.id))
    return hits
  }

  async searchForAgent(projectId: Id, query: string, limit = 6): Promise<MemorySearchHit[]> {
    return this.search({
      projectId,
      query: typeof query === 'string' ? query : '',
      limit: clampInt(limit, 6, 1, 20),
      includeStale: false
    })
  }

  list(q: {
    projectId: Id
    types?: MemoryType[]
    status?: MemoryStatus
    trust?: MemoryTrust[]
    limit: number
    offset: number
  }): ReturnType<AppStore['listMemories']> {
    const projectId = requireNonEmptyString(q?.projectId, 'projectId', 128)
    const status = q?.status
    if (status !== undefined && !MEMORY_STATUSES.includes(status)) {
      fail('VALIDATION', `未知的记忆状态: ${String(status)}`)
    }
    return this.store.listMemories({
      projectId,
      types: Array.isArray(q?.types) && q.types.length ? q.types.map((t) => requireMemoryType(t)) : undefined,
      status,
      trust: Array.isArray(q?.trust) && q.trust.length ? q.trust.map((t) => optionalTrust(t)!) : undefined,
      limit: clampInt(q?.limit, 50, 1, 500),
      offset: clampInt(q?.offset, 0, 0, 1_000_000)
    })
  }

  get(id: Id): MemoryRecord | null {
    if (typeof id !== 'string' || !id) return null
    return this.store.getMemory(id)
  }

  stats(projectId: Id): MemoryStats {
    const pid = requireNonEmptyString(projectId, 'projectId', 128)
    const raw = this.store.memoryStats(pid)
    return {
      total: raw?.total ?? 0,
      byType: { ...emptyTypeCounts(), ...(raw?.byType ?? {}) },
      byTrust: { ...emptyTrustCounts(), ...(raw?.byTrust ?? {}) },
      stale: raw?.stale ?? 0,
      invalid: raw?.invalid ?? 0,
      lastUpdatedAt: raw?.lastUpdatedAt ?? null
    }
  }

  /* ------------------------------ write --------------------------- */

  async create(input: MemoryInput): Promise<MemoryRecord> {
    if (!input || typeof input !== 'object') fail('VALIDATION', '缺少记忆内容')
    const projectId = requireNonEmptyString(input.projectId, 'projectId', 128)
    if (!this.store.getProject(projectId)) fail('NOT_FOUND', `项目不存在: ${projectId}`)
    const type = requireMemoryType(input.type)
    const title = requireNonEmptyString(input.title, 'title', 300)
    const content = requireNonEmptyString(input.content, 'content', 40_000)
    const source: MemorySource = input.source ?? 'agent'
    if (!MEMORY_SOURCES.includes(source)) fail('VALIDATION', `未知的记忆来源: ${String(source)}`)
    const requestedTrust = optionalTrust(input.trust)
    // AI-authored content is never born trusted. Only an explicit user
    // confirmation (`confirm()`) can produce `user_confirmed`.
    const trust: MemoryTrust = requestedTrust === 'user_confirmed' ? 'user_confirmed' : requestedTrust ?? 'ai_inferred'
    const confidence = normalizeConfidence(
      input.confidence,
      trust === 'user_confirmed' || trust === 'verified' ? 0.9 : type === 'schema' ? 0.95 : 0.55
    )
    const now = nowIso()
    const record: MemoryRecord = {
      id: newId('mem'),
      projectId,
      type,
      title,
      content,
      source,
      trust,
      confidence,
      tags: normalizeTags(input.tags),
      refs: normalizeRefs(input.refs),
      schemaSnapshotId: input.schemaSnapshotId ?? null,
      schemaHash: input.schemaHash ?? null,
      status: 'active',
      verifiedBy:
        trust === 'user_confirmed' ? 'user' : trust === 'verified' ? (source === 'execution' ? 'execution' : 'agent') : null,
      verifiedAt: trust === 'verified' || trust === 'user_confirmed' ? now : null,
      invalidatedReason: null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      useCount: 0,
      supersedesId: null
    }
    const saved = this.store.insertMemory(record)
    this.logger?.debug('memory created', { id: saved.id, type: saved.type, trust: saved.trust })
    return saved
  }

  update(id: Id, patch: Partial<MemoryInput> & { status?: MemoryStatus }): MemoryRecord {
    const existing = this.store.getMemory(requireNonEmptyString(id, 'id', 128))
    if (!existing) fail('NOT_FOUND', `记忆不存在: ${id}`)
    if (!patch || typeof patch !== 'object') fail('VALIDATION', '缺少更新内容')
    const changes: Partial<MemoryRecord> = {}

    if (patch.title !== undefined) changes.title = requireNonEmptyString(patch.title, 'title', 300)
    if (patch.content !== undefined) changes.content = requireNonEmptyString(patch.content, 'content', 40_000)
    if (patch.tags !== undefined) changes.tags = normalizeTags(patch.tags)
    if (patch.refs !== undefined) changes.refs = normalizeRefs(patch.refs)
    if (patch.confidence !== undefined) changes.confidence = normalizeConfidence(patch.confidence, existing.confidence)
    if (patch.schemaSnapshotId !== undefined) changes.schemaSnapshotId = patch.schemaSnapshotId ?? null
    if (patch.schemaHash !== undefined) changes.schemaHash = patch.schemaHash ?? null
    if (patch.type !== undefined) changes.type = requireMemoryType(patch.type)
    if (patch.source !== undefined) {
      if (!MEMORY_SOURCES.includes(patch.source)) fail('VALIDATION', `未知的记忆来源: ${String(patch.source)}`)
      changes.source = patch.source
    }
    if (patch.trust !== undefined) {
      const trust = optionalTrust(patch.trust)
      if (trust) {
        if (existing.trust === 'user_confirmed' && trust !== 'user_confirmed') {
          fail('VALIDATION', '已由用户确认的记忆不能被 AI/编辑降级为未确认状态')
        }
        changes.trust = trust
        if (trust === 'user_confirmed') {
          changes.verifiedBy = 'user'
          changes.verifiedAt = nowIso()
        } else if (trust !== 'verified') {
          changes.verifiedBy = null
          changes.verifiedAt = null
        }
      }
    }
    if (patch.status !== undefined) {
      if (!MEMORY_STATUSES.includes(patch.status)) fail('VALIDATION', `未知的记忆状态: ${String(patch.status)}`)
      changes.status = patch.status
      if (patch.status === 'active') changes.invalidatedReason = null
      else if (!existing.invalidatedReason) changes.invalidatedReason = '用户手动标记'
    }
    if (patch.projectId !== undefined && patch.projectId !== existing.projectId) {
      fail('VALIDATION', '记忆不能转移到其他项目')
    }
    changes.updatedAt = nowIso()
    const updated = this.store.updateMemory(existing.id, changes)
    this.logger?.debug('memory updated', { id: updated.id, status: updated.status })
    return updated
  }

  remove(id: Id): void {
    const existing = this.store.getMemory(requireNonEmptyString(id, 'id', 128))
    if (!existing) fail('NOT_FOUND', `记忆不存在: ${id}`)
    this.store.deleteMemory(existing.id)
    this.logger?.debug('memory deleted', { id: existing.id })
  }

  /** The only path that may upgrade trust to `user_confirmed`. */
  confirm(id: Id, content?: string): MemoryRecord {
    const existing = this.store.getMemory(requireNonEmptyString(id, 'id', 128))
    if (!existing) fail('NOT_FOUND', `记忆不存在: ${id}`)
    const now = nowIso()
    const changes: Partial<MemoryRecord> = {
      trust: 'user_confirmed',
      verifiedBy: 'user',
      verifiedAt: now,
      status: 'active',
      invalidatedReason: null,
      updatedAt: now
    }
    if (typeof content === 'string' && content.trim()) {
      changes.content = requireNonEmptyString(content, 'content', 40_000)
    }
    const updated = this.store.updateMemory(existing.id, changes)
    this.logger?.info('memory confirmed by user', { id: updated.id, type: updated.type })
    return updated
  }

  invalidate(id: Id, reason: string): MemoryRecord {
    const existing = this.store.getMemory(requireNonEmptyString(id, 'id', 128))
    if (!existing) fail('NOT_FOUND', `记忆不存在: ${id}`)
    const why = requireNonEmptyString(reason, 'reason', 1000)
    const updated = this.store.updateMemory(existing.id, {
      status: 'invalid',
      invalidatedReason: why,
      updatedAt: nowIso()
    })
    this.logger?.info('memory invalidated', { id: updated.id, reason: why })
    return updated
  }

  bumpUsage(ids: Id[]): void {
    if (!Array.isArray(ids) || !ids.length) return
    const now = nowIso()
    for (const id of Array.from(new Set(ids))) {
      try {
        this.store.bumpMemoryUsage(id, 1)
        this.store.updateMemory(id, { lastUsedAt: now })
      } catch (error) {
        this.logger?.warn('failed to bump memory usage', { id, error: String(error) })
      }
    }
  }

  /* -------------------------- schema drift ------------------------ */

  async applySchemaDiff(projectId: Id, diff: SchemaDiff): Promise<{ invalidated: number; stale: number }> {
    const pid = requireNonEmptyString(projectId, 'projectId', 128)
    if (!diff || typeof diff !== 'object') fail('VALIDATION', '缺少 schema diff')
    if (diff.identical) return { invalidated: 0, stale: 0 }

    const removedTables = new Set((diff.removedTables ?? []).map((t) => t.toLowerCase()))
    const changedTables = new Map<string, NonNullable<SchemaDiff['changedTables']>[number]>()
    for (const change of diff.changedTables ?? []) {
      changedTables.set(change.name.toLowerCase(), change)
    }
    const snapshotB = diff.snapshotBId ? this.store.getSchemaSnapshot(diff.snapshotBId, true) : null

    let invalidated = 0
    let stale = 0
    const now = nowIso()

    for (const memory of this.allProjectMemories(pid)) {
      if (memory.status === 'invalid') continue
      const reasons: string[] = []
      let invalid = false

      for (const ref of memory.refs) {
        if (ref.kind !== 'table' && ref.kind !== 'column') continue
        const table = (ref.table ?? '').toLowerCase()
        if (!table) continue
        if (removedTables.has(table)) {
          reasons.push(`引用的表 \`${ref.table}\` 已被删除`)
          invalid = true
          continue
        }
        const change = changedTables.get(table)
        if (!change) {
          // Same table name, but the diff may report it only via foreign keys etc.
          continue
        }
        if (ref.kind === 'column' && ref.column) {
          const column = ref.column.toLowerCase()
          const removed = change.removedColumns.some((c) => c.name.toLowerCase() === column)
          const changed = change.changedColumns.find((c) => c.name.toLowerCase() === column)
          if (removed) {
            reasons.push(`引用的字段 \`${ref.table}.${ref.column}\` 已被删除`)
            invalid = true
            continue
          }
          if (changed) {
            const beforeType = changed.before?.columnType ?? ''
            const afterType = changed.after?.columnType ?? ''
            if (beforeType !== afterType && memory.type === 'sql') {
              reasons.push(`SQL 记忆引用的字段 \`${ref.table}.${ref.column}\` 类型已变更 (${beforeType} -> ${afterType})`)
              invalid = true
            } else {
              reasons.push(`引用的字段 \`${ref.table}.${ref.column}\` 定义已变化`)
            }
            continue
          }
          if (change.primaryKeyChanged) reasons.push(`表 \`${ref.table}\` 主键已变化，字段引用需重新验证`)
          else if (change.foreignKeysChanged) reasons.push(`表 \`${ref.table}\` 外键已变化，字段引用需重新验证`)
          else if (change.addedColumns.length || change.addedIndexes.length || change.removedIndexes.length) {
            reasons.push(`表 \`${ref.table}\` 结构已变化`)
          }
          continue
        }
        // table-level reference
        if (change.removedColumns.length) reasons.push(`表 \`${ref.table}\` 有字段被删除`)
        if (change.changedColumns.length) reasons.push(`表 \`${ref.table}\` 有字段定义变化`)
        if (change.primaryKeyChanged) reasons.push(`表 \`${ref.table}\` 主键已变化`)
        if (change.foreignKeysChanged) reasons.push(`表 \`${ref.table}\` 外键已变化`)
        if (change.addedColumns.length || change.addedIndexes.length || change.removedIndexes.length) {
          reasons.push(`表 \`${ref.table}\` 结构已变化`)
        }
      }

      // Memories without precise refs but pinned to an older snapshot.
      if (!reasons.length && memory.schemaSnapshotId && snapshotB) {
        if (memory.schemaSnapshotId !== snapshotB.id) {
          reasons.push(`schema 快照已更新（${memory.schemaSnapshotId} -> ${snapshotB.id}），需重新验证`)
        }
      }
      if (!reasons.length && !memory.schemaSnapshotId && memory.schemaHash && snapshotB) {
        if (memory.schemaHash !== snapshotB.schemaHash) {
          reasons.push('数据库结构哈希已变化，记忆可能过期')
        }
      }

      if (!reasons.length) continue
      const uniqueReasons = Array.from(new Set(reasons))
      const nextStatus: MemoryStatus = invalid ? 'invalid' : 'stale'
      if (memory.status === 'stale' && nextStatus === 'stale') {
        // Still refresh the reason, keep the counter stable.
        this.store.updateMemory(memory.id, {
          invalidatedReason: uniqueReasons.join('；').slice(0, 2000),
          updatedAt: now
        })
        continue
      }
      this.store.updateMemory(memory.id, {
        status: nextStatus,
        invalidatedReason: uniqueReasons.join('；').slice(0, 2000),
        updatedAt: now
      })
      if (nextStatus === 'invalid') invalidated++
      else stale++
    }

    this.logger?.info('memory schema diff applied', { projectId: pid, invalidated, stale })
    return { invalidated, stale }
  }

  async syncSchemaMemory(snapshot: SchemaSnapshot): Promise<{ created: number; updated: number }> {
    if (!snapshot || typeof snapshot !== 'object') fail('VALIDATION', '缺少 schema snapshot')
    const projectId = snapshot.projectId
    if (!projectId) fail('VALIDATION', 'Schema 快照未关联项目，无法生成 schema 记忆')
    if (!this.store.getProject(projectId)) fail('NOT_FOUND', `项目不存在: ${projectId}`)
    if (!Array.isArray(snapshot.tables)) fail('VALIDATION', 'Schema 快照缺少表信息')

    const existing = this.store
      .listMemories({ projectId, types: ['schema'], limit: 5000, offset: 0 })
      .items
    const byKey = new Map<string, MemoryRecord>()
    for (const memory of existing) {
      const ref = memory.refs.find((r) => r.kind === 'table' && r.table)
      if (!ref?.table) continue
      byKey.set(`${(ref.database ?? snapshot.database).toLowerCase()}::${ref.table.toLowerCase()}`, memory)
    }

    const now = nowIso()
    let created = 0
    let updated = 0
    const seen = new Set<string>()

    for (const table of snapshot.tables) {
      const key = `${snapshot.database.toLowerCase()}::${table.name.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      const title = `${snapshot.database}.${table.name} (${table.type === 'view' ? '视图' : '表'})`
      const content = buildSchemaMemoryContent(snapshot, table)
      const refs: MemoryRef[] = [{ kind: 'table', database: snapshot.database, table: table.name }]
      const tags = ['schema', snapshot.database, table.type, table.name]
      const previous = byKey.get(key)

      if (previous) {
        const mergedTags = Array.from(new Set([...previous.tags, ...tags])).slice(0, 30)
        const changed =
          previous.title !== title ||
          previous.content !== content ||
          previous.schemaHash !== table.schemaHash ||
          previous.schemaSnapshotId !== snapshot.id ||
          previous.status !== 'active'
        if (!changed) continue
        const trust: MemoryTrust =
          previous.trust === 'user_confirmed' ? 'user_confirmed' : 'verified'
        this.store.updateMemory(previous.id, {
          title,
          content,
          tags: mergedTags,
          refs,
          schemaSnapshotId: snapshot.id,
          schemaHash: table.schemaHash,
          status: 'active',
          invalidatedReason: null,
          trust,
          verifiedBy: trust === 'user_confirmed' ? 'user' : 'execution',
          verifiedAt: previous.trust === 'user_confirmed' ? previous.verifiedAt ?? now : now,
          confidence: Math.max(previous.confidence, 0.95),
          updatedAt: now
        })
        updated++
        continue
      }

      this.store.insertMemory({
        id: newId('mem'),
        projectId,
        type: 'schema',
        title,
        content,
        source: 'schema_scan',
        trust: 'verified',
        confidence: 1,
        tags,
        refs,
        schemaSnapshotId: snapshot.id,
        schemaHash: table.schemaHash,
        status: 'active',
        verifiedBy: 'execution',
        verifiedAt: now,
        invalidatedReason: null,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        useCount: 0,
        supersedesId: null
      })
      created++
    }

    // Schema memories for tables that vanished from the latest snapshot.
    for (const [key, memory] of byKey) {
      if (seen.has(key)) continue
      if (!key.startsWith(`${snapshot.database.toLowerCase()}::`)) continue
      if (memory.status === 'invalid') continue
      this.store.updateMemory(memory.id, {
        status: 'stale',
        invalidatedReason: '该表未出现在最新 schema 快照中',
        updatedAt: now
      })
    }

    this.logger?.info('schema memory synced', { projectId, created, updated, tables: snapshot.tables.length })
    return { created, updated }
  }

  async recordTaskMemory(
    projectId: Id,
    payload: { title: string; content: string; refs?: MemoryRecord['refs']; trust?: MemoryTrust }
  ): Promise<MemoryRecord> {
    const pid = requireNonEmptyString(projectId, 'projectId', 128)
    if (!payload || typeof payload !== 'object') fail('VALIDATION', '缺少任务记忆内容')
    const trust = optionalTrust(payload.trust) ?? 'ai_inferred'
    return this.create({
      projectId: pid,
      type: 'task',
      title: payload.title,
      content: payload.content,
      source: 'agent',
      trust,
      tags: ['task', 'agent'],
      refs: payload.refs,
      confidence: trust === 'verified' ? 0.95 : 0.6
    })
  }

  /* ---------------------------- helpers --------------------------- */

  private allProjectMemories(projectId: Id): MemoryRecord[] {
    const out: MemoryRecord[] = []
    const pageSize = 200
    let offset = 0
    for (let guard = 0; guard < 50; guard++) {
      const page = this.store.listMemories({ projectId, limit: pageSize, offset })
      out.push(...page.items)
      if (page.items.length === 0) break
      offset += page.items.length
      if (offset >= page.total) break
    }
    return out
  }
}

function isAppStoreLike(value: unknown): value is AppStore {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as AppStore).getSettings === 'function' &&
    typeof (value as AppStore).insertMemory === 'function'
  )
}

/** Re-export a couple of internals for tests / other modules. */
export type { MemoryRecord, MemorySearchHit }
export const MEMORY_TYPE_LIST = MEMORY_TYPES
