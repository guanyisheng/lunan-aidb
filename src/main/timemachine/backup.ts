/**
 * BackupService implementation.
 *
 * Safety properties enforced here (they are the reason this file is long):
 *  - a backup record is only marked `verified`/`restore_tested` after the file
 *    was re-read, hashed, structurally checked, and (optionally) restored into
 *    a throw-away database whose row counts were compared with the manifest;
 *  - a failed verification is written back as `failed` - never silently kept as
 *    a success;
 *  - retention cleanup refuses to delete a backup still referenced by a
 *    recovery point unless the caller forces it.
 */
import { promises as fs } from 'node:fs'
import { statfsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AppSettings,
  BackupCreateRequest,
  BackupRecord,
  BackupStatus,
  BackupVerification,
  Id,
  IsoDate
} from '@shared/types'
import type { BackupService, Services } from '@main/service-contracts'
import { AppError, toAppError } from '@main/util/errors'
import {
  ensureDir,
  fileSize,
  freeDiskBytes,
  pathExists,
  removeFile,
  safeFileFragment
} from '@main/util/fsx'
import { addDays, fileStamp, nowIso } from '@main/util/time'
import { newId, shortHash } from '@main/util/id'
import { databaseExists, listObjects } from './dbsession'
import { resolveServices, type ServicesProvider } from './deps'
import { openStandaloneSession } from './session-factory'
import { LogicalDumper } from './dumper'
import type { BackupManifestV1 } from './internal-types'
import {
  hashCreateStatements,
  inspectBackupFile,
  readBackupManifest,
  scanDumpFile,
  writeBackupFile
} from './manifest'
import { findDumpToolSync, runMysqldump } from './mysqldump'
import { asRestoreError, restoreDumpToFreshDatabase, summarizeTempRestore } from './temprestore'

const BACKUP_DIR_FALLBACK_LIMIT = 100_000

export class MySqlBackupService implements BackupService {
  constructor(private readonly provider: ServicesProvider) {}

  private services(): Services {
    return resolveServices(this.provider)
  }

  private settings(): AppSettings {
    const services = this.services()
    try {
      return services.settings.get()
    } catch {
      return services.store.getSettings()
    }
  }

  /** Root backup directory: user setting first, then app default. */
  backupRoot(): string {
    const services = this.services()
    const settings = this.settings()
    const configured = settings.backupDir?.trim()
    return configured && configured.length > 0 ? configured : services.paths.backups
  }

  async create(
    req: BackupCreateRequest,
    ctx: {
      projectId?: Id | null
      emitProgress?: (p: { phase: string; message: string; progress: number }) => void
      signal?: AbortSignal
    }
  ): Promise<BackupRecord> {
    const services = this.services()
    const settings = this.settings()
    const log = services.logger.child('time-machine.backup')
    const emit = ctx.emitProgress ?? (() => undefined)
    if (!req.database) throw new AppError('VALIDATION', '备份必须指定数据库')
    const scope = req.scope ?? 'database'
    const type = req.type ?? 'full'
    const tableFilter = scope === 'tables' ? [...new Set(req.tables ?? [])] : undefined
    if (scope === 'tables' && (!tableFilter || tableFilter.length === 0)) {
      throw new AppError('VALIDATION', '按表备份时必须指定 tables')
    }

    const id = newId('bk')
    const startedAt = nowIso()
    const fileName = `${safeFileFragment(req.database, 40)}_${fileStamp()}_${shortHash(id, 6)}.sql`
    const dateDir = localDateStamp(new Date())
    const filePath = join(this.backupRoot(), safeFileFragment(req.database, 60), dateDir, fileName)
    await ensureDir(join(this.backupRoot(), safeFileFragment(req.database, 60), dateDir))

    emitJob(services, {
      jobId: id,
      kind: 'backup',
      status: 'running',
      phase: 'prepare',
      message: `开始备份 ${req.database}`,
      progress: 0
    })
    emit({ phase: 'prepare', message: `开始备份 ${req.database}`, progress: 0 })

    const useExternal = (process.env.AIDB_BACKUP_TOOL ?? '').toLowerCase() === 'mysqldump'
    const externalAvailable = findDumpToolSync().available
    let tool: 'internal' | 'mysqldump' = 'internal'
    const warnings: string[] = []
    if (useExternal && externalAvailable) tool = 'mysqldump'
    else if (useExternal && !externalAvailable) {
      warnings.push('AIDB_BACKUP_TOOL=mysqldump 但未检测到 mysqldump/mariadb-dump，已回退内部引擎')
    }

    let session = null as Awaited<ReturnType<typeof openStandaloneSession>> | null
    try {
      session = await openStandaloneSession(services, req.connectionId, req.database)
      if (!(await databaseExists(session, req.database))) {
        throw new AppError('NOT_FOUND', `数据库 ${req.database} 不存在`)
      }
      const liveObjects = await listObjects(session, req.database)
      let manifest: BackupManifestV1
      let checksumSha256: string
      let size: number
      if (tool === 'mysqldump') {
        try {
          const result = await this.dumpWithMysqldump({
            req,
            filePath,
            liveObjects,
            tableFilter,
            type,
            scope,
            emit
          })
          manifest = result.manifest
          checksumSha256 = result.checksumSha256
          size = result.fileSize
        } catch (e) {
          const message = toAppError(e, 'BACKUP_FAILED').message
          warnings.push(`外部 mysqldump 备份失败，已回退内部引擎：${message}`)
          log.warn('mysqldump 失败，回退内部引擎', { error: message })
          tool = 'internal'
          const dumped = await new LogicalDumper(session, {
            debug: (m, meta) => log.debug(m, meta),
            warn: (m, meta) => log.warn(m, meta)
          }).dump({
            database: req.database,
            filePath,
            scope,
            type,
            tables: tableFilter,
            tool: 'internal',
            onProgress: emit,
            signal: ctx.signal
          })
          manifest = dumped.manifest
          checksumSha256 = dumped.checksumSha256
          size = dumped.fileSize
        }
      } else {
        const dumped = await new LogicalDumper(session, {
          debug: (m, meta) => log.debug(m, meta),
          warn: (m, meta) => log.warn(m, meta)
        }).dump({
          database: req.database,
          filePath,
          scope,
          type,
          tables: tableFilter,
          tool: 'internal',
          onProgress: emit,
          signal: ctx.signal
        })
        manifest = dumped.manifest
        checksumSha256 = dumped.checksumSha256
        size = dumped.fileSize
      }
      manifest.warnings.push(...warnings)

      // Re-read the file we just wrote: never trust the writer's own claim.
      const inspection = await inspectBackupFile(filePath, checksumSha256)
      const verification = inspectionToVerification(inspection, false)
      const structurallyOk =
        inspection.fileExists &&
        inspection.nonEmpty &&
        inspection.checksumOk === true &&
        inspection.structureOk &&
        (type === 'schema_only' || inspection.rowDataPresent)
      const versionRow = await session.rawQuery<Record<string, unknown>>('SELECT VERSION() AS v')
      const serverVersion = String(versionRow.rows[0]?.v ?? session.serverVersion ?? '')
      const record = await this.insertRecord({
        ...req,
        projectId: req.projectId ?? ctx.projectId ?? null,
        id,
        database: req.database,
        scope,
        tables: manifest.tables,
        type,
        tool,
        filePath,
        fileName,
        fileSize: size,
        checksumSha256,
        schemaHash: manifest.schemaHash,
        serverVersion,
        status: structurallyOk ? 'completed' : 'failed',
        verification,
        error: structurallyOk ? null : `备份文件校验失败：${inspection.notes.join('; ')}`,
        startedAt
      })
      if (!structurallyOk) {
        emitJob(services, {
          jobId: id,
          kind: 'backup',
          status: 'failed',
          phase: 'verify',
          message: '备份文件结构校验失败',
          progress: 1,
          error: record.error ?? undefined
        })
        throw new AppError('BACKUP_FAILED', `备份文件校验失败：${inspection.notes.join('; ')}`, {
          details: { backupId: id, filePath }
        })
      }

      emitJob(services, {
        jobId: id,
        kind: 'backup',
        status: 'running',
        phase: 'verify',
        message: '启动备份完整性验证',
        progress: 0.85
      })
      if (req.verify !== false || req.restoreTest) {
        return await this.verify(id, { restoreTest: req.restoreTest === true })
      }
      audit(services, {
        action: 'backup.create',
        outcome: 'success',
        connectionId: req.connectionId,
        projectId: record.projectId,
        target: req.database,
        detail: `备份 ${req.database}（${manifest.tables.length} 表 / ${manifest.totalRows} 行），未执行额外校验`
      })
      emitJob(services, {
        jobId: id,
        kind: 'backup',
        status: 'completed',
        phase: 'done',
        message: `备份完成（${manifest.totalRows} 行）`,
        progress: 1
      })
      return record
    } catch (e) {
      const error = toAppError(e, 'BACKUP_FAILED')
      log.error('备份失败', { database: req.database, error: error.message })
      // Record the failure so the UI shows a real failed backup instead of nothing.
      const existing = safeGetBackup(services, id)
      if (!existing) {
        try {
          await this.insertRecord({
            ...req,
            projectId: req.projectId ?? ctx.projectId ?? null,
            id,
            database: req.database,
            scope,
            tables: tableFilter ?? [],
            type,
            tool,
            filePath,
            fileName,
            fileSize: await fileSize(filePath).catch(() => 0),
            checksumSha256: '',
            schemaHash: '',
            serverVersion: '',
            status: 'failed',
            verification: emptyVerification(),
            error: error.message,
            startedAt
          })
        } catch (recordErr) {
          log.error('无法写入失败备份记录', { error: toAppError(recordErr).message })
        }
      } else {
        services.store.updateBackup(id, { status: 'failed', error: error.message, completedAt: nowIso() })
      }
      audit(services, {
        action: 'backup.create',
        outcome: 'failure',
        connectionId: req.connectionId,
        projectId: req.projectId ?? ctx.projectId ?? null,
        target: req.database,
        detail: error.message
      })
      emitJob(services, {
        jobId: id,
        kind: 'backup',
        status: 'failed',
        phase: 'failed',
        message: error.message,
        progress: 1,
        error: error.message
      })
      throw error
    } finally {
      await session?.release().catch(() => undefined)
    }
  }

  private async dumpWithMysqldump(input: {
    req: BackupCreateRequest
    filePath: string
    liveObjects: { name: string; type: 'table' | 'view' }[]
    tableFilter?: string[]
    type: BackupCreateRequest['type']
    scope: 'database' | 'tables'
    emit: (p: { phase: string; message: string; progress: number }) => void
  }): Promise<{ manifest: BackupManifestV1; checksumSha256: string; fileSize: number }> {
    const services = this.services()
    const bodyPath = `${input.filePath}.${process.pid}.body.tmp`
    const credential = services.connections.credential(input.req.connectionId)
    input.emit({ phase: 'dump', message: '使用 mysqldump 导出', progress: 0.1 })
    const envTimeout = Number(process.env.AIDB_MYSQLDUMP_TIMEOUT_MS)
    const run = await runMysqldump({
      credential,
      ...(Number.isFinite(envTimeout) && envTimeout > 0 ? { timeoutMs: envTimeout } : {}),
      database: input.req.database,
      tables: input.tableFilter,
      bodyPath,
      type: input.type ?? 'full',
      redact: (text) => services.audit.redact(text)
    })
    try {
      const scan = await scanDumpFile(bodyPath)
      const tables =
        input.scope === 'tables'
          ? (input.tableFilter ?? []).filter((name) => input.liveObjects.find((o) => o.name === name)?.type !== 'view')
          : input.liveObjects.filter((o) => o.type === 'table').map((o) => o.name)
      const views =
        input.scope === 'tables'
          ? (input.tableFilter ?? []).filter((name) => input.liveObjects.find((o) => o.name === name)?.type === 'view')
          : input.liveObjects.filter((o) => o.type === 'view').map((o) => o.name)
      const manifest: BackupManifestV1 = {
        version: 1,
        format: 'aidb-backup',
        database: input.req.database,
        scope: input.scope,
        type: input.type ?? 'full',
        tool: 'mysqldump',
        tables,
        views,
        objects: [
          ...tables.map((name) => ({ name, type: 'table' as const })),
          ...views.map((name) => ({ name, type: 'view' as const }))
        ],
        rowCounts: Object.fromEntries(tables.map((t) => [t, scan.rowCountsByTable[t] ?? 0])),
        countedRows: Object.fromEntries(tables.map((t) => [t, scan.rowCountsByTable[t] ?? 0])),
        totalRows: Object.values(scan.rowCountsByTable).reduce((a, b) => a + b, 0),
        schemaHash: hashCreateStatements(scan.createStatements),
        serverVersion: run.toolName,
        serverFlavor: 'unknown',
        charset: 'utf8mb4',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        dumper: run.toolName,
        warnings: ['由外部工具 mysqldump/mariadb-dump 生成；行数从输出文件统计（未独立计数）']
      }
      const written = await writeBackupFile(input.filePath, manifest, bodyPath)
      return { manifest, checksumSha256: written.checksumSha256, fileSize: written.fileSize }
    } finally {
      await removeFile(bodyPath).catch(() => undefined)
    }
  }

  async verify(id: Id, opts: { restoreTest?: boolean }): Promise<BackupRecord> {
    const services = this.services()
    const backup = services.store.getBackup(id)
    if (!backup) throw new AppError('NOT_FOUND', `备份 ${id} 不存在`)
    if (backup.status === 'deleted') {
      throw new AppError('VALIDATION', '备份已删除，无法校验')
    }
    const emitJobSafe = (status: BackupStatus, phase: string, message: string, progress: number): void => {
      emitJob(services, {
        jobId: backup.id,
        kind: 'verify',
        status: status === 'failed' ? 'failed' : status === 'verified' || status === 'restore_tested' ? 'completed' : 'running',
        phase,
        message,
        progress
      })
    }
    emitJobSafe(backup.status, 'verify', '重新读取并校验备份文件', 0.1)

    const report = await this.performVerification(backup)
    const verification: BackupVerification = {
      ...report.verification,
      verifiedAt: report.ok ? nowIso() : null,
      restoreTestedAt: null,
      tempDatabase: null
    }

    if (!report.ok) {
      const error = `备份校验失败：${report.notes.join('; ')}`
      const updated = services.store.updateBackup(id, {
        status: 'failed',
        error,
        verification,
        completedAt: backup.completedAt ?? nowIso()
      })
      audit(services, {
        action: 'backup.verify',
        outcome: 'failure',
        connectionId: backup.connectionId,
        projectId: backup.projectId,
        target: `${backup.database}/${backup.fileName}`,
        detail: error
      })
      emitJobSafe('failed', 'verify', error, 1)
      return updated
    }

    if (opts.restoreTest) {
      emitJobSafe('verified', 'restore-test', '在临时数据库中执行恢复测试', 0.6)
      const restore = await restoreDumpToFreshDatabase({
        services,
        connectionId: backup.connectionId,
        sourceDatabase: backup.database,
        filePath: backup.filePath,
        prefix: 'aidb_verify',
        keepDatabase: false,
        onProgress: (p) =>
          emitJobSafe('verified', p.phase, p.message, 0.6 + Math.min(0.35, p.progress * 0.35))
      })
      verification.restoreTestedAt = restore.passed ? nowIso() : null
      verification.tempDatabase = restore.tempDatabase || null
      verification.notes.push(...restore.notes)
      if (!restore.passed) {
        const error = summarizeTempRestore(restore)
        const updated = services.store.updateBackup(id, {
          status: 'failed',
          error,
          verification: { ...verification, verifiedAt: null },
          completedAt: backup.completedAt ?? nowIso()
        })
        audit(services, {
          action: 'backup.verify_restore_test',
          outcome: 'failure',
          connectionId: backup.connectionId,
          projectId: backup.projectId,
          target: `${backup.database}/${backup.fileName}`,
          detail: error
        })
        emitJobSafe('failed', 'restore-test', error, 1)
        return updated
      }
      const updated = services.store.updateBackup(id, {
        status: 'restore_tested',
        error: null,
        verification
      })
      audit(services, {
        action: 'backup.verify_restore_test',
        outcome: 'success',
        connectionId: backup.connectionId,
        projectId: backup.projectId,
        target: `${backup.database}/${backup.fileName}`,
        detail: `恢复测试通过：${restore.tablesRestored} 表，行数一致`
      })
      emitJobSafe('restore_tested', 'restore-test', '恢复测试通过', 1)
      return updated
    }

    const updated = services.store.updateBackup(id, {
      status: 'verified',
      error: null,
      verification
    })
    audit(services, {
      action: 'backup.verify',
      outcome: 'success',
      connectionId: backup.connectionId,
      projectId: backup.projectId,
      target: `${backup.database}/${backup.fileName}`,
      detail: `校验通过：${verification.tableCount ?? 0} 张表`
    })
    emitJobSafe('verified', 'verify', '备份校验通过', 1)
    return updated
  }

  private async performVerification(backup: BackupRecord): Promise<{
    ok: boolean
    verification: BackupVerification
    notes: string[]
  }> {
    const inspection = await inspectBackupFile(backup.filePath, backup.checksumSha256 || null)
    const notes = [...inspection.notes]
    if (inspection.manifest && inspection.manifest.database !== backup.database) {
      notes.push(
        `manifest 数据库 ${inspection.manifest.database} 与备份记录数据库 ${backup.database} 不一致`
      )
    }
    const type = backup.type
    const ok =
      inspection.fileExists &&
      inspection.nonEmpty &&
      inspection.checksumOk === true &&
      inspection.structureOk &&
      (type === 'schema_only' || inspection.rowDataPresent) &&
      (!inspection.manifest || inspection.manifest.database === backup.database)
    return {
      ok,
      notes,
      verification: {
        fileExists: inspection.fileExists,
        nonEmpty: inspection.nonEmpty,
        checksumOk: inspection.checksumOk === true,
        structureOk: inspection.structureOk,
        tableCount: inspection.tableCount,
        rowDataPresent: inspection.rowDataPresent,
        verifiedAt: null,
        restoreTestedAt: null,
        tempDatabase: null,
        notes
      }
    }
  }

  private async insertRecord(input: {
    id: Id
    projectId: Id | null
    connectionId: Id
    database: string
    scope: 'database' | 'tables'
    tables: string[]
    type: 'full' | 'schema_only' | 'data_only'
    tool: 'internal' | 'mysqldump'
    filePath: string
    fileName: string
    fileSize: number
    checksumSha256: string
    schemaHash: string
    serverVersion: string
    status: BackupStatus
    verification: BackupVerification
    error: string | null
    startedAt: IsoDate
  }): Promise<BackupRecord> {
    const services = this.services()
    const settings = this.settings()
    const createdAt = input.startedAt
    const retentionDays = Number.isFinite(settings.retentionDays) ? settings.retentionDays : 30
    const record: BackupRecord = {
      id: input.id,
      projectId: input.projectId,
      connectionId: input.connectionId,
      database: input.database,
      scope: input.scope,
      tables: input.tables,
      type: input.type,
      tool: input.tool,
      filePath: input.filePath,
      fileName: input.fileName,
      fileSize: input.fileSize,
      checksumSha256: input.checksumSha256,
      schemaHash: input.schemaHash,
      serverVersion: input.serverVersion,
      status: input.status,
      verification: input.verification,
      createdAt,
      completedAt: input.status === 'failed' ? null : nowIso(),
      error: input.error,
      retentionUntil: retentionDays > 0 ? addDays(retentionDays, new Date(createdAt)) : null,
      referencedByRecoveryPoints: 0
    }
    return services.store.insertBackup(record)
  }

  get(id: Id): BackupRecord | null {
    return this.services().store.getBackup(id)
  }

  list(q: { projectId?: Id; connectionId?: Id; limit?: number }): {
    items: BackupRecord[]
    total: number
  } {
    return this.services().store.listBackups({
      ...q,
      limit: Math.max(1, Math.min(q.limit ?? 100, BACKUP_DIR_FALLBACK_LIMIT))
    })
  }

  async remove(id: Id, opts: { force?: boolean }): Promise<void> {
    const services = this.services()
    const backup = services.store.getBackup(id)
    if (!backup) throw new AppError('NOT_FOUND', `备份 ${id} 不存在`)
    if (backup.status === 'deleted') return
    const refs = services.store.countRecoveryPointsReferencingBackup(id)
    if (refs > 0 && !opts.force) {
      throw new AppError(
        'UNSAFE_OPERATION',
        `备份仍被 ${refs} 个恢复点引用，拒绝删除`,
        { hint: '恢复点依赖该备份进行完整恢复；确认要删除时使用 force（不推荐）' }
      )
    }
    await removeFile(backup.filePath)
    await removeFile(`${backup.filePath}.sha256`)
    services.store.updateBackup(id, { status: 'deleted', error: null })
    audit(services, {
      action: 'backup.delete',
      outcome: 'info',
      connectionId: backup.connectionId,
      projectId: backup.projectId,
      target: `${backup.database}/${backup.fileName}`,
      detail: refs > 0 ? `强制删除（${refs} 个恢复点引用，撤销/恢复将不可用）` : '删除备份及校验和侧车文件'
    })
  }

  stats(projectId?: Id): {
    count: number
    totalBytes: number
    backupDir: string
    freeBytes: number
    retentionDays: number
    maxBackupBytes: number
    dumperAvailable: boolean
  } {
    const services = this.services()
    const settings = this.settings()
    const all = services.store.listBackups({ projectId, limit: BACKUP_DIR_FALLBACK_LIMIT }).items
    const active = all.filter((b) => b.status !== 'deleted')
    const backupDir = this.backupRoot()
    let freeBytes = -1
    try {
      const st = statfsSync(backupDir)
      freeBytes = Number(st.bavail) * Number(st.bsize)
    } catch {
      freeBytes = 0
    }
    return {
      count: active.length,
      totalBytes: active.reduce((sum, b) => sum + (b.fileSize ?? 0), 0),
      backupDir,
      freeBytes,
      retentionDays: settings.retentionDays,
      maxBackupBytes: settings.maxBackupBytes,
      dumperAvailable: findDumpToolSync().available
    }
  }

  /** Async variant used by IPC when it wants a real disk-space number. */
  async statsAsync(projectId?: Id): Promise<ReturnType<MySqlBackupService['stats']>> {
    const base = this.stats(projectId)
    const free = await freeDiskBytes(base.backupDir)
    return { ...base, freeBytes: free }
  }

  async retentionSweep(): Promise<{
    deleted: Id[]
    freedBytes: number
    skippedReferenced: Id[]
    warnings: string[]
  }> {
    const services = this.services()
    const settings = this.settings()
    const warnings: string[] = []
    const deleted: Id[] = []
    const skippedReferenced: Id[] = []
    let freedBytes = 0
    const now = new Date()
    const retentionDays = Number.isFinite(settings.retentionDays) ? settings.retentionDays : 30
    const all = services.store.listBackups({ limit: BACKUP_DIR_FALLBACK_LIMIT }).items
    const active = all.filter((b) => b.status !== 'deleted')

    const isExpired = (backup: BackupRecord): boolean => {
      if (backup.retentionUntil) {
        const t = Date.parse(backup.retentionUntil)
        if (Number.isFinite(t) && t <= now.getTime()) return true
      }
      if (retentionDays > 0) {
        const created = Date.parse(backup.createdAt)
        if (Number.isFinite(created) && created + retentionDays * 86_400_000 <= now.getTime()) return true
      }
      return false
    }

    const deleteOne = async (backup: BackupRecord): Promise<void> => {
      const refs = services.store.countRecoveryPointsReferencingBackup(backup.id)
      if (refs > 0) {
        skippedReferenced.push(backup.id)
        warnings.push(`备份 ${backup.fileName} 仍被 ${refs} 个恢复点引用，跳过删除`)
        return
      }
      const size = await fileSize(backup.filePath).catch(() => 0)
      await removeFile(backup.filePath)
      await removeFile(`${backup.filePath}.sha256`)
      services.store.updateBackup(backup.id, { status: 'deleted' })
      deleted.push(backup.id)
      freedBytes += size
    }

    for (const backup of active.filter(isExpired)) {
      await deleteOne(backup)
    }

    // Capacity cap: delete oldest non-referenced backups until under the limit.
    const remaining = services.store
      .listBackups({ limit: BACKUP_DIR_FALLBACK_LIMIT })
      .items.filter((b) => b.status !== 'deleted')
    let totalBytes = remaining.reduce((sum, b) => sum + (b.fileSize ?? 0), 0)
    const maxBytes = Number.isFinite(settings.maxBackupBytes) ? settings.maxBackupBytes : 0
    if (maxBytes > 0 && totalBytes > maxBytes) {
      const oldestFirst = [...remaining].sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
      )
      for (const backup of oldestFirst) {
        if (totalBytes <= maxBytes) break
        const refs = services.store.countRecoveryPointsReferencingBackup(backup.id)
        if (refs > 0) {
          if (!skippedReferenced.includes(backup.id)) {
            skippedReferenced.push(backup.id)
            warnings.push(`容量清理：备份 ${backup.fileName} 仍被 ${refs} 个恢复点引用，跳过删除`)
          }
          continue
        }
        const size = backup.fileSize ?? 0
        await deleteOne(backup)
        totalBytes -= size
      }
      if (totalBytes > maxBytes) {
        warnings.push(
          `备份总大小 ${totalBytes} 仍超过上限 ${maxBytes}：可清理的未引用备份已用尽，请提高上限或手工处理`
        )
      }
    }

    const free = await freeDiskBytes(this.backupRoot())
    if (free >= 0 && settings.diskWarnBytes > 0 && free < settings.diskWarnBytes) {
      warnings.push(
        `备份磁盘剩余空间不足：${free} 字节 < 预警阈值 ${settings.diskWarnBytes} 字节`
      )
    }

    if (deleted.length > 0) {
      audit(services, {
        action: 'backup.retention_sweep',
        outcome: 'info',
        detail: `清理 ${deleted.length} 个备份，释放 ${freedBytes} 字节；跳过 ${skippedReferenced.length} 个被引用备份`
      })
    }
    return { deleted, freedBytes, skippedReferenced, warnings }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function localDateStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

export function emptyVerification(): BackupVerification {
  return {
    fileExists: false,
    nonEmpty: false,
    checksumOk: false,
    structureOk: false,
    tableCount: null,
    rowDataPresent: false,
    verifiedAt: null,
    restoreTestedAt: null,
    tempDatabase: null,
    notes: []
  }
}

export function inspectionToVerification(
  inspection: Awaited<ReturnType<typeof inspectBackupFile>>,
  verified: boolean
): BackupVerification {
  return {
    fileExists: inspection.fileExists,
    nonEmpty: inspection.nonEmpty,
    checksumOk: inspection.checksumOk === true,
    structureOk: inspection.structureOk,
    tableCount: inspection.tableCount,
    rowDataPresent: inspection.rowDataPresent,
    verifiedAt: verified ? nowIso() : null,
    restoreTestedAt: null,
    tempDatabase: null,
    notes: inspection.notes
  }
}

export function emitJob(
  services: Services,
  event: {
    jobId: Id
    kind: 'backup' | 'restore' | 'undo' | 'verify' | 'schema_scan' | 'agent'
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    phase: string
    message: string
    progress: number
    error?: string
    meta?: Record<string, unknown>
  }
): void {
  try {
    services.events.emit('job.event', {
      jobId: event.jobId,
      kind: event.kind,
      status: event.status,
      phase: event.phase,
      message: event.message,
      progress: event.progress,
      at: nowIso(),
      ...(event.error ? { error: event.error } : {}),
      ...(event.meta ? { meta: event.meta } : {})
    })
  } catch {
    /* progress events are best-effort; never let them break the operation */
  }
}

export function audit(
  services: Services,
  event: {
    action: string
    outcome: 'success' | 'failure' | 'denied' | 'info'
    connectionId?: Id | null
    projectId?: Id | null
    target?: string | null
    detail?: string | null
  }
): void {
  try {
    services.audit.record({
      actor: 'system',
      action: event.action,
      connectionId: event.connectionId ?? null,
      projectId: event.projectId ?? null,
      target: event.target ?? null,
      outcome: event.outcome,
      detail: event.detail ?? null
    })
  } catch {
    /* auditing must not break the operation, but also must not be skipped silently
       in code: the logger is the fallback channel */
    try {
      services.logger.warn('审计记录写入失败', { action: event.action })
    } catch {
      /* ignore */
    }
  }
}

function safeGetBackup(services: Services, id: Id): BackupRecord | null {
  try {
    return services.store.getBackup(id)
  } catch {
    return null
  }
}

/** Exported for tests: proves the directory tree is writable before backing up. */
export async function assertBackupDirWritable(dir: string): Promise<void> {
  await ensureDir(dir)
  const probe = join(dir, `.aidb-write-test-${process.pid}`)
  await fs.writeFile(probe, 'ok', 'utf8')
  await removeFile(probe)
  if (!(await pathExists(dir))) {
    throw new AppError('BACKUP_FAILED', `备份目录不可写：${dir}`)
  }
}

/** Exported for tests/tools: reads a manifest without importing internals. */
export async function readManifest(filePath: string): Promise<BackupManifestV1 | null> {
  return (await readBackupManifest(filePath)).manifest
}




