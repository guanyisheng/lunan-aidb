/**
 * Shared "restore a dump into a fresh database" primitive.
 *
 * Used by:
 *  - BackupService.verify({restoreTest:true}) - proves the backup actually loads
 *    and that per-table row counts match the manifest;
 *  - RestoreService.toTempDatabase() - default, non-destructive restore path.
 *
 * The temporary database is only dropped by the caller; this helper reports
 * whether the drop succeeded so a failed verification never leaves silent
 * residue on the server.
 */
import type { Services } from '@main/service-contracts'
import type { Id } from '@shared/types'
import { AppError, toAppError } from '@main/util/errors'
import { nowIso } from '@main/util/time'
import {
  countAllRows,
  createDatabase,
  databaseExists,
  dropDatabase,
  listTables,
  tempDatabaseName
} from './dbsession'
import { openStandaloneSession } from './session-factory'
import { readBackupManifest } from './manifest'
import { executeSqlFile } from './sqlfile'

export interface TempRestoreResult {
  tempDatabase: string
  executedStatements: number
  tablesRestored: number
  rowsMatched: boolean
  rowMismatches: { table: string; expected: number; actual: number }[]
  passed: boolean
  notes: string[]
  dropped: boolean
  error: string | null
  startedAt: string
  finishedAt: string
}

export interface TempRestoreOptions {
  services: Services
  connectionId: Id
  sourceDatabase: string
  filePath: string
  prefix?: string
  /** Keep the temporary database after restore (default true; backups drop it). */
  keepDatabase?: boolean
  onProgress?: (p: { phase: string; message: string; progress: number }) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export async function restoreDumpToFreshDatabase(
  options: TempRestoreOptions
): Promise<TempRestoreResult> {
  const { services } = options
  const startedAt = nowIso()
  const notes: string[] = []
  const prefix = options.prefix ?? 'aidb_restore'
  const keepDatabase = options.keepDatabase ?? true

  const parsed = await readBackupManifest(options.filePath)
  if (!parsed.manifest) {
    return failure(
      options,
      nowIso(),
      null,
      0,
      `备份文件结构无效：${parsed.issues.join('; ') || '无法解析 manifest'}`
    )
  }
  const manifest = parsed.manifest

  let controlSession = null as Awaited<ReturnType<typeof openStandaloneSession>> | null
  let dataSession = null as Awaited<ReturnType<typeof openStandaloneSession>> | null
  let tempDatabase = ''
  let executed = 0
  let dropped = false
  try {
    controlSession = await openStandaloneSession(services, options.connectionId)
    // Pick a name that is guaranteed free at creation time.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = tempDatabaseName(prefix)
      if (!(await databaseExists(controlSession, candidate))) {
        tempDatabase = candidate
        break
      }
    }
    if (!tempDatabase) {
      throw new AppError('RESTORE_FAILED', '无法分配可用的临时数据库名')
    }
    await createDatabase(controlSession, tempDatabase, manifest.charset)
    notes.push(`已创建临时数据库 ${tempDatabase}（字符集 ${manifest.charset}）`)
    options.onProgress?.({ phase: 'create', message: `已创建临时数据库 ${tempDatabase}`, progress: 0.1 })

    dataSession = await openStandaloneSession(services, options.connectionId, tempDatabase)
    try {
      const exec = await executeSqlFile(dataSession, options.filePath, {
        signal: options.signal,
        onProgress: (p) => options.onProgress?.({ ...p, progress: 0.15 + Math.min(0.6, p.executed / 2000) }),
        log: (m, meta) => services.logger.debug(`[temp-restore] ${m}`, meta)
      })
      executed = exec.executed
      notes.push(`执行了 ${executed} 条 SQL`)
    } finally {
      // Session variables set by the dump must never leak into the pool.
      await dataSession.rawQuery('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined)
      await dataSession.release().catch(() => undefined)
      dataSession = null
    }

    options.onProgress?.({ phase: 'verify', message: '逐表核对行数', progress: 0.85 })
    const rowMismatches: { table: string; expected: number; actual: number }[] = []
    const liveTables = await listTables(controlSession, tempDatabase)
    for (const table of manifest.tables) {
      if (!liveTables.includes(table)) {
        rowMismatches.push({ table, expected: manifest.rowCounts[table] ?? 0, actual: -1 })
        notes.push(`表 ${table} 恢复后不存在`)
        continue
      }
      const actual = await countAllRows(controlSession, tempDatabase, table)
      const expected = manifest.rowCounts[table] ?? 0
      if (actual !== expected) {
        rowMismatches.push({ table, expected, actual })
        notes.push(`表 ${table} 行数不一致：期望 ${expected}，实际 ${actual}`)
      }
    }
    const tablesRestored = liveTables.length
    if (tablesRestored !== manifest.tables.length) {
      notes.push(`恢复后表数量 ${tablesRestored} 与 manifest ${manifest.tables.length} 不一致`)
    }
    const rowsMatched = rowMismatches.length === 0
    const passed = rowsMatched && tablesRestored === manifest.tables.length

    if (!keepDatabase) {
      try {
        await dropDatabase(controlSession, tempDatabase)
        dropped = true
        notes.push(`临时数据库 ${tempDatabase} 已删除`)
      } catch (e) {
        notes.push(`临时数据库 ${tempDatabase} 删除失败，请手工清理：${toAppError(e).message}`)
      }
    }

    return {
      tempDatabase,
      executedStatements: executed,
      tablesRestored,
      rowsMatched,
      rowMismatches,
      passed: passed && (keepDatabase || dropped),
      notes,
      dropped,
      error: null,
      startedAt,
      finishedAt: nowIso()
    }
  } catch (e) {
    const message = toAppError(e, 'RESTORE_FAILED').message
    if (!keepDatabase && controlSession && tempDatabase) {
      try {
        await dropDatabase(controlSession, tempDatabase)
        dropped = true
        notes.push(`失败后已删除临时数据库 ${tempDatabase}`)
      } catch (dropErr) {
        notes.push(`临时数据库 ${tempDatabase} 清理失败，可能残留：${toAppError(dropErr).message}`)
      }
    }
    return {
      tempDatabase,
      executedStatements: executed,
      tablesRestored: 0,
      rowsMatched: false,
      rowMismatches: [],
      passed: false,
      notes,
      dropped,
      error: message,
      startedAt,
      finishedAt: nowIso()
    }
  } finally {
    await dataSession?.release().catch(() => undefined)
    await controlSession?.release().catch(() => undefined)
  }
}

function failure(
  options: TempRestoreOptions,
  finishedAt: string,
  tempDatabase: string | null,
  executed: number,
  error: string
): TempRestoreResult {
  return {
    tempDatabase: tempDatabase ?? '',
    executedStatements: executed,
    tablesRestored: 0,
    rowsMatched: false,
    rowMismatches: [],
    passed: false,
    notes: [error],
    dropped: false,
    error,
    startedAt: nowIso(),
    finishedAt
  }
}

/** Human readable summary for job notes / UI. */
export function summarizeTempRestore(result: TempRestoreResult): string {
  if (result.error) return `恢复失败：${result.error}`
  return result.passed
    ? `恢复成功：${result.tablesRestored} 张表，行数全部匹配${result.tempDatabase ? `（临时库 ${result.tempDatabase}）` : ''}`
    : `恢复校验未通过：${result.notes.slice(-3).join('；')}`
}

export function asRestoreError(result: TempRestoreResult): AppError {
  return new AppError('RESTORE_FAILED', summarizeTempRestore(result), {
    details: {
      tempDatabase: result.tempDatabase || null,
      executedStatements: result.executedStatements,
      rowMismatches: result.rowMismatches,
      notes: result.notes
    }
  })
}



