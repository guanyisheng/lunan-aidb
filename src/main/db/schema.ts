/**
 * AIDB Studio - MySQL / MariaDB schema inspection service.
 *
 * Safety rules implemented here:
 *  - Schema data is read from `information_schema` plus `SHOW CREATE ...` only;
 *    business rows are never scanned by default.
 *  - Optional sampling runs only when the caller explicitly allows it, is capped
 *    to a small row limit, excludes sensitive-looking columns and records why in
 *    `SampledData.reason`.
 *  - `scan()` is a pure read operation: it builds and returns a SchemaSnapshot
 *    but does not persist it. The IPC layer owns persistence / project pointers /
 *    memory sync; `detectChanges()` is the one method that writes (per contract).
 *  - Canonical JSON + sha256 give stable table/snapshot hashes so diffs are
 *    order-independent.
 */
import type {
  CheckConstraintInfo,
  ColumnInfo,
  DatabaseInfo,
  ForeignKeyInfo,
  Id,
  IndexInfo,
  SampledData,
  SchemaChangeReport,
  SchemaDiff,
  SchemaDiffColumnChange,
  SchemaDiffTableChange,
  SchemaObjectType,
  SchemaSnapshot,
  SchemaSnapshotTable,
  TableDetails,
  TableSummary,
  TriggerInfo
} from '@shared/types'
import type {
  DbSession,
  Logger,
  SchemaScanOptions,
  SchemaService,
  Services
} from '../service-contracts'
import { AppError, isAppError } from '../util/errors'
import { newId } from '../util/id'
import { nowIso } from '../util/time'
import {
  clamp,
  columnSignature,
  foreignKeySignature,
  hashSnapshotShape,
  hashTableShape,
  indexSignature,
  isTimeoutError,
  qualifyId,
  quoteId,
  resolveServices,
  sortByName,
  stableStringify,
  toNumber,
  toNumberOrNull,
  toStringOrNull,
  toStringValue,
  validateDatabaseName,
  type ServicesSource
} from './internal'
import { DATABASE_LIST_SQL, isFilesystemArtifactName, mapDatabaseRows, REAL_TABLE_NAME_SQL } from './meta'

interface SchemaCapabilities {
  checks: 'mysql' | 'mariadb' | 'none'
}

/** Capability probe results are cached per session (DB family is stable). */
const capabilityCache = new WeakMap<DbSession, SchemaCapabilities>()

const SENSITIVE_COLUMN_PATTERNS: RegExp[] = [
  /pass(word)?/,
  /passwd/,
  /^pwd$/,
  /token/,
  /secret/,
  /api[_-]?key/,
  /access[_-]?key/,
  /private[_-]?key/,
  /phone/,
  /mobile/,
  /^tel(ephone)?$/,
  /e-?mail/,
  /id[_-]?card/,
  /idcard/,
  /ssn/,
  /social[_-]?security/,
  /bank/,
  /credit/,
  /card[_-]?no/,
  /cvv/,
  /密码/,
  /口令/,
  /密钥/,
  /令牌/,
  /手机/,
  /电话/,
  /邮箱/,
  /身份证/,
  /银行卡/
]

function isSensitiveColumn(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_COLUMN_PATTERNS.some((pattern) => pattern.test(lower))
}

function isCompatibilityError(error: unknown): boolean {
  if (!isAppError(error)) return false
  const details = error.details as { rawCode?: unknown; errno?: unknown } | undefined
  const code = typeof details?.rawCode === 'string' ? details.rawCode : ''
  const errno = typeof details?.errno === 'number' ? details.errno : null
  if (errno === 1054 || errno === 1146 || errno === 1109) return true
  return (
    code === 'ER_BAD_FIELD_ERROR' ||
    code === 'ER_NO_SUCH_TABLE' ||
    code === 'ER_UNKNOWN_TABLE' ||
    code === 'ER_PARSE_ERROR'
  )
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export class MySqlSchemaService implements SchemaService {
  private readonly servicesSource: ServicesSource

  constructor(services: ServicesSource) {
    this.servicesSource = services
  }

  private get services(): Services {
    return resolveServices(this.servicesSource)
  }

  private get logger(): Logger {
    return this.services.logger.child('db.schema')
  }

  /* --------------------------- databases ------------------------------- */

  async listDatabases(session: DbSession): Promise<DatabaseInfo[]> {
    const result = await session.rawQuery(DATABASE_LIST_SQL)
    return mapDatabaseRows(result.rows)
  }

  /* ----------------------------- tables -------------------------------- */

  async listTables(session: DbSession, database: string): Promise<TableSummary[]> {
    const db = validateDatabaseName(database)
    return this.loadTableSummaries(session, db)
  }

  async getTable(session: DbSession, database: string, table: string): Promise<TableDetails> {
    const db = validateDatabaseName(database)
    if (!table || table.includes('\u0000')) {
      throw new AppError('VALIDATION', '表名不能为空')
    }
    const summaries = await this.loadTableSummaries(session, db, table)
    const summary = summaries[0]
    if (!summary) {
      throw new AppError('NOT_FOUND', `表或视图不存在：${db}.${table}`)
    }
    return this.loadTableDetails(session, db, summary, false)
  }

  private async loadTableSummaries(
    session: DbSession,
    database: string,
    table?: string
  ): Promise<TableSummary[]> {
    const sql = `SELECT
        t.TABLE_NAME AS name,
        t.TABLE_TYPE AS tableType,
        t.ENGINE AS engine,
        t.TABLE_ROWS AS rowEstimate,
        t.DATA_LENGTH AS dataLength,
        t.INDEX_LENGTH AS indexLength,
        t.TABLE_COMMENT AS comment,
        t.TABLE_COLLATION AS tableCollation,
        c.CHARACTER_SET_NAME AS charset
      FROM information_schema.TABLES AS t
      LEFT JOIN information_schema.COLLATIONS AS c ON c.COLLATION_NAME = t.TABLE_COLLATION
      WHERE t.TABLE_SCHEMA = ?
        AND ${REAL_TABLE_NAME_SQL}${table !== undefined ? ' AND t.TABLE_NAME = ?' : ''}
      ORDER BY t.TABLE_NAME`
    const params: unknown[] = table !== undefined ? [database, table] : [database]
    const result = await session.rawQuery(sql, params)
    return result.rows
      .map((row) => this.mapTableSummary(row))
      .filter((summary) => !isFilesystemArtifactName(summary.name))
  }

  private mapTableSummary(row: Record<string, unknown>): TableSummary {
    const tableType = toStringValue(row.tableType).toUpperCase()
    const type: SchemaObjectType = tableType === 'VIEW' ? 'view' : 'table'
    const collation = toStringOrNull(row.tableCollation)
    const comment = toStringValue(row.comment)
    return {
      name: toStringValue(row.name),
      type,
      engine: toStringOrNull(row.engine),
      rowEstimate: toNumberOrNull(row.rowEstimate),
      dataLength: toNumberOrNull(row.dataLength),
      indexLength: toNumberOrNull(row.indexLength),
      comment,
      charset: toStringOrNull(row.charset),
      collation
    }
  }

  /* --------------------------- table details --------------------------- */

  private async loadTableDetails(
    session: DbSession,
    database: string,
    summary: TableSummary,
    includeRowCounts: boolean
  ): Promise<TableDetails> {
    const [columns, indexes, foreignKeys, checkConstraints, triggers] = await Promise.all([
      this.loadColumns(session, database, summary.name),
      this.loadIndexes(session, database, summary.name),
      this.loadForeignKeys(session, database, summary.name),
      this.loadCheckConstraints(session, database, summary.name),
      this.loadTriggers(session, database, summary.name)
    ])

    const primaryKeyInfo = indexes.find((index) => index.name === 'PRIMARY')
    const primaryKey = primaryKeyInfo ? [...primaryKeyInfo.columns] : []
    const uniqueSingleColumns = new Set(
      indexes
        .filter((index) => index.unique && index.columns.length === 1)
        .map((index) => index.columns[0])
    )
    for (const column of columns) {
      column.isPrimaryKey = primaryKey.includes(column.name)
      column.isUnique = column.isPrimaryKey || uniqueSingleColumns.has(column.name)
    }

    const createSql = await this.loadCreateSql(session, database, summary)
    const schemaHash = this.hashTable({
      name: summary.name,
      columns,
      indexes,
      foreignKeys,
      primaryKey
    })

    let rowCount: number | null = null
    if (includeRowCounts && summary.type === 'table') {
      rowCount = await this.countRows(session, database, summary.name)
    }

    return {
      ...summary,
      columns,
      indexes,
      foreignKeys,
      checkConstraints,
      triggers,
      primaryKey,
      createSql,
      rowCount,
      schemaHash
    }
  }

  private async loadColumns(
    session: DbSession,
    database: string,
    table: string
  ): Promise<ColumnInfo[]> {
    const withGeneration = `SELECT
        COLUMN_NAME AS name,
        DATA_TYPE AS dataType,
        COLUMN_TYPE AS columnType,
        IS_NULLABLE AS isNullable,
        COLUMN_DEFAULT AS defaultValue,
        COLUMN_KEY AS columnKey,
        EXTRA AS extra,
        GENERATION_EXPRESSION AS generationExpression,
        COLUMN_COMMENT AS comment,
        ORDINAL_POSITION AS ordinal,
        CHARACTER_SET_NAME AS charset,
        COLLATION_NAME AS collation
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`
    const withoutGeneration = withGeneration.replace('GENERATION_EXPRESSION AS generationExpression,', "NULL AS generationExpression,")

    let rows: Record<string, unknown>[]
    try {
      const result = await session.rawQuery(withGeneration, [database, table])
      rows = result.rows
    } catch (error) {
      if (!isCompatibilityError(error)) throw error
      this.logger.warn('information_schema.COLUMNS 不支持 GENERATION_EXPRESSION，已降级', {
        database,
        table
      })
      const result = await session.rawQuery(withoutGeneration, [database, table])
      rows = result.rows
    }

    return rows.map((row) => {
      const extra = toStringValue(row.extra).toLowerCase()
      const generation = toStringOrNull(row.generationExpression)
      const columnKey = toStringValue(row.columnKey).toUpperCase()
      return {
        name: toStringValue(row.name),
        dataType: toStringValue(row.dataType),
        columnType: toStringValue(row.columnType),
        nullable: toStringValue(row.isNullable).toUpperCase() === 'YES',
        defaultValue: toStringOrNull(row.defaultValue),
        isPrimaryKey: columnKey === 'PRI',
        isUnique: columnKey === 'UNI',
        isAutoIncrement: extra.includes('auto_increment'),
        isGenerated: extra.includes('generated') || (generation !== null && generation.length > 0),
        comment: toStringValue(row.comment),
        ordinal: toNumber(row.ordinal),
        charset: toStringOrNull(row.charset),
        collation: toStringOrNull(row.collation)
      }
    })
  }

  private async loadIndexes(
    session: DbSession,
    database: string,
    table: string
  ): Promise<IndexInfo[]> {
    const withExpression = `SELECT
        INDEX_NAME AS name,
        NON_UNIQUE AS nonUnique,
        INDEX_TYPE AS indexType,
        COLUMN_NAME AS columnName,
        EXPRESSION AS expression,
        SEQ_IN_INDEX AS seqInIndex,
        CARDINALITY AS cardinality
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`
    const withoutExpression = withExpression.replace('EXPRESSION AS expression,', 'NULL AS expression,')

    let rows: Record<string, unknown>[]
    try {
      const result = await session.rawQuery(withExpression, [database, table])
      rows = result.rows
    } catch (error) {
      if (!isCompatibilityError(error)) throw error
      const result = await session.rawQuery(withoutExpression, [database, table])
      rows = result.rows
    }

    interface Accumulator {
      name: string
      unique: boolean
      type: string
      columns: string[]
      cardinality: number | null
    }
    const map = new Map<string, Accumulator>()
    for (const row of rows) {
      const name = toStringValue(row.name)
      if (!name) continue
      const accumulator = map.get(name) ?? {
        name,
        unique: toNumber(row.nonUnique) === 0,
        type: toStringValue(row.indexType, 'BTREE'),
        columns: [],
        cardinality: null
      }
      const columnName = toStringOrNull(row.columnName)
      const expression = toStringOrNull(row.expression)
      accumulator.columns.push(columnName ?? (expression ? `(${expression})` : ''))
      const cardinality = toNumberOrNull(row.cardinality)
      if (cardinality !== null) accumulator.cardinality = cardinality
      map.set(name, accumulator)
    }

    return sortByName([...map.values()]).map((index) => ({
      name: index.name,
      unique: index.unique,
      type: index.type || 'BTREE',
      columns: index.columns,
      cardinality: index.cardinality
    }))
  }

  private async loadForeignKeys(
    session: DbSession,
    database: string,
    table: string
  ): Promise<ForeignKeyInfo[]> {
    const sql = `SELECT
        k.CONSTRAINT_NAME AS name,
        k.COLUMN_NAME AS columnName,
        k.ORDINAL_POSITION AS ordinal,
        k.REFERENCED_TABLE_SCHEMA AS referencedSchema,
        k.REFERENCED_TABLE_NAME AS referencedTable,
        k.REFERENCED_COLUMN_NAME AS referencedColumn,
        rc.UPDATE_RULE AS onUpdate,
        rc.DELETE_RULE AS onDelete
      FROM information_schema.KEY_COLUMN_USAGE AS k
      JOIN information_schema.REFERENTIAL_CONSTRAINTS AS rc
        ON rc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
       AND rc.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       AND rc.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`
    const result = await session.rawQuery(sql, [database, table])

    interface Accumulator {
      name: string
      columns: string[]
      referencedTable: string
      referencedColumns: string[]
      onUpdate: string
      onDelete: string
    }
    const map = new Map<string, Accumulator>()
    for (const row of result.rows) {
      const name = toStringValue(row.name)
      if (!name) continue
      const referencedTable = toStringValue(row.referencedTable)
      const referencedSchema = toStringOrNull(row.referencedSchema)
      const qualifiedReferenced =
        referencedSchema && referencedSchema !== database
          ? `${referencedSchema}.${referencedTable}`
          : referencedTable
      const accumulator = map.get(name) ?? {
        name,
        columns: [],
        referencedTable: qualifiedReferenced,
        referencedColumns: [],
        onUpdate: toStringValue(row.onUpdate, 'RESTRICT'),
        onDelete: toStringValue(row.onDelete, 'RESTRICT')
      }
      accumulator.columns.push(toStringValue(row.columnName))
      accumulator.referencedColumns.push(toStringValue(row.referencedColumn))
      map.set(name, accumulator)
    }
    return sortByName([...map.values()])
  }

  private async loadCheckConstraints(
    session: DbSession,
    database: string,
    table: string
  ): Promise<CheckConstraintInfo[]> {
    const capabilities = this.capabilitiesFor(session)
    if (capabilities.checks === 'none') return []

    if (capabilities.checks === 'mysql') {
      try {
        return await this.queryMysqlChecks(session, database, table)
      } catch (error) {
        if (!isCompatibilityError(error)) throw error
        capabilities.checks = 'mariadb'
      }
    }

    if (capabilities.checks === 'mariadb') {
      try {
        return await this.queryMariadbChecks(session, database, table)
      } catch (error) {
        if (!isCompatibilityError(error)) throw error
        capabilities.checks = 'none'
        this.logger.warn('无法读取 CHECK 约束（版本或权限限制），该字段将为空', {
          database,
          table
        })
        return []
      }
    }
    return []
  }

  private async queryMysqlChecks(
    session: DbSession,
    database: string,
    table: string
  ): Promise<CheckConstraintInfo[]> {
    const sql = `SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS expression
      FROM information_schema.TABLE_CONSTRAINTS AS tc
      JOIN information_schema.CHECK_CONSTRAINTS AS cc
        ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'
      ORDER BY tc.CONSTRAINT_NAME`
    const result = await session.rawQuery(sql, [database, table])
    return result.rows.map((row) => ({
      name: toStringValue(row.name),
      expression: toStringValue(row.expression)
    }))
  }

  private async queryMariadbChecks(
    session: DbSession,
    database: string,
    table: string
  ): Promise<CheckConstraintInfo[]> {
    const sql = `SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS expression
      FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY CONSTRAINT_NAME`
    const result = await session.rawQuery(sql, [database, table])
    return result.rows.map((row) => ({
      name: toStringValue(row.name),
      expression: toStringValue(row.expression)
    }))
  }

  private capabilitiesFor(session: DbSession): SchemaCapabilities {
    const cached = capabilityCache.get(session)
    if (cached) return cached
    const capabilities: SchemaCapabilities = {
      checks: session.serverFlavor === 'mariadb' ? 'mariadb' : 'mysql'
    }
    capabilityCache.set(session, capabilities)
    return capabilities
  }

  private async loadTriggers(
    session: DbSession,
    database: string,
    table: string
  ): Promise<TriggerInfo[]> {
    const sql = `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event,
        ACTION_STATEMENT AS statement
      FROM information_schema.TRIGGERS
      WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
      ORDER BY TRIGGER_NAME`
    const result = await session.rawQuery(sql, [database, table])
    return result.rows.map((row) => ({
      name: toStringValue(row.name),
      timing: toStringValue(row.timing),
      event: toStringValue(row.event),
      statement: toStringValue(row.statement)
    }))
  }

  private async loadCreateSql(
    session: DbSession,
    database: string,
    summary: TableSummary
  ): Promise<string> {
    const qualified = qualifyId(database, summary.name)
    const statements =
      summary.type === 'view'
        ? [`SHOW CREATE VIEW ${qualified}`, `SHOW CREATE TABLE ${qualified}`]
        : [`SHOW CREATE TABLE ${qualified}`, `SHOW CREATE VIEW ${qualified}`]
    for (const sql of statements) {
      try {
        const result = await session.rawQuery(sql)
        const row = result.rows[0]
        if (!row) continue
        const preferred = row['Create Table'] ?? row['Create View']
        if (typeof preferred === 'string' && preferred.length > 0) return preferred
        let best = ''
        for (const value of Object.values(row)) {
          if (typeof value === 'string' && /^\s*CREATE\s/i.test(value) && value.length > best.length) {
            best = value
          }
        }
        if (best.length > 0) return best
      } catch (error) {
        if (isTimeoutError(error)) throw error
        // Try the next SHOW CREATE variant; a missing SHOW privilege is not fatal
        // for the rest of the snapshot.
        this.logger.warn('读取 SHOW CREATE 失败', {
          database,
          table: summary.name,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return ''
  }

  private async countRows(session: DbSession, database: string, table: string): Promise<number | null> {
    try {
      const result = await session.rawQuery(
        `SELECT COUNT(*) AS c FROM ${qualifyId(database, table)}`,
        undefined,
        { timeoutMs: 15_000 }
      )
      return toNumberOrNull(result.rows[0]?.c)
    } catch (error) {
      if (isTimeoutError(error)) {
        this.logger.warn('统计行数超时，已跳过', { database, table })
      } else {
        this.logger.warn('统计行数失败，已跳过', {
          database,
          table,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      return null
    }
  }

  /* ------------------------------ scanning ----------------------------- */

  async scan(session: DbSession, options: SchemaScanOptions): Promise<SchemaSnapshot> {
    const database = validateDatabaseName(options.database)
    const progress = options.onProgress
    const includeRowCounts = options.includeRowCounts === true
    const sampling = options.sampling
    // Sampling needs BOTH: an explicit caller request (includeSampleRows) and the
    // permission gate (sampling.allowed, derived from settings by the IPC layer).
    const samplingAllowed = options.includeSampleRows === true && sampling?.allowed === true
    const sampled: SampledData[] = []

    progress?.({ phase: 'tables', message: `读取数据库 ${database} 的对象清单`, progress: 0.02 })
    const summaries = await this.loadTableSummaries(session, database)
    progress?.({
      phase: 'tables',
      message: `发现 ${summaries.length} 个表/视图`,
      progress: 0.08
    })

    const tables: SchemaSnapshotTable[] = []
    for (let index = 0; index < summaries.length; index += 1) {
      const summary = summaries[index]
      progress?.({
        phase: 'table',
        message: `扫描 ${summary.name}（${index + 1}/${summaries.length}）`,
        progress: 0.08 + (0.82 * index) / Math.max(1, summaries.length)
      })
      const details = await this.loadTableDetails(session, database, summary, includeRowCounts)
      tables.push({
        name: details.name,
        type: details.type,
        engine: details.engine,
        comment: details.comment,
        columns: details.columns,
        indexes: details.indexes,
        foreignKeys: details.foreignKeys,
        checkConstraints: details.checkConstraints,
        primaryKey: details.primaryKey,
        schemaHash: details.schemaHash
      })

      if (samplingAllowed && summary.type === 'table' && sampling) {
        const sample = await this.sampleTable(session, database, details, sampling)
        if (sample) sampled.push(sample)
      }
    }

    progress?.({ phase: 'hash', message: '计算结构哈希', progress: 0.95 })
    const schemaHash = this.hashSnapshot(tables)
    const version = this.nextSnapshotVersion(options.projectId ?? null)

    const snapshot: SchemaSnapshot = {
      id: newId('sch'),
      projectId: options.projectId ?? null,
      connectionId: session.connectionId,
      database,
      serverVersion: session.serverVersion,
      serverFlavor: session.serverFlavor,
      charset: session.charset,
      takenAt: nowIso(),
      schemaHash,
      objectCount: tables.length,
      tables,
      version,
      ...(sampled.length > 0 ? { sampled } : {})
    }
    progress?.({ phase: 'done', message: '结构扫描完成', progress: 1 })
    this.logger.info('Schema 扫描完成', {
      connectionId: session.connectionId,
      database,
      tables: tables.length,
      schemaHash,
      version
    })
    return snapshot
  }

  private nextSnapshotVersion(projectId: Id | null): number {
    if (!projectId) return 1
    try {
      const latest = this.services.store.getLatestSchemaSnapshot(projectId, false)
      return (latest?.version ?? 0) + 1
    } catch {
      return 1
    }
  }

  private async sampleTable(
    session: DbSession,
    database: string,
    table: TableDetails,
    sampling: NonNullable<SchemaScanOptions['sampling']>
  ): Promise<SampledData | null> {
    const maxRows = clamp(sampling.maxRows, 1, 1000)
    const blocked = new Set((sampling.blockedColumns ?? []).map((name) => name.toLowerCase()))
    const allowed: string[] = []
    const excluded: string[] = []
    for (const column of table.columns) {
      const lower = column.name.toLowerCase()
      if (blocked.has(lower) || isSensitiveColumn(column.name)) excluded.push(column.name)
      else allowed.push(column.name)
    }
    if (allowed.length === 0) {
      this.logger.warn('表的所有列都被判定为敏感列，已跳过抽样', { database, table: table.name })
      return null
    }
    const sql = `SELECT ${allowed.map((name) => quoteId(name)).join(', ')} FROM ${qualifyId(
      database,
      table.name
    )} LIMIT ${maxRows}`
    try {
      const result = await session.rawQuery(sql, undefined, { timeoutMs: 15_000 })
      const rows = result.rows.map((row) => allowed.map((column) => row[column]))
      return {
        table: table.name,
        columns: allowed,
        rows,
        limit: maxRows,
        reason:
          `Schema 扫描抽样：已由调用方允许抽样，最多读取 ${maxRows} 行；` +
          (excluded.length > 0
            ? `已排除敏感列（${excluded.join('、')}）。`
            : '未发现敏感列名。')
      }
    } catch (error) {
      this.logger.warn('抽样读取失败，已跳过该表', {
        database,
        table: table.name,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  /* ------------------------------- hashes ------------------------------ */

  hashTable(table: {
    name: string
    columns: unknown[]
    indexes: unknown[]
    foreignKeys: unknown[]
    primaryKey: string[]
  }): string {
    return hashTableShape(table)
  }

  hashSnapshot(tables: SchemaSnapshotTable[]): string {
    return hashSnapshotShape(tables)
  }

  /* -------------------------------- diff ------------------------------- */

  diff(a: SchemaSnapshot, b: SchemaSnapshot): SchemaDiff {
    const before = new Map(a.tables.map((table) => [table.name, table]))
    const after = new Map(b.tables.map((table) => [table.name, table]))

    const addedTables = [...after.keys()].filter((name) => !before.has(name)).sort()
    const removedTables = [...before.keys()].filter((name) => !after.has(name)).sort()

    const changedTables: SchemaDiffTableChange[] = []
    for (const [name, beforeTable] of before) {
      const afterTable = after.get(name)
      if (!afterTable) continue
      const change = this.diffTable(name, beforeTable, afterTable)
      if (change) changedTables.push(change)
    }
    changedTables.sort((left, right) => left.name.localeCompare(right.name))

    return {
      snapshotAId: a.id,
      snapshotBId: b.id,
      addedTables,
      removedTables,
      changedTables,
      identical: addedTables.length === 0 && removedTables.length === 0 && changedTables.length === 0,
      takenAtA: a.takenAt,
      takenAtB: b.takenAt
    }
  }

  private diffTable(
    name: string,
    before: SchemaSnapshotTable,
    after: SchemaSnapshotTable
  ): SchemaDiffTableChange | null {
    const beforeColumns = new Map(before.columns.map((column) => [column.name, column]))
    const afterColumns = new Map(after.columns.map((column) => [column.name, column]))
    const addedColumns: ColumnInfo[] = []
    const removedColumns: ColumnInfo[] = []
    const changedColumns: SchemaDiffColumnChange[] = []

    for (const [columnName, column] of afterColumns) {
      const previous = beforeColumns.get(columnName)
      if (!previous) addedColumns.push(column)
      else if (columnSignature(previous) !== columnSignature(column)) {
        changedColumns.push({ name: columnName, before: previous, after: column })
      }
    }
    for (const [columnName, column] of beforeColumns) {
      if (!afterColumns.has(columnName)) removedColumns.push(column)
    }

    const beforeIndexes = new Map(before.indexes.map((index) => [index.name, index]))
    const afterIndexes = new Map(after.indexes.map((index) => [index.name, index]))
    const addedIndexes: IndexInfo[] = []
    const removedIndexes: IndexInfo[] = []
    for (const [indexName, index] of afterIndexes) {
      const previous = beforeIndexes.get(indexName)
      if (!previous) addedIndexes.push(index)
      else if (indexSignature(previous) !== indexSignature(index)) {
        // SchemaDiff has no "changed index" slot; surface it as remove+add.
        removedIndexes.push(previous)
        addedIndexes.push(index)
      }
    }
    for (const [indexName, index] of beforeIndexes) {
      if (!afterIndexes.has(indexName)) removedIndexes.push(index)
    }

    const foreignKeysChanged =
      stableStringify(sortByName(before.foreignKeys).map(foreignKeySignature)) !==
      stableStringify(sortByName(after.foreignKeys).map(foreignKeySignature))
    const primaryKeyChanged =
      JSON.stringify(before.primaryKey) !== JSON.stringify(after.primaryKey)

    const metadataChanged = !this.sameTableMetadata(before, after)
    if (
      addedColumns.length === 0 &&
      removedColumns.length === 0 &&
      changedColumns.length === 0 &&
      addedIndexes.length === 0 &&
      removedIndexes.length === 0 &&
      !foreignKeysChanged &&
      !primaryKeyChanged &&
      !metadataChanged
    ) {
      return null
    }

    return {
      name,
      addedColumns: sortByName(addedColumns),
      removedColumns: sortByName(removedColumns),
      changedColumns: sortByName(changedColumns),
      addedIndexes: sortByName(addedIndexes),
      removedIndexes: sortByName(removedIndexes),
      foreignKeysChanged,
      primaryKeyChanged
    }
  }

  private sameTableMetadata(before: SchemaSnapshotTable, after: SchemaSnapshotTable): boolean {
    return (
      before.schemaHash === after.schemaHash &&
      before.type === after.type &&
      (before.engine ?? null) === (after.engine ?? null) &&
      (before.comment ?? '') === (after.comment ?? '') &&
      stableStringify(sortByName(before.checkConstraints)) ===
        stableStringify(sortByName(after.checkConstraints))
    )
  }

  /* --------------------------- change detection ------------------------ */

  async detectChanges(services: Services, projectId: Id): Promise<SchemaChangeReport> {
    const project = services.store.getProject(projectId)
    if (!project) throw new AppError('NOT_FOUND', `项目不存在：${projectId}`)
    if (!project.connectionId) {
      throw new AppError('VALIDATION', '项目未关联数据库连接，无法检测结构变化')
    }
    const connectionId = project.connectionId
    const previous = services.store.getLatestSchemaSnapshot(projectId, true)
    const storedDatabase =
      previous?.database ?? services.store.getConnectionRecord(connectionId)?.database ?? ''

    // A project has no database column in the shared contract; use the stored
    // snapshot / saved connection default, otherwise the currently selected
    // database of the session the user is working in.
    const session = await services.connections.openSession(
      connectionId,
      storedDatabase.length > 0 ? storedDatabase : undefined
    )
    const database = storedDatabase.length > 0 ? storedDatabase : session.database
    if (!database) {
      throw new AppError(
        'VALIDATION',
        '无法确定目标数据库，请先选择数据库并执行一次结构扫描',
        { hint: '项目尚未保存过结构快照，且连接未设置默认数据库。' }
      )
    }
    const live = await this.scan(session, {
      connectionId,
      database,
      projectId,
      includeRowCounts: false,
      includeSampleRows: false
    })

    if (!previous) {
      const stored = services.store.insertSchemaSnapshot(live)
      services.store.setProjectSnapshot(projectId, stored.id)
      this.logger.info('首次结构快照已保存', { projectId, snapshotId: stored.id, database })
      return {
        changed: false,
        diff: null,
        newSnapshot: stored,
        invalidatedMemories: 0,
        staleMemories: 0
      }
    }

    const diff = this.diff(previous, live)
    if (diff.identical) {
      this.logger.info('数据库结构与最近快照一致', { projectId, database })
      return {
        changed: false,
        diff,
        invalidatedMemories: 0,
        staleMemories: 0
      }
    }

    const stored = services.store.insertSchemaSnapshot({ ...live, version: (previous.version ?? 0) + 1 })
    services.store.setProjectSnapshot(projectId, stored.id)
    const memoryResult = await services.memory.applySchemaDiff(projectId, diff)
    services.events.emit('schema.changed', {
      projectId,
      connectionId,
      database,
      diff,
      invalidatedMemories: memoryResult.invalidated,
      at: nowIso()
    })
    this.logger.info('检测到数据库结构变化', {
      projectId,
      database,
      addedTables: diff.addedTables.length,
      removedTables: diff.removedTables.length,
      changedTables: diff.changedTables.length,
      invalidatedMemories: memoryResult.invalidated,
      staleMemories: memoryResult.stale
    })

    return {
      changed: true,
      diff,
      newSnapshot: stored,
      invalidatedMemories: memoryResult.invalidated,
      staleMemories: memoryResult.stale
    }
  }
}
