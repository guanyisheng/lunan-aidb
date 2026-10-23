/**
 * Portable config export/import for Lunan AIDB (settings / models / connections / projects).
 * Connection passwords and model API keys are never written to export files.
 */
import type {
  AppSettings,
  ConfigBundle,
  ConfigExportScope,
  ModelProfileInput
} from '@shared/types'
import type { Services } from '@main/service-contracts'
import { AppError } from '@main/util/errors'
import { nowIso } from '@main/util/time'

function expandScopes(scopes: ConfigExportScope[]): Set<Exclude<ConfigExportScope, 'all'>> {
  if (scopes.includes('all')) return new Set(['settings', 'models', 'connections', 'projects'])
  return new Set(scopes.filter((s): s is Exclude<ConfigExportScope, 'all'> => s !== 'all'))
}

export function exportConfigBundle(services: Services, scopes: ConfigExportScope[]): ConfigBundle {
  const set = expandScopes(scopes.length ? scopes : ['all'])
  const bundle: ConfigBundle = {
    format: 'lunan-aidb-config',
    version: 1,
    exportedAt: nowIso(),
    app: 'Lunan AIDB',
    scopes: Array.from(set)
  }

  if (set.has('settings')) {
    const s = services.settings.get()
    bundle.settings = { ...s }
  }

  if (set.has('models')) {
    bundle.models = services.store.listModelProfiles().map((profile) => ({
      ...profile,
      apiKeyStored: Boolean(profile.apiKeyStored)
    }))
  }

  if (set.has('connections')) {
    bundle.connections = services.store.listConnectionRecords().map((record) => ({
      id: record.id,
      name: record.name,
      host: record.host,
      port: record.port,
      user: record.user,
      database: record.database,
      ssl: record.ssl,
      charset: record.charset,
      connectTimeoutMs: record.connectTimeoutMs,
      color: record.color,
      hasPassword: Boolean(record.hasStoredPassword || record.secretCipher)
    }))
  }

  if (set.has('projects')) {
    bundle.projects = services.store.listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description ?? '',
      connectionId: project.connectionId ?? null,
      databaseBriefMd: project.databaseBriefMd ?? null
    }))
  }

  return bundle
}

export async function importConfigBundle(
  services: Services,
  bundle: ConfigBundle,
  scopes?: ConfigExportScope[]
): Promise<{ imported: ConfigExportScope[]; warnings: string[] }> {
  if (!bundle || bundle.format !== 'lunan-aidb-config') {
    throw new AppError('VALIDATION', '不是有效的 Lunan AIDB 配置文件', {
      hint: '请选择由本应用导出的 JSON（format: lunan-aidb-config）。'
    })
  }
  const set = expandScopes(
    scopes?.length ? scopes : bundle.scopes?.length ? bundle.scopes : ['all']
  )
  const warnings: string[] = []
  const imported: ConfigExportScope[] = []

  if (set.has('settings') && bundle.settings) {
    const patch = { ...bundle.settings } as Partial<AppSettings>
    if (typeof patch.backupDir === 'string' && patch.backupDir.trim() === '') {
      delete patch.backupDir
    }
    services.settings.update(patch)
    imported.push('settings')
  }

  if (set.has('models') && bundle.models?.length) {
    for (const raw of bundle.models) {
      try {
        const input: ModelProfileInput = {
          id: raw.id,
          name: raw.name,
          kind: raw.kind,
          baseUrl: raw.baseUrl,
          model: raw.model,
          temperature: raw.temperature,
          maxTokens: raw.maxTokens,
          timeoutMs: raw.timeoutMs,
          toolsEnabled: raw.toolsEnabled,
          isDefault: raw.isDefault,
          roles: raw.roles,
          notes: raw.notes
        }
        services.models.save(input)
      } catch (error) {
        warnings.push(
          `模型「${raw.name}」导入失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    imported.push('models')
    warnings.push('模型 API Key 不会随配置导出；请在「模型设置」中重新填写密钥。')
  }

  if (set.has('connections') && bundle.connections?.length) {
    for (const raw of bundle.connections) {
      try {
        const existing = services.store.getConnectionRecord(raw.id)
        const input = {
          name: raw.name,
          host: raw.host,
          port: raw.port,
          user: raw.user,
          database: raw.database,
          ssl: raw.ssl,
          charset: raw.charset,
          connectTimeoutMs: raw.connectTimeoutMs,
          color: raw.color
        }
        if (existing) {
          await services.connections.save({ id: raw.id, input })
        } else {
          await services.connections.save({ input: { ...input, password: '' } })
        }
      } catch (error) {
        warnings.push(
          `连接「${raw.name}」导入失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    imported.push('connections')
    warnings.push('数据库密码不会随配置导出；请在连接设置中重新填写。')
  }

  if (set.has('projects') && bundle.projects?.length) {
    for (const raw of bundle.projects) {
      try {
        const existing = services.store.getProject(raw.id)
        if (existing) {
          services.store.updateProject(raw.id, {
            name: raw.name,
            description: raw.description,
            connectionId: raw.connectionId,
            databaseBriefMd: raw.databaseBriefMd ?? null
          })
        } else {
          const byName = services.store.listProjects().find((p) => p.name === raw.name)
          if (byName) {
            services.store.updateProject(byName.id, {
              description: raw.description,
              connectionId: raw.connectionId,
              databaseBriefMd: raw.databaseBriefMd ?? null
            })
          } else {
            services.store.createProject({
              name: raw.name,
              description: raw.description,
              connectionId: raw.connectionId,
              databaseBriefMd: raw.databaseBriefMd ?? null
            })
          }
        }
      } catch (error) {
        warnings.push(
          `项目「${raw.name}」导入失败：${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    imported.push('projects')
  }

  if (!imported.length) {
    throw new AppError('VALIDATION', '所选范围内没有可导入的数据')
  }

  return { imported, warnings }
}
