/**
 * Durable JSON mirror of model profiles (no API keys).
 * Survives app restarts even if the user inspects/backs up this file separately
 * from aidb.sqlite. Secrets stay in the OS keychain only.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelProfile, ModelProviderKind, ModelRole } from '@shared/types'
import { nowIso } from '../util/time'

export const MODEL_CONFIG_VERSION = 1 as const

export interface ModelsConfigFile {
  version: typeof MODEL_CONFIG_VERSION
  updatedAt: string
  defaultModelProfileId: string | null
  defaultDecisionModelProfileId: string | null
  profiles: ModelProfile[]
}

export function modelsConfigPath(userDataDir: string): string {
  return `${userDataDir.replace(/\/+$/, '')}/models-config.json`
}

export function readModelsConfigFile(filePath: string): ModelsConfigFile | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ModelsConfigFile>
    if (!parsed || typeof parsed !== 'object') return null
    if (!Array.isArray(parsed.profiles)) return null
    const profiles = parsed.profiles
      .map(sanitizeProfile)
      .filter((p): p is ModelProfile => p !== null)
    return {
      version: MODEL_CONFIG_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(),
      defaultModelProfileId:
        typeof parsed.defaultModelProfileId === 'string' ? parsed.defaultModelProfileId : null,
      defaultDecisionModelProfileId:
        typeof parsed.defaultDecisionModelProfileId === 'string'
          ? parsed.defaultDecisionModelProfileId
          : null,
      profiles
    }
  } catch {
    return null
  }
}

export function writeModelsConfigFile(
  filePath: string,
  profiles: ModelProfile[],
  defaultModelProfileId: string | null,
  defaultDecisionModelProfileId: string | null = null
): void {
  const payload: ModelsConfigFile = {
    version: MODEL_CONFIG_VERSION,
    updatedAt: nowIso(),
    defaultModelProfileId,
    defaultDecisionModelProfileId,
    profiles: profiles.map((p) => ({
      ...p,
      roles: normalizeRoles(p.roles),
      // Never persist secrets in the JSON mirror.
      apiKeyStored: Boolean(p.apiKeyStored)
    }))
  }
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tmp, filePath)
}

export function normalizeRoles(raw: unknown, fallback: ModelRole[] = ['agent']): ModelRole[] {
  if (!Array.isArray(raw)) return fallback.slice()
  const roles = raw.filter((item): item is ModelRole => item === 'agent' || item === 'decision')
  const unique = Array.from(new Set(roles))
  return unique.length ? unique : fallback.slice()
}

function sanitizeProfile(raw: unknown): ModelProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim() : ''
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim() : ''
  const model = typeof r.model === 'string' ? r.model.trim() : ''
  if (!id || !name || !baseUrl || !model) return null
  const kind: ModelProviderKind = r.kind === 'ollama' ? 'ollama' : 'openai'
  const now = nowIso()
  return {
    id,
    name,
    kind,
    baseUrl,
    model,
    apiKeyStored: Boolean(r.apiKeyStored),
    temperature: clamp(r.temperature, 0.2, 0, 2),
    maxTokens: Math.floor(clamp(r.maxTokens, 2048, 1, 200_000)),
    timeoutMs: Math.floor(clamp(r.timeoutMs, 60_000, 1000, 600_000)),
    toolsEnabled: r.toolsEnabled !== false,
    isDefault: Boolean(r.isDefault),
    roles: normalizeRoles(r.roles),
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 2000) : '',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : now,
    lastTestAt: typeof r.lastTestAt === 'string' ? r.lastTestAt : null,
    lastTestOk: typeof r.lastTestOk === 'boolean' ? r.lastTestOk : null
  }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
