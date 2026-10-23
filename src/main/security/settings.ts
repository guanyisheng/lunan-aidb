import type { AppSettings } from '@shared/types'
import type { SettingsService } from '@main/service-contracts'
import type { AppStore } from '@main/service-contracts'

/**
 * Settings are persisted in the local store; defaults are owned by the caller so
 * there is exactly one source of truth for "what a fresh install looks like".
 */
export class StoreSettingsService implements SettingsService {
  constructor(
    private readonly store: AppStore,
    private readonly defaults: AppSettings
  ) {}

  get(): AppSettings {
    return { ...this.defaults, ...this.store.getSettings() }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    return this.store.updateSettings(patch)
  }
}

export function defaultSettings(backupsDir: string): AppSettings {
  return {
    autoProtection: true,
    requireApprovalForWrites: true,
    allowSampling: false,
    maxSampleRows: 5,
    sqlTimeoutMs: 30_000,
    maxResultRows: 1000,
    maxAgentSteps: 12,
    agentTimeoutMs: 180_000,
    backupDir: backupsDir,
    retentionDays: 30,
    maxBackupBytes: 20 * 1024 * 1024 * 1024,
    diskWarnBytes: 2 * 1024 * 1024 * 1024,
    defaultModelProfileId: null,
    defaultDecisionModelProfileId: null,
    theme: 'dark',
    jevQualityGateEnabled: false,
    jevMinConfidence: 60
  }
}
