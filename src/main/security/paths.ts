import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppPaths } from '@shared/types'

/**
 * Resolves every on-disk location used by the app. Backups and recovery points
 * are kept deliberately OUTSIDE the SQLite app database directory tree so a
 * corrupted local DB (or a user cleaning it) cannot silently destroy backups.
 */
export function resolvePaths(userDataDir: string, backupDirOverride?: string): AppPaths {
  const backups = backupDirOverride && backupDirOverride.trim() ? backupDirOverride : join(userDataDir, 'backups')
  const paths: AppPaths = {
    userData: userDataDir,
    appDb: join(userDataDir, 'aidb.sqlite'),
    backups,
    recoveryPoints: join(userDataDir, 'recovery-points'),
    logs: join(userDataDir, 'logs'),
    temp: join(userDataDir, 'temp'),
    modelsConfig: join(userDataDir, 'models-config.json')
  }
  for (const dir of [paths.userData, paths.recoveryPoints, paths.logs, paths.temp, paths.backups]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* the health check reports unwritable directories to the user */
    }
  }
  return paths
}
