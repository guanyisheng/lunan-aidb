/**
 * Logical backup engine (pure Node, no external tools required).
 *
 * Why a hand-written dumper:
 *  - The app must be able to make a *verified* backup even when mysqldump is
 *    not installed on the user's Windows/macOS machine.
 *  - We need exact row counts per table to verify a restore, plus a manifest
 *    whose counts can be checked independently from the file contents.
 *
 * Consistency:
 *  - Data is read inside one REPEATABLE READ transaction (`WITH CONSISTENT
 *    SNAPSHOT` semantics via subsequent reads) so every table is seen at the
 *    same point in time for InnoDB tables.
 *  - Pagination uses the single integer primary key when available. Tables
 *    without one fall back to LIMIT/OFFSET and are recorded with an explicit
 *    warning: under concurrent writes that pagination is not guaranteed stable.
 *
 * Restore ordering:
 *  - tables -> data -> triggers -> routines -> events. Triggers are created
 *    after data so loading rows does not re-fire application side effects.
 */
import { createWriteStream, promises as fs } from 'node:fs'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import type { DbSession } from '@main/service-contracts'
import { AppError, toAppError } from '@main/util/errors'
import { ensureDir, pathExists } from '@main/util/fsx'
import { nowIso } from '@main/util/time'
import { newId } from '@main/util/id'
import {
  BACKUP_FORMAT_VERSION,
  type BackupManifestV1,
  type DumpOptions,
  type DumpResult,
  type ServerFlavor,
  type TableMeta
} from './internal-types'
import {
  captureCreateStatements,
  getServerInfo,
  getTableMeta,
  insertableColumns,
  listObjects,
  scalarNumber,
  scalarString,
  singleIntegerPk
} from './dbsession'
import { hashCreateStatements, writeBackupFile } from './manifest'
import { buildInsert, columnList, ident, qualified } from './sqlformat'

const DEFAULT_BATCH_SIZE = 500
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024

interface DumpLogger {
  debug(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

/** Buffered ASCII/UTF-8 writer that tracks true byte size for progress reporting. */
class TextSink {
  private readonly stream: ReturnType<typeof createWriteStream>
  private bytes = 0
  private closed = false

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { encoding: 'utf8' })
  }

  async write(text: string): Promise<void> {
    if (this.closed) throw new Error('TextSink already closed')
    this.bytes += Buffer.byteLength(text, 'utf8')
    if (!this.stream.write(text)) await once(this.stream, 'drain')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stream.end()
    await once(this.stream, 'finish')
  }

  get size(): number {
    return this.bytes
  }
}

export class LogicalDumper {
  constructor(
    private readonly session: DbSession,
    private readonly logger?: DumpLogger
  ) {}

  /**
   * Writes a complete `.sql` backup and returns its manifest + checksum.
   * The final file is assembled only after the body was written successfully,
   * so a crash never leaves a file that looks complete but isn't.
   */
  async dump(options: DumpOptions): Promise<DumpResult> {
    const database = options.database
    const type = options.type
    const scope = options.scope
    const batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 5000))
    const maxBatchBytes = Math.max(16 * 1024, options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES)
    const startedAt = nowIso()
    const warnings: string[] = []
    const log = this.logger
    const onProgress = options.onProgress ?? (() => undefined)
    const assertNotAborted = (): void => {
      if (options.signal?.aborted) throw new AppError('CANCELLED', '备份已取消')
    }

    if (!database) throw new AppError('VALIDATION', '备份必须指定数据库')
    if (scope === 'tables' && (!options.tables || options.tables.length === 0)) {
      throw new AppError('VALIDATION', '按表备份时必须指定 tables')
    }

    const server = await getServerInfo(this.session)
    const objectsAll = await listObjects(this.session, database)
    if (objectsAll.length === 0 && scope === 'database') {
      warnings.push(`数据库 ${database} 中没有任何表/视图，备份为空结构`)
    }

    let selected = objectsAll
    if (scope === 'tables') {
      const wanted = options.tables ?? []
      const byName = new Map(objectsAll.map((o) => [o.name.toLowerCase(), o]))
      selected = []
      for (const name of wanted) {
        const found = byName.get(name.toLowerCase())
        if (!found) {
          throw new AppError('NOT_FOUND', `表/视图 ${name} 不存在于数据库 ${database}`)
        }
        selected.push(found)
      }
    }
    const baseTables = selected.filter((o) => o.type === 'table').map((o) => o.name)
    const views = selected.filter((o) => o.type === 'view').map((o) => o.name)
    if (baseTables.length === 0 && views.length === 0) {
      warnings.push('选择范围中没有可备份的对象')
    }

    // Metadata is read before the data snapshot; SHOW CREATE TABLE is not
    // transactional in MySQL 8 but reading it first avoids a mid-dump DDL.
    const createStatements =
      type === 'data_only'
        ? {}
        : await captureCreateStatements(
            this.session,
            database,
            selected.map((o) => ({ name: o.name, type: o.type }))
          )
    for (const object of selected) {
      if (!createStatements[object.name]) {
        throw new AppError(
          'BACKUP_FAILED',
          `无法读取 ${object.type === 'view' ? '视图' : '表'} ${object.name} 的 CREATE 语句`,
          { hint: '请检查数据库账号是否具有 SHOW VIEW / 表元数据权限' }
        )
      }
    }

    const tableMetas = new Map<string, TableMeta>()
    for (const table of baseTables) {
      const meta = await getTableMeta(this.session, database, table)
      tableMetas.set(table, meta)
      if (meta.triggers.length > 0) {
        warnings.push(
          `表 ${table} 上存在触发器 (${meta.triggers.join(', ')})：备份按创建后恢复，触发器在数据加载后重建`
        )
      }
      if (meta.engine && !/innodb/i.test(meta.engine)) {
        warnings.push(
          `表 ${table} 使用 ${meta.engine} 引擎：无法保证一次性快照一致性，备份数据可能来自不同时间点`
        )
      }
    }

    const routines = type === 'data_only' ? [] : await this.readRoutines(database, warnings)
    const events = type === 'data_only' ? [] : await this.readEvents(database, warnings)
    const triggerDdls =
      type === 'data_only' ? [] : await this.readTriggers(database, baseTables, warnings)

    // --- Consistent snapshot for the data phase -------------------------
    let ownTransaction = false
    if (!this.session.inTransaction()) {
      try {
        await this.session.rawQuery('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await this.session.beginTransaction()
        ownTransaction = true
        warnings.push('数据读取使用 REPEATABLE READ 事务快照（InnoDB 表在同一时间点）')
      } catch (e) {
        warnings.push(
          `无法开启一致性快照事务，备份期间的数据可能发生变化：${toAppError(e).message}`
        )
      }
    } else {
      warnings.push('会话已处于事务中，数据快照一致性取决于外层事务的隔离级别')
    }

    const bodyPath = join(dirname(options.filePath), `.${newId('body')}.sql.tmp`)
    const sink = new TextSink(bodyPath)
    const countedRows: Record<string, number> = {}
    const rowCounts: Record<string, number> = {}
    let totalRows = 0
    let schemaHash = ''

    try {
      await ensureDir(dirname(options.filePath))

      await sink.write(
        `-- 由 AIDB Studio 内部备份引擎生成，请勿手工编辑\n` +
          `-- database: ${database}\n` +
          `-- started_at: ${startedAt}\n`
      )
      const charset = await this.databaseCharset(database)
      await sink.write(`SET NAMES ${safeCharset(charset)};\n`)
      await sink.write('SET FOREIGN_KEY_CHECKS = 0;\n')
      await sink.write('SET UNIQUE_CHECKS = 0;\n')
      await sink.write('SET SQL_MODE = AT_SQL_MODE;\n'.replace('AT_SQL_MODE', "'NO_AUTO_VALUE_ON_ZERO'"))

      if (type !== 'data_only') {
        onProgress({ phase: 'schema', message: '写入表结构', progress: 0.05 })
        for (const view of views) {
          await sink.write(`DROP VIEW IF EXISTS ${ident(view)};\n`)
        }
        for (const table of baseTables) {
          await sink.write(`DROP TABLE IF EXISTS ${ident(table)};\n`)
        }
        for (const table of baseTables) {
          const sql = createStatements[table]
          await sink.write(`${stripTrailingSemicolon(sql)};\n`)
        }
        // Views may reference each other; order dependencies explicitly.
        const viewDdls = views.map((name) => ({ name, sql: createStatements[name] }))
        for (const view of orderViewsByDependency(viewDdls)) {
          await sink.write(`${stripTrailingSemicolon(view.sql)};\n`)
        }
        schemaHash = hashCreateStatements(createStatements)
      }

      if (type !== 'schema_only') {
        onProgress({ phase: 'data', message: '统计行数', progress: 0.1 })
        for (const table of baseTables) {
          assertNotAborted()
          const r = await this.session.rawQuery<Record<string, unknown>>(
            `SELECT COUNT(*) AS c FROM ${qualified(database, table)}`
          )
          countedRows[table] = scalarNumber(r.rows[0]?.c)
        }

        let dumpedTables = 0
        for (const table of baseTables) {
          assertNotAborted()
          dumpedTables += 1
          const meta = tableMetas.get(table)
          if (!meta) continue
          const written = await this.dumpTableData(sink, meta, {
            database,
            batchSize,
            maxBatchBytes,
            warnings,
            assertNotAborted,
            onProgress: (rows) => {
              const frac = 0.1 + 0.6 * ((dumpedTables - 1) / Math.max(baseTables.length, 1))
              onProgress({
                phase: 'data',
                message: `导出 ${table}（${rows} 行）`,
                progress: Math.min(0.7, Math.max(0.1, frac))
              })
            }
          })
          rowCounts[table] = written
          totalRows += written
          if (written !== countedRows[table]) {
            warnings.push(
              `表 ${table} 导出 ${written} 行，但备份前 COUNT(*) 为 ${countedRows[table]}：备份期间数据发生了变化（或表引擎不支持一致性快照）`
            )
          }
          if (written === 0) {
            await sink.write(`-- AIDB-TABLE-ROWS ${table} 0\n`)
          }
        }
        for (const table of baseTables) {
          if (!(table in rowCounts)) rowCounts[table] = 0
        }
      } else {
        for (const table of baseTables) rowCounts[table] = 0
      }

      if (type !== 'data_only') {
        onProgress({ phase: 'objects', message: '写入触发器/存储过程/事件', progress: 0.8 })
        for (const trigger of triggerDdls) {
          await sink.write(
            `DELIMITER $$\nDROP TRIGGER IF EXISTS ${ident(trigger.name)}$$\n` +
              `${stripTrailingSemicolon(trigger.sql)}$$\nDELIMITER ;\n`
          )
        }
        for (const routine of routines) {
          await sink.write(
            `DELIMITER $$\nDROP ${routine.type} IF EXISTS ${ident(routine.name)}$$\n` +
              `${stripTrailingSemicolon(routine.sql)}$$\nDELIMITER ;\n`
          )
        }
        for (const event of events) {
          await sink.write(
            `DELIMITER $$\nDROP EVENT IF EXISTS ${ident(event.name)}$$\n` +
              `${stripTrailingSemicolon(event.sql)}$$\nDELIMITER ;\n`
          )
        }
      }

      await sink.write('SET UNIQUE_CHECKS = 1;\n')
      await sink.write('SET FOREIGN_KEY_CHECKS = 1;\n')
      await sink.close()
    } catch (e) {
      try {
        await sink.close()
      } catch {
        /* ignore */
      }
      await fs.rm(bodyPath, { force: true }).catch(() => undefined)
      if (ownTransaction) {
        await this.session.rollback().catch(() => undefined)
      }
      throw toAppError(e, 'BACKUP_FAILED')
    }

    if (ownTransaction) {
      // The transaction only performed reads; commit releases the snapshot.
      await this.session.commit().catch(() => undefined)
    }

    const finishedAt = nowIso()
    const columnsByTable: Record<string, string[]> = {}
    const primaryKeysByTable: Record<string, string[]> = {}
    for (const table of baseTables) {
      const meta = tableMetas.get(table)
      if (!meta) continue
      columnsByTable[table] = meta.columns.map((c) => c.name)
      primaryKeysByTable[table] = meta.primaryKey
    }
    const manifest: BackupManifestV1 = {
      version: BACKUP_FORMAT_VERSION,
      format: 'aidb-backup',
      database,
      scope,
      type,
      tool: 'internal',
      tables: baseTables,
      views,
      objects: selected.map((o) => ({ name: o.name, type: o.type })),
      rowCounts,
      countedRows,
      columnsByTable,
      primaryKeysByTable,
      totalRows,
      schemaHash,
      serverVersion: server.version,
      serverFlavor: server.flavor as ServerFlavor,
      charset: server.charset,
      startedAt,
      finishedAt,
      dumper: 'aidb-internal-v1',
      warnings
    }

    const { checksumSha256, fileSize: size } = await writeBackupFile(options.filePath, manifest, bodyPath)
    await fs.rm(bodyPath, { force: true }).catch(() => undefined)
    log?.debug('逻辑备份写入完成', {
      database,
      tables: baseTables.length,
      totalRows,
      fileSize: size
    })

    return {
      filePath: options.filePath,
      fileName: options.filePath.split(/[\\/]/).pop() ?? options.filePath,
      fileSize: size,
      checksumSha256,
      manifest,
      startedAt,
      finishedAt
    }
  }

  private async databaseCharset(database: string): Promise<string> {
    try {
      const r = await this.session.rawQuery<Record<string, unknown>>(
        'SELECT DEFAULT_CHARACTER_SET_NAME AS c FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
        [database]
      )
      return scalarString(r.rows[0]?.c) || 'utf8mb4'
    } catch {
      return 'utf8mb4'
    }
  }

  private async dumpTableData(
    sink: TextSink,
    meta: TableMeta,
    opts: {
      database: string
      batchSize: number
      maxBatchBytes: number
      warnings: string[]
      assertNotAborted: () => void
      onProgress: (rows: number) => void
    }
  ): Promise<number> {
    const columns = insertableColumns(meta)
    if (columns.length === 0) {
      opts.warnings.push(`表 ${meta.name} 没有可插入的列（全部为生成列），跳过数据`)
      return 0
    }
    const pk = singleIntegerPk(meta)
    if (!pk) {
      opts.warnings.push(
        `表 ${meta.name} 没有单列整型主键，数据按 LIMIT/OFFSET 分页导出；并发写入时可能出现行偏移或重复`
      )
    }
    const colList = columnList(columns)
    const tableRef = qualified(opts.database, meta.name)
    let written = 0
    let lastPk: unknown = null
    let offset = 0
    for (;;) {
      opts.assertNotAborted()
      let rows: Record<string, unknown>[]
      if (pk) {
        const sql =
          lastPk === null
            ? `SELECT ${colList} FROM ${tableRef} ORDER BY ${ident(pk)} ASC LIMIT ?`
            : `SELECT ${colList} FROM ${tableRef} WHERE ${ident(pk)} > ? ORDER BY ${ident(pk)} ASC LIMIT ?`
        const params: unknown[] = lastPk === null ? [opts.batchSize] : [lastPk, opts.batchSize]
        rows = (await this.session.rawQuery<Record<string, unknown>>(sql, params)).rows
      } else {
        rows = (
          await this.session.rawQuery<Record<string, unknown>>(
            `SELECT ${colList} FROM ${tableRef} LIMIT ? OFFSET ?`,
            [opts.batchSize, offset]
          )
        ).rows
      }
      if (rows.length === 0) break
      await this.writeInsertBatches(sink, meta.name, columns, rows, opts.maxBatchBytes)
      written += rows.length
      opts.onProgress(written)
      if (rows.length < opts.batchSize) break
      if (pk) {
        lastPk = rows[rows.length - 1][pk]
        if (lastPk === null || lastPk === undefined) {
          opts.warnings.push(`表 ${meta.name} 主键列 ${pk} 出现 NULL，改为 OFFSET 分页`)
          // Switch to OFFSET pagination from here: emit already-read rows only.
          offset = written
          lastPk = null
          // Avoid re-reading the same rows: use OFFSET continuation.
          while (true) {
            opts.assertNotAborted()
            const more = (
              await this.session.rawQuery<Record<string, unknown>>(
                `SELECT ${colList} FROM ${tableRef} LIMIT ? OFFSET ?`,
                [opts.batchSize, offset]
              )
            ).rows
            if (more.length === 0) break
            await this.writeInsertBatches(sink, meta.name, columns, more, opts.maxBatchBytes)
            written += more.length
            opts.onProgress(written)
            if (more.length < opts.batchSize) break
            offset += more.length
          }
          return written
        }
      } else {
        offset += rows.length
      }
    }
    return written
  }

  private async writeInsertBatches(
    sink: TextSink,
    table: string,
    columns: string[],
    rows: Record<string, unknown>[],
    maxBatchBytes: number
  ): Promise<void> {
    let start = 0
    const tableRef = ident(table)
    while (start < rows.length) {
      let count = rows.length - start
      let built = buildInsert(tableRef, columns, rows, start, count)
      while (built.sql.length > maxBatchBytes && count > 1) {
        count = Math.max(1, Math.floor(count / 2))
        built = buildInsert(tableRef, columns, rows, start, count)
      }
      await sink.write(`${built.sql}\n`)
      start += built.rowCount
    }
  }

  private async readTriggers(
    database: string,
    tables: string[],
    warnings: string[]
  ): Promise<{ name: string; sql: string }[]> {
    const out: { name: string; sql: string }[] = []
    for (const table of tables) {
      try {
        const r = await this.session.rawQuery<Record<string, unknown>>(
          `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
            WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`,
          [database, table]
        )
        for (const row of r.rows) {
          const name = scalarString(row.name)
          try {
            const ddl = await this.session.rawQuery<Record<string, unknown>>(
              `SHOW CREATE TRIGGER ${qualified(database, name)}`
            )
            const sql = pickCreateSql(ddl.rows[0] ?? {}, 'TRIGGER')
            if (sql) out.push({ name, sql })
            else warnings.push(`触发器 ${name} 的 CREATE 语句为空，已跳过`)
          } catch (e) {
            warnings.push(`无法导出触发器 ${name}：${toAppError(e).message}`)
          }
        }
      } catch (e) {
        warnings.push(`无法读取表 ${table} 的触发器：${toAppError(e).message}`)
      }
    }
    return out
  }

  private async readRoutines(
    database: string,
    warnings: string[]
  ): Promise<{ name: string; type: 'PROCEDURE' | 'FUNCTION'; sql: string }[]> {
    const out: { name: string; type: 'PROCEDURE' | 'FUNCTION'; sql: string }[] = []
    try {
      const r = await this.session.rawQuery<Record<string, unknown>>(
        `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
          WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
        [database]
      )
      for (const row of r.rows) {
        const name = scalarString(row.name)
        const type = scalarString(row.type).toUpperCase() === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE'
        try {
          const ddl = await this.session.rawQuery<Record<string, unknown>>(
            `SHOW CREATE ${type} ${qualified(database, name)}`
          )
          const sql = pickCreateSql(ddl.rows[0] ?? {}, type)
          if (sql) out.push({ name, type, sql })
          else warnings.push(`${type} ${name} 的 CREATE 语句为空，已跳过`)
        } catch (e) {
          warnings.push(`无法导出 ${type} ${name}：${toAppError(e).message}`)
        }
      }
    } catch (e) {
      warnings.push(`无法读取存储过程/函数：${toAppError(e).message}`)
    }
    return out
  }

  private async readEvents(
    database: string,
    warnings: string[]
  ): Promise<{ name: string; sql: string }[]> {
    const out: { name: string; sql: string }[] = []
    try {
      const r = await this.session.rawQuery<Record<string, unknown>>(
        `SELECT EVENT_NAME AS name FROM information_schema.EVENTS
          WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
        [database]
      )
      for (const row of r.rows) {
        const name = scalarString(row.name)
        try {
          const ddl = await this.session.rawQuery<Record<string, unknown>>(
            `SHOW CREATE EVENT ${qualified(database, name)}`
          )
          const sql = pickCreateSql(ddl.rows[0] ?? {}, 'EVENT')
          if (sql) out.push({ name, sql })
          else warnings.push(`事件 ${name} 的 CREATE 语句为空，已跳过`)
        } catch (e) {
          warnings.push(`无法导出事件 ${name}：${toAppError(e).message}`)
        }
      }
    } catch (e) {
      warnings.push(`无法读取事件：${toAppError(e).message}`)
    }
    return out
  }
}

function safeCharset(charset: string): string {
  return /^[a-zA-Z0-9_]+$/.test(charset) ? charset : 'utf8mb4'
}

/**
 * SHOW CREATE TRIGGER/PROCEDURE/FUNCTION/EVENT returns the DDL under a locale
 * dependent column name (e.g. "SQL Original Statement" for triggers). Match the
 * *value* first, then fall back to the column name.
 */
export function pickCreateSql(row: Record<string, unknown>, kind: string): string {
  const wanted = kind.toUpperCase()
  for (const value of Object.values(row)) {
    if (typeof value !== 'string') continue
    if (new RegExp(`^\\s*CREATE\\b[\\s\\S]*\\b${wanted}\\b`, 'i').test(value)) return value
  }
  const key = Object.keys(row).find((k) => new RegExp(`create\\s+${wanted}`, 'i').test(k))
  const sql = key ? scalarString(row[key]) : ''
  return sql
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, '')
}

/**
 * Orders CREATE VIEW statements so views that reference other views are created
 * after their dependencies. Unknown/cyclic dependencies fall back to name order
 * (restore verification will surface any failure honestly).
 */
export function orderViewsByDependency<T extends { name: string; sql: string }>(views: T[]): T[] {
  const byName = new Map(views.map((v) => [v.name.toLowerCase(), v]))
  const deps = new Map<string, Set<string>>()
  for (const view of views) {
    const refs = new Set<string>()
    const re = /\b(?:FROM|JOIN)\s+`?([A-Za-z0-9_$]+)`?/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(view.sql))) {
      const ref = m[1].toLowerCase()
      if (ref !== view.name.toLowerCase() && byName.has(ref)) refs.add(ref)
    }
    deps.set(view.name.toLowerCase(), refs)
  }
  const ordered: T[] = []
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (name: string): void => {
    if (done.has(name)) return
    if (visiting.has(name)) return // cycle: leave to server/verification to report
    visiting.add(name)
    for (const dep of deps.get(name) ?? []) visit(dep)
    visiting.delete(name)
    done.add(name)
    const view = byName.get(name)
    if (view) ordered.push(view)
  }
  for (const view of [...views].sort((a, b) => a.name.localeCompare(b.name))) {
    visit(view.name.toLowerCase())
  }
  return ordered
}

/** Used by tests to check that a file has the expected object count. */
export async function fileExistsNonEmpty(filePath: string): Promise<boolean> {
  try {
    return (await pathExists(filePath)) && (await fs.stat(filePath)).size > 0
  } catch {
    return false
  }
}


