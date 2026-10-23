/**
 * AIDB Studio - database time machine.
 *
 * Public entry point for the service container. Everything here is trusted
 * main-process code: the renderer only sees metadata through IPC.
 */
import type { BackupService, RecoveryService, RestoreService, Services } from '@main/service-contracts'
import { MySqlBackupService } from './backup'
import { MySqlRecoveryService } from './recovery'
import { MySqlRestoreService } from './restore'
import { resolveServices, type ServicesProvider } from './deps'

export { MySqlBackupService } from './backup'
export { MySqlRecoveryService, MySqlWriteProtection } from './recovery'
export { MySqlRestoreService } from './restore'
export { LogicalDumper, orderViewsByDependency } from './dumper'
export { SqlStatementSplitter, splitSqlText, executeSqlFile } from './sqlfile'
export {
  buildBackupHeader,
  readBackupManifest,
  inspectBackupFile,
  scanDumpFile,
  hashCreateStatements,
  hasValidFooter,
  writeBackupFile
} from './manifest'
export { BACKUP_HEADER, BACKUP_META_PREFIX, BACKUP_END } from './internal-types'
export { findDumpToolSync, probeDumpTool } from './mysqldump'
export { restoreDumpToFreshDatabase } from './temprestore'
export { readImageFile } from './recovery'
export { restorePlanHash } from './restore'
export { undoPlanHash } from './undo'
export { MAX_CAPTURE_ROWS, validateWherePredicate } from './guard'
export type { BackupManifestV1, RecoveryImageFileV1 } from './internal-types'
export { resolveServices, type ServicesProvider } from './deps'

export interface TimeMachineServices {
  backups: BackupService
  recovery: RecoveryService
  restore: RestoreService
}

/**
 * Wires the three time-machine services.
 *
 * Pass a provider (`() => services`) when the service container is cyclic:
 *   const services = {} as Services
 *   const tm = createTimeMachineServices(() => services)
 *   services.backups = tm.backups ...
 */
export function createTimeMachineServices(provider: ServicesProvider): TimeMachineServices {
  // Resolve once to fail fast on a badly wired container, but the services keep
  // the provider so later-assigned container fields are visible.
  resolveServices(provider)
  return {
    backups: new MySqlBackupService(provider),
    recovery: new MySqlRecoveryService(provider),
    restore: new MySqlRestoreService(provider)
  }
}

/** Convenience type helper for container code. */
export type TimeMachineContainer = Pick<Services, 'backups' | 'recovery' | 'restore'>
