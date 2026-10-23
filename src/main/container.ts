import { join } from 'node:path'
import type { Logger, Services } from './service-contracts'
import { resolvePaths } from './security/paths'
import { defaultSettings, StoreSettingsService } from './security/settings'
import { MemorySecretStore, SafeStorageSecretStore, type SafeStorageLike } from './security/secrets'
import { FileLogger } from './security/logger'
import { BroadcastEventBus } from './security/events'
import { StoreAuditService } from './security/audit'
import { SqliteAppStore } from './store'
import { MySqlConnectionManager } from './db/connection'
import { MySqlSchemaService } from './db/schema'
import { AstSqlRiskClassifier } from './db/classifier'
import { MySqlSqlExecutor } from './db/executor'
import { createTimeMachineServices } from './timemachine'
import { SqliteMemoryService } from './memory/memory-service'
import { MultiProviderModelService } from './ai/models'
import { StatefulAgentService } from './ai/agent'
import { DefaultSqlExecutionService } from './services/execution-service'

export interface CreateServicesOptions {
  userDataDir: string
  safeStorage: SafeStorageLike | null
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

export interface ServicesBundle {
  services: Services
  store: SqliteAppStore
  dispose(): Promise<void>
}

/**
 * Dependency wiring. The mutable `services` shell is intentional: several
 * services take `() => Services` so construction order never causes cycles, and
 * every access happens at call time (long after wiring is complete).
 */
export async function createServices(options: CreateServicesOptions): Promise<ServicesBundle> {
  const paths = resolvePaths(options.userDataDir)
  const defaults = defaultSettings(paths.backups)
  const store = new SqliteAppStore(paths.appDb, defaults)
  const secrets = options.safeStorage ? new SafeStorageSecretStore(options.safeStorage) : new MemorySecretStore()
  const logger: Logger = new FileLogger({
    filePath: join(paths.logs, 'app.log'),
    level: options.logLevel ?? 'info',
    console: true
  })
  const events = new BroadcastEventBus()

  const services = {} as Services
  Object.assign(services, { paths, logger, store, secrets, events })

  services.settings = new StoreSettingsService(store, defaults)
  services.audit = new StoreAuditService(store, events, paths.logs, logger)
  services.connections = new MySqlConnectionManager(() => services)
  services.classifier = new AstSqlRiskClassifier(() => services)
  services.schema = new MySqlSchemaService(() => services)
  services.executor = new MySqlSqlExecutor(() => services)
  services.memory = new SqliteMemoryService(store, logger)
  services.models = new MultiProviderModelService({
    store,
    secrets,
    logger,
    configPath: paths.modelsConfig
  })
  try {
    const imported = services.models.hydrateFromConfigFile()
    if (imported > 0) logger.info('restored model profiles from models-config.json', { imported })
  } catch (error) {
    logger.warn('model config hydrate failed', { error: String(error) })
  }

  const timeMachine = createTimeMachineServices(() => services)
  services.backups = timeMachine.backups
  services.recovery = timeMachine.recovery
  services.restore = timeMachine.restore

  services.execution = new DefaultSqlExecutionService(() => services)
  services.agent = new StatefulAgentService(() => services)

  let disposed = false
  return {
    services,
    store,
    dispose: async () => {
      if (disposed) return
      disposed = true
      try {
        await services.connections.closeAll()
      } catch {
        /* best effort */
      }
      try {
        store.close()
      } catch {
        /* best effort */
      }
    }
  }
}
