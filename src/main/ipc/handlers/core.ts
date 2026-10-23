import { app, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { z } from 'zod'
import { defineHandler } from '../registry'
import {
  connectionInputSchema,
  idSchema,
  settingsPatchSchema
} from '../schemas'
import { AppError } from '@main/util/errors'
import { nowIso } from '@main/util/time'
import { freeDiskBytes } from '@main/util/fsx'
import { newId } from '@main/util/id'
import type { AppInfo, AppPaths, ConfigExportScope, HealthReport } from '@shared/types'
import { exportConfigBundle, importConfigBundle } from '@main/config/portable-config'

const voidSchema = z.void()

function isInside(parent: string, candidate: string): boolean {
  const p = resolve(parent)
  const c = resolve(candidate)
  return c === p || c.startsWith(p + sep)
}

export function registerCoreHandlers(): void {
  /* ------------------------------------------------------------- app */
  defineHandler('app.info', voidSchema, async (ctx) => {
    const info: AppInfo = {
      name: 'Lunan AIDB',
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      node: process.versions.node ?? '',
      chrome: process.versions.chrome ?? '',
      platform: process.platform,
      arch: process.arch,
      userDataPath: ctx.services.paths.userData,
      appDbPath: ctx.services.paths.appDb,
      modelsConfigPath: ctx.services.paths.modelsConfig,
      license: 'MIT'
    }
    return info
  })

  defineHandler('app.paths', voidSchema, async (ctx) => {
    const p = ctx.services.paths
    const paths: AppPaths = { ...p }
    return paths
  })

  defineHandler('app.health', voidSchema, async (ctx) => {
    const s = ctx.services
    let appDbOk = false
    let appDbError: string | undefined
    let migrations = 0
    try {
      s.store.getSettings()
      migrations = s.store.schemaVersion
      appDbOk = true
    } catch (e) {
      appDbError = e instanceof Error ? e.message : String(e)
    }
    const backupDir = s.settings.get().backupDir || s.paths.backups
    let writable = false
    try {
      const probe = resolve(backupDir, `.write-probe-${Date.now()}`)
      await fs.writeFile(probe, 'ok', 'utf8')
      await fs.unlink(probe)
      writable = true
    } catch {
      writable = false
    }
    let dumperAvailable = false
    let dumperVersion: string | undefined
    try {
      const stats = s.backups.stats()
      dumperAvailable = stats.dumperAvailable
    } catch {
      dumperAvailable = false
    }
    const secretsAvailable = s.secrets.available()
    const health: HealthReport = {
      ok: appDbOk && secretsAvailable,
      appDb: { path: s.paths.appDb, ok: appDbOk, migrations, error: appDbError },
      // Memory records live in the same transactional SQLite file.
      memoryDb: { path: s.paths.appDb, ok: appDbOk, error: appDbError },
      backupDir: { path: backupDir, writable, freeBytes: await freeDiskBytes(backupDir) },
      toolSupport: { mysqldump: dumperAvailable, mysqldumpVersion: dumperVersion },
      secrets: { backend: s.secrets.backend(), available: secretsAvailable }
    }
    return health
  })

  defineHandler('app.settings.get', voidSchema, async (ctx) => ctx.services.settings.get())

  defineHandler('app.settings.update', z.object({ patch: settingsPatchSchema }), async (ctx, payload) => {
    const before = ctx.services.settings.get()
    const next = ctx.services.settings.update(payload.patch)
    ctx.services.audit.record({
      actor: 'user',
      action: 'settings.update',
      outcome: 'info',
      detail: '更新应用设置',
      metadata: { changedKeys: Object.keys(payload.patch), backupDirChanged: before.backupDir !== next.backupDir }
    })
    return next
  })

  defineHandler(
    'app.dialog.chooseDirectory',
    z.object({ title: z.string().max(200).optional(), defaultPath: z.string().max(1000).optional() }),
    async (ctx, payload) => {
      const win = ctx.window()
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: payload.title ?? '选择目录',
            defaultPath: payload.defaultPath,
            properties: ['openDirectory', 'createDirectory']
          })
        : await dialog.showOpenDialog({
            title: payload.title ?? '选择目录',
            defaultPath: payload.defaultPath,
            properties: ['openDirectory', 'createDirectory']
          })
      return { dir: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0] }
    }
  )

  defineHandler(
    'app.dialog.chooseFile',
    z.object({
      title: z.string().max(200).optional(),
      filters: z
        .array(z.object({ name: z.string().max(100), extensions: z.array(z.string().max(20)).max(20) }))
        .max(10)
        .optional()
    }),
    async (ctx, payload) => {
      const win = ctx.window()
      const options = {
        title: payload.title ?? '选择文件',
        filters: payload.filters ?? [{ name: 'SQL', extensions: ['sql', 'gz'] }],
        properties: ['openFile' as const]
      }
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return { path: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0] }
    }
  )

  defineHandler('app.showItemInFolder', z.object({ path: z.string().min(1).max(2000) }), async (ctx, payload) => {
    const target = normalize(payload.path)
    if (!isAbsolute(target)) throw new AppError('VALIDATION', '路径必须是绝对路径')
    const allowedRoots = [ctx.services.paths.userData, ctx.services.settings.get().backupDir]
    if (!allowedRoots.some((root) => root && isInside(root, target))) {
      throw new AppError('PERMISSION_DENIED', '只允许打开应用数据目录内的文件位置')
    }
    shell.showItemInFolder(target)
  })

  defineHandler(
    'app.exportText',
    z.object({ suggestedName: z.string().min(1).max(200), content: z.string().max(20_000_000) }),
    async (ctx, payload) => {
      const win = ctx.window()
      const options = { defaultPath: payload.suggestedName, filters: [{ name: 'Text', extensions: ['txt', 'sql', 'json', 'csv', 'md'] }] }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { path: null }
      await fs.writeFile(result.filePath, payload.content, 'utf8')
      return { path: result.filePath }
    }
  )

  const configScopeSchema = z.enum(['settings', 'models', 'connections', 'projects', 'all'])

  defineHandler(
    'config.export',
    z.object({ scopes: z.array(configScopeSchema).min(1).max(5) }),
    async (ctx, payload) => {
      const scopes = payload.scopes as ConfigExportScope[]
      const bundle = exportConfigBundle(ctx.services, scopes)
      const win = ctx.window()
      const stamp = new Date().toISOString().slice(0, 10)
      const options = {
        title: '导出 Lunan AIDB 配置',
        defaultPath: `lunan-aidb-config-${stamp}.json`,
        filters: [{ name: 'Lunan AIDB Config', extensions: ['json'] }]
      }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { path: null, bundle: null }
      await fs.writeFile(result.filePath, JSON.stringify(bundle, null, 2), 'utf8')
      ctx.services.audit.record({
        actor: 'user',
        action: 'config.export',
        outcome: 'success',
        detail: `导出配置：${scopes.join(',')}`,
        metadata: { scopes, path: result.filePath }
      })
      return { path: result.filePath, bundle }
    }
  )

  defineHandler(
    'config.import',
    z.object({
      scopes: z.array(configScopeSchema).min(1).max(5).optional(),
      path: z.string().min(1).max(2000).optional()
    }),
    async (ctx, payload) => {
      let filePath = payload.path?.trim() || ''
      if (!filePath) {
        const win = ctx.window()
        const options = {
          title: '导入 Lunan AIDB 配置',
          filters: [{ name: 'Lunan AIDB Config', extensions: ['json'] }],
          properties: ['openFile' as const]
        }
        const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
        if (picked.canceled || !picked.filePaths[0]) {
          return { imported: [], warnings: [], path: null }
        }
        filePath = picked.filePaths[0]
      }
      let raw: string
      try {
        raw = await fs.readFile(filePath, 'utf8')
      } catch (error) {
        throw new AppError('INTERNAL', `无法读取配置文件：${error instanceof Error ? error.message : String(error)}`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new AppError('VALIDATION', '配置文件不是有效的 JSON')
      }
      const result = await importConfigBundle(
        ctx.services,
        parsed as Parameters<typeof importConfigBundle>[1],
        payload.scopes as ConfigExportScope[] | undefined
      )
      ctx.services.audit.record({
        actor: 'user',
        action: 'config.import',
        outcome: 'success',
        detail: `导入配置：${result.imported.join(',')}`,
        metadata: { imported: result.imported, warnings: result.warnings.length, path: filePath }
      })
      return { ...result, path: filePath }
    }
  )

  defineHandler('app.openExternal', z.object({ url: z.string().min(1).max(2000) }), async (_ctx, payload) => {
    let parsed: URL
    try {
      parsed = new URL(payload.url)
    } catch {
      throw new AppError('VALIDATION', '非法链接')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new AppError('PERMISSION_DENIED', '只允许打开 http/https 链接')
    }
    await shell.openExternal(parsed.toString())
  })

  /* -------------------------------------------------------- projects */
  defineHandler('project.list', voidSchema, async (ctx) => ctx.services.store.listProjects())

  defineHandler(
    'project.create',
    z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(1000).optional(),
      connectionId: z.string().max(200).nullable().optional()
    }),
    async (ctx, payload) => {
      const project = ctx.services.store.createProject({
        name: payload.name,
        description: payload.description,
        connectionId: payload.connectionId ?? null
      })
      ctx.services.audit.record({
        actor: 'user',
        action: 'project.create',
        projectId: project.id,
        outcome: 'info',
        detail: `创建项目 ${project.name}`
      })
      return project
    }
  )

  defineHandler(
    'project.update',
    z.object({
      id: idSchema,
      patch: z.object({
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(1000).optional(),
        connectionId: z.string().max(200).nullable().optional(),
        databaseBriefMd: z.string().max(200_000).nullable().optional()
      })
    }),
    async (ctx, payload) => {
      ctx.services.store.getProject(payload.id) ?? notFound('项目')
      return ctx.services.store.updateProject(payload.id, payload.patch)
    }
  )

  defineHandler('project.delete', z.object({ id: idSchema, deleteMemories: z.boolean().optional() }), async (ctx, payload) => {
    const project = ctx.services.store.getProject(payload.id)
    if (!project) throw new AppError('NOT_FOUND', '项目不存在')
    ctx.services.store.deleteProject(payload.id, payload.deleteMemories ?? true)
    ctx.services.audit.record({
      actor: 'user',
      action: 'project.delete',
      projectId: payload.id,
      outcome: 'info',
      detail: `删除项目 ${project.name}，记忆${payload.deleteMemories ?? true ? '一并删除' : '保留'}`
    })
    return { ok: true as const }
  })

  defineHandler('project.open', z.object({ id: idSchema }), async (ctx, payload) => {
    const s = ctx.services
    const project = s.store.getProject(payload.id)
    if (!project) throw new AppError('NOT_FOUND', '项目不存在')
    s.store.touchProject(payload.id)
    const connection = project.connectionId
      ? s.store.listConnectionRecords().find((c) => c.id === project.connectionId) ?? null
      : null
    const snapshot = project.schemaSnapshotId ? s.store.getSchemaSnapshot(project.schemaSnapshotId, true) : null
    const summary = connection
      ? {
          id: connection.id,
          name: connection.name,
          host: connection.host,
          port: connection.port,
          user: connection.user,
          database: connection.database,
          ssl: connection.ssl,
          charset: connection.charset,
          hasStoredPassword: connection.secretCipher !== null,
          color: connection.color,
          createdAt: connection.createdAt,
          updatedAt: connection.updatedAt,
          lastUsedAt: connection.lastUsedAt,
          lastState: connection.lastState
        }
      : null
    return { project: { ...project }, connection: summary, snapshot }
  })

  defineHandler('project.stats', z.object({ id: idSchema }), async (ctx, payload) =>
    ctx.services.store.projectStats(payload.id)
  )

  defineHandler(
    'project.generateBrief',
    z.object({
      id: idSchema,
      connectionId: z.string().max(200).optional(),
      database: z.string().max(200).optional(),
      save: z.boolean().optional()
    }),
    async (ctx, payload) => {
      const { buildDatabaseBriefMarkdown } = await import('@main/ai/brief-from-schema')
      const project = ctx.services.store.getProject(payload.id)
      if (!project) throw new AppError('NOT_FOUND', '项目不存在')

      const connectionId = payload.connectionId || project.connectionId
      if (!connectionId) {
        throw new AppError('VALIDATION', '项目未关联连接，无法从库结构生成说明', {
          hint: '请先在项目中绑定数据库连接，或传入 connectionId。'
        })
      }

      let database = payload.database?.trim() || ''
      let source: 'snapshot' | 'live' = 'live'
      let serverFlavor: string | null = null
      let tables: Parameters<typeof buildDatabaseBriefMarkdown>[0]['tables'] = []

      const snapshot = ctx.services.store.getLatestSchemaSnapshot(payload.id, true)
      if (
        snapshot &&
        snapshot.connectionId === connectionId &&
        (!database || snapshot.database === database) &&
        snapshot.tables?.length
      ) {
        database = database || snapshot.database
        source = 'snapshot'
        serverFlavor = snapshot.serverFlavor
        tables = snapshot.tables.map((t) => ({
          name: t.name,
          type: 'TABLE',
          comment: t.comment,
          columns: t.columns,
          primaryKey: t.primaryKey,
          foreignKeys: t.foreignKeys
        }))
      } else {
        const session = await ctx.services.connections.openSession(connectionId, database || undefined)
        try {
          database = database || session.database
          if (!database) throw new AppError('VALIDATION', '请先选择数据库')
          const summaries = await ctx.services.schema.listTables(session, database)
          const limit = Math.min(80, summaries.length)
          for (let i = 0; i < limit; i++) {
            const summary = summaries[i]
            try {
              const detail = await ctx.services.schema.getTable(session, database, summary.name)
              tables.push({
                name: detail.name,
                type: detail.type,
                comment: detail.comment,
                columns: detail.columns,
                primaryKey: detail.primaryKey,
                foreignKeys: detail.foreignKeys
              })
            } catch {
              tables.push({
                name: summary.name,
                type: summary.type,
                comment: summary.comment || '',
                columns: [],
                primaryKey: [],
                foreignKeys: []
              })
            }
          }
        } finally {
          try {
            await session.release()
          } catch {
            /* ignore */
          }
        }
      }

      const markdown = buildDatabaseBriefMarkdown({
        database,
        projectName: project.name,
        serverFlavor,
        tables
      })

      let saved = false
      if (payload.save) {
        ctx.services.store.updateProject(payload.id, { databaseBriefMd: markdown })
        saved = true
      }

      return { markdown, saved, tableCount: tables.length, source }
    }
  )

  /* ----------------------------------------------------- connections */
  defineHandler('conn.list', voidSchema, async (ctx) => ctx.services.connections.list())

  defineHandler(
    'conn.save',
    z.object({ id: z.string().max(200).optional(), input: connectionInputSchema }),
    async (ctx, payload) => {
      const saved = await ctx.services.connections.save(payload)
      ctx.services.audit.record({
        actor: 'user',
        action: payload.id ? 'connection.update' : 'connection.create',
        connectionId: saved.id,
        target: `${saved.host}:${saved.port}/${saved.database}`,
        outcome: 'info',
        detail: `保存连接 ${saved.name}`
      })
      return saved
    }
  )

  defineHandler('conn.delete', z.object({ id: idSchema }), async (ctx, payload) => {
    const target = ctx.services.store.getConnectionRecord(payload.id)
    await ctx.services.connections.remove(payload.id)
    ctx.services.audit.record({
      actor: 'user',
      action: 'connection.delete',
      target: target ? `${target.host}:${target.port}` : payload.id,
      outcome: 'info',
      detail: '删除数据库连接'
    })
  })

  defineHandler(
    'conn.test',
    z.object({ id: z.string().max(200).optional(), input: connectionInputSchema }),
    async (ctx, payload) => ctx.services.connections.test(payload)
  )

  defineHandler('conn.connect', z.object({ id: idSchema }), async (ctx, payload) => {
    const status = await ctx.services.connections.connect(payload.id)
    ctx.services.audit.record({
      actor: 'user',
      action: 'connection.connect',
      connectionId: payload.id,
      outcome: status.state === 'connected' ? 'success' : 'failure',
      detail: status.error ?? '连接成功',
      metadata: { serverVersion: status.serverVersion, latencyMs: status.latencyMs }
    })
    return status
  })

  defineHandler('conn.disconnect', z.object({ id: idSchema }), async (ctx, payload) => {
    await ctx.services.connections.disconnect(payload.id)
  })

  defineHandler('conn.status', z.object({ id: idSchema }), async (ctx, payload) =>
    ctx.services.connections.status(payload.id)
  )

  defineHandler('conn.listDatabases', z.object({ id: idSchema }), async (ctx, payload) =>
    ctx.services.connections.listDatabases(payload.id)
  )
}

function notFound(what: string): never {
  throw new AppError('NOT_FOUND', `${what}不存在`)
}

export { notFound }
