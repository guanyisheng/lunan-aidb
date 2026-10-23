/**
 * AIDB Studio - unified model adapter (OpenAI compatible HTTP APIs + Ollama).
 *
 * Security / robustness:
 *  - API keys are only read through `store.getModelSecretCipher()` +
 *    `secrets.decrypt()`; they are never logged, emitted, returned or put in an
 *    AppError payload.
 *  - Every request is cancellable (AbortController) and time-boxed.
 *  - Streaming: OpenAI SSE (`data: {...}` lines, `[DONE]` terminator) and Ollama
 *    NDJSON. Tool calls are accumulated per index (id/name/arguments).
 */
import type { AppStore, ChatCompletion, ChatStreamOptions, Logger, ModelService, ResolvedModel, SecretStore } from '../service-contracts'
import type {
  ChatMessage,
  DiscoveredModel,
  JsonSchemaLite,
  ModelDiscoverRequest,
  ModelDiscoverResult,
  ModelProfile,
  ModelProfileInput,
  ModelProviderKind,
  ModelRole,
  ModelTestResult,
  ToolCall,
  ToolDefinition
} from '@shared/types'
import { AppError } from '../util/errors'
import { newId } from '../util/id'
import { nowIso } from '../util/time'
import { normalizeRoles, readModelsConfigFile, writeModelsConfigFile } from './model-config-file'

export interface ModelServiceOptions {
  store: AppStore
  secrets: SecretStore
  logger?: Logger
  /** Absolute path to models-config.json (durable mirror, no secrets). */
  configPath?: string
}

const DEFAULT_TEMPERATURE = 0.2
/** Agent turns need room for reasoning + tool args + SQL. */
const DEFAULT_MAX_TOKENS = 8192
/** Multi-step agent + remote gateways often exceed 60s. */
const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TOOL_ARGUMENT_CHARS = 200_000

/* ------------------------------------------------------------------ */
/* URL normalisation                                                   */
/* ------------------------------------------------------------------ */

function parseBaseUrl(raw: string): URL {
  const value = (raw ?? '').trim()
  if (!value) {
    throw new AppError('MODEL_ERROR', '模型 baseUrl 为空', {
      hint: '请在“模型设置”中填写模型服务地址，例如 https://api.openai.com/v1 或 http://127.0.0.1:11434'
    })
  }
  let candidate = value
  if (!/^https?:\/\//i.test(candidate)) candidate = `http://${candidate}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new AppError('MODEL_ERROR', `无效的模型 baseUrl: ${redactUrl(value)}`, {
      hint: 'baseUrl 必须是可以访问的 http(s) 地址，例如 https://api.openai.com/v1 或 http://127.0.0.1:11434'
    })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('MODEL_ERROR', '模型 baseUrl 只支持 http/https 协议', {
      hint: '请使用 http:// 或 https:// 开头的地址'
    })
  }
  return url
}

function basePath(url: URL): string {
  const path = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '')
  return path
}

/** Accepts a base (`host`, `host/v1`, full endpoint) and returns the chat URL. */
export function resolveOpenAiChatUrl(baseUrl: string): string {
  const base = basePath(parseBaseUrl(baseUrl))
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/completions$/i.test(base) && !/\/chat\/completions$/i.test(base)) {
    // User pasted the legacy completions endpoint; the chat endpoint sits next to it.
    return base.replace(/\/completions$/i, '/chat/completions')
  }
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

/** Accepts a host, `host/api`, or the full `/api/chat` endpoint. */
export function resolveOllamaChatUrl(baseUrl: string): string {
  let base = basePath(parseBaseUrl(baseUrl))
  if (/\/api\/chat$/i.test(base)) return base
  if (/\/api$/i.test(base)) return `${base}/chat`
  if (/\/v1$/i.test(base)) base = base.replace(/\/v1$/i, '')
  return `${base}/api/chat`
}

/** OpenAI-compatible GET /v1/models list endpoint. */
export function resolveOpenAiModelsUrl(baseUrl: string): string {
  const base = basePath(parseBaseUrl(baseUrl))
  if (/\/models$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/models`
  if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, '/models')
  return `${base}/v1/models`
}

/** Ollama GET /api/tags list endpoint. */
export function resolveOllamaTagsUrl(baseUrl: string): string {
  let base = basePath(parseBaseUrl(baseUrl))
  if (/\/api\/tags$/i.test(base)) return base
  if (/\/api\/chat$/i.test(base)) return base.replace(/\/api\/chat$/i, '/api/tags')
  if (/\/api$/i.test(base)) return `${base}/tags`
  if (/\/v1$/i.test(base)) base = base.replace(/\/v1$/i, '')
  return `${base}/api/tags`
}

/** Infer provider kind from a base URL when the user hasn't picked one. */
export function inferModelKind(baseUrl: string, preferred?: ModelProviderKind): ModelProviderKind {
  if (preferred === 'openai' || preferred === 'ollama') return preferred
  try {
    const url = parseBaseUrl(baseUrl)
    if (url.port === '11434' || /ollama/i.test(url.hostname) || /\/api(\/|$)/i.test(url.pathname)) {
      return 'ollama'
    }
  } catch {
    /* fall through */
  }
  return 'openai'
}

/** Canonical value stored on the profile (adds http://, strips trailing slash). */
export function normalizeModelBaseUrl(raw: string): string {
  const url = parseBaseUrl(raw)
  return basePath(url)
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
    if (url.password) url.password = '***'
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return String(raw).replace(/\/\/[^@/]+@/, '//***@').slice(0, 200)
  }
}

/* ------------------------------------------------------------------ */
/* Secret hygiene                                                      */
/* ------------------------------------------------------------------ */

function redactSecret(text: string, secret: string | null | undefined): string {
  let out = String(text ?? '')
  if (secret && secret.length >= 6) out = out.split(secret).join('[REDACTED]')
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]')
  return out
}

/* ------------------------------------------------------------------ */
/* Timeout / abort guard                                               */
/* ------------------------------------------------------------------ */

interface FetchGuard {
  signal: AbortSignal
  timedOut: () => boolean
  externallyAborted: () => boolean
  cleanup: () => void
}

function createFetchGuard(timeoutMs: number, external?: AbortSignal): FetchGuard {
  const controller = new AbortController()
  let timedOut = false
  const timeout = Math.max(1000, Math.floor(timeoutMs))
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const onAbort = (): void => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    externallyAborted: () => external?.aborted === true,
    cleanup: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }
}

function networkError(error: unknown, guard: FetchGuard, model: ResolvedModel): AppError {
  if (guard.externallyAborted()) {
    return new AppError('CANCELLED', '模型请求已取消', { hint: '任务已被用户取消' })
  }
  if (guard.timedOut()) {
    return new AppError('TIMEOUT', `模型请求超时（${model.timeoutMs}ms）`, {
      hint: '可在“模型设置”中增大超时时间，或改用更小/更快的模型。'
    })
  }
  const anyError = error as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (anyError?.name === 'AbortError') {
    return new AppError('CANCELLED', '模型请求已中止', { hint: '任务已取消；如非主动取消请重试。' })
  }
  const code = anyError?.cause?.code ?? ''
  const connectLike = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']
  if (connectLike.includes(code) || /fetch failed/i.test(anyError?.message ?? '')) {
    return new AppError('MODEL_ERROR', `无法连接模型服务：${redactUrl(model.baseUrl)}`, {
      hint:
        model.kind === 'ollama'
          ? '请确认 Ollama 已启动（默认 http://127.0.0.1:11434），并检查 baseUrl/防火墙。'
          : '请检查 baseUrl 是否正确、服务是否启动、网络/代理是否可达。',
      details: code ? { code } : undefined
    })
  }
  return new AppError('MODEL_ERROR', `模型请求失败：${redactSecret(anyError?.message ?? String(error), model.apiKey)}`, {
    hint: '检查模型地址、网络与模型服务日志后重试。'
  })
}

function extractErrorMessage(bodyText: string): string {
  const text = bodyText.trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const error = parsed.error
    if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
      return (error as Record<string, unknown>).message as string
    }
    if (typeof error === 'string') return error
    if (typeof parsed.message === 'string') return parsed.message
    if (typeof parsed.detail === 'string') return parsed.detail
  } catch {
    /* not JSON */
  }
  return text
}

function httpError(status: number, bodyText: string, model: ResolvedModel): AppError {
  const serverMessage = redactSecret(extractErrorMessage(bodyText), model.apiKey).slice(0, 600)
  const detail = serverMessage ? `：${serverMessage}` : ''
  if (status === 401 || status === 403) {
    return new AppError('MODEL_ERROR', `模型服务拒绝访问（HTTP ${status}）${detail}`, {
      hint: 'API Key 无效、过期或没有权限。请在“模型设置”中重新保存 API Key。',
      details: { status }
    })
  }
  if (status === 404) {
    return new AppError('MODEL_ERROR', `模型接口不存在（HTTP 404）${detail}`, {
      hint: `请检查 baseUrl（当前 ${redactUrl(model.baseUrl)}）以及模型名称“${model.model}”是否正确。`,
      details: { status }
    })
  }
  if (status === 429) {
    return new AppError('MODEL_ERROR', `模型服务限流（HTTP 429）${detail}`, {
      hint: '请求过于频繁或额度不足，请稍后重试或检查账户额度。',
      details: { status }
    })
  }
  if (status >= 500) {
    return new AppError('MODEL_ERROR', `模型服务内部错误（HTTP ${status}）${detail}`, {
      hint: '模型服务暂时不可用，请稍后重试或查看本地服务日志。',
      details: { status }
    })
  }
  return new AppError('MODEL_ERROR', `模型请求被拒绝（HTTP ${status}）${detail}`, {
    hint: '请检查模型参数（model、baseUrl、tools 支持情况）后重试。',
    details: { status }
  })
}

/* ------------------------------------------------------------------ */
/* Streaming helpers                                                   */
/* ------------------------------------------------------------------ */

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        yield line
      }
    }
    buffer += decoder.decode()
    if (buffer.length) yield buffer.replace(/\r$/, '')
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* stream already closed */
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

interface RawToolCall {
  index: number
  id: string
  name: string
  argumentsText: string
}

function finalizeToolCalls(entries: RawToolCall[]): ToolCall[] {
  return entries
    .filter((entry) => entry.name)
    .sort((a, b) => a.index - b.index)
    .map((entry) => {
      const raw = entry.argumentsText.trim()
      let args: Record<string, unknown> = {}
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
        } catch {
          args = {}
        }
      }
      return {
        id: entry.id || `call_${entry.index}`,
        name: entry.name,
        arguments: args,
        rawArguments: raw.length <= MAX_TOOL_ARGUMENT_CHARS ? raw : raw.slice(0, MAX_TOOL_ARGUMENT_CHARS)
      }
    })
}

/* OpenAI message / tool mapping ------------------------------------- */

function toOpenAiMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content ?? ''
      }
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: call.rawArguments ?? JSON.stringify(call.arguments ?? {})
          }
        }))
      }
    }
    const out: Record<string, unknown> = { role: message.role, content: message.content ?? '' }
    if (message.name) out.name = message.name
    return out
  })
}

function toOpenAiTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as JsonSchemaLite
    }
  }))
}

function toOllamaMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', content: message.content ?? '', ...(message.name ? { tool_name: message.name } : {}) }
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.arguments ?? {} }
        }))
      }
    }
    const out: Record<string, unknown> = { role: message.role, content: message.content ?? '' }
    if (message.name) out.name = message.name
    return out
  })
}

function toOllamaTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export class MultiProviderModelService implements ModelService {
  private readonly store: AppStore
  private readonly secrets: SecretStore
  private readonly logger?: Logger
  private readonly configFilePath: string | null

  constructor(deps: ModelServiceOptions | AppStore, secrets?: SecretStore, logger?: Logger) {
    if (isModelDeps(deps)) {
      this.store = deps.store
      this.secrets = deps.secrets
      this.logger = deps.logger
      this.configFilePath = deps.configPath?.trim() || null
    } else {
      this.store = deps
      if (!secrets) throw new AppError('INTERNAL', 'MultiProviderModelService 需要 SecretStore')
      this.secrets = secrets
      this.logger = logger
      this.configFilePath = null
    }
  }

  configPath(): string {
    if (!this.configFilePath) {
      throw new AppError('INTERNAL', '模型配置文件路径未初始化')
    }
    return this.configFilePath
  }

  hydrateFromConfigFile(): number {
    if (!this.configFilePath) return 0
    if (this.store.listModelProfiles().length > 0) {
      // Keep the JSON mirror aligned with the live DB on every boot.
      this.persistConfigFile()
      return 0
    }
    const file = readModelsConfigFile(this.configFilePath)
    if (!file || file.profiles.length === 0) {
      this.persistConfigFile()
      return 0
    }
    let imported = 0
    for (const profile of file.profiles) {
      try {
        this.store.saveModelProfile({
          ...profile,
          // Keys are never in the JSON file; mark as not stored until re-entered.
          apiKeyStored: false,
          updatedAt: nowIso()
        })
        imported += 1
      } catch (error) {
        this.logger?.warn('failed to hydrate model profile from config file', {
          id: profile.id,
          error: String(error)
        })
      }
    }
    if (file.defaultModelProfileId) {
      const target = this.store.getModelProfile(file.defaultModelProfileId)
      if (target) {
        this.store.saveModelProfile({ ...target, isDefault: true, updatedAt: nowIso() })
        this.syncDefaultSetting(target.id)
      }
    }
    if (file.defaultDecisionModelProfileId) {
      const target = this.store.getModelProfile(file.defaultDecisionModelProfileId)
      if (target) this.syncDefaultDecisionSetting(target.id)
    }
    this.persistConfigFile()
    this.logger?.info('hydrated model profiles from config file', { imported, path: this.configFilePath })
    return imported
  }

  /* ------------------------------ list ---------------------------- */

  list(): ModelProfile[] {
    const profiles = this.store.listModelProfiles()
    return profiles.slice().sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  save(input: ModelProfileInput): ModelProfile {
    if (!input || typeof input !== 'object') throw new AppError('VALIDATION', '缺少模型配置')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) throw new AppError('VALIDATION', '模型名称不能为空')
    if (name.length > 120) throw new AppError('VALIDATION', '模型名称过长（最多 120 字符）')
    const kind: ModelProviderKind = input.kind === 'ollama' ? 'ollama' : 'openai'
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (!model) throw new AppError('VALIDATION', '模型名称（model）不能为空', { hint: '例如 gpt-4o-mini 或 qwen2.5:7b' })
    if (model.length > 200) throw new AppError('VALIDATION', '模型标识过长')
    const baseUrl = normalizeModelBaseUrl(input.baseUrl)

    const id = input.id ?? newId('model')
    const existing = this.store.getModelProfile(id)
    const now = nowIso()
    const isDefault =
      input.isDefault !== undefined
        ? input.isDefault
        : existing?.isDefault ?? this.store.listModelProfiles().length === 0

    // Encrypt first (no DB write yet). Cipher must be applied AFTER the profile
    // row exists — setModelSecretCipher is an UPDATE and fails on new profiles.
    let nextCipher: string | null | undefined
    let apiKeyStored = existing?.apiKeyStored ?? false
    if (input.apiKey !== undefined) {
      const plaintext = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
      if (!plaintext) {
        nextCipher = null
        apiKeyStored = false
      } else {
        const cipher = this.secrets.encrypt(plaintext)
        if (!cipher) {
          throw new AppError('SECRET_ERROR', '无法加密 API Key（系统密钥库不可用）', {
            hint: '请确认操作系统密钥库可用（Windows DPAPI / macOS Keychain），或重启应用后重试。'
          })
        }
        nextCipher = cipher
        apiKeyStored = true
      }
    } else if (!existing) {
      // Duplicate: reuse encrypted key from another profile (never decrypt here).
      const sourceId =
        typeof input.copyApiKeyFromProfileId === 'string' ? input.copyApiKeyFromProfileId.trim() : ''
      if (sourceId && sourceId !== id) {
        const source = this.store.getModelProfile(sourceId)
        const cipher = this.store.getModelSecretCipher(sourceId)
        if (!source) {
          throw new AppError('NOT_FOUND', `无法复制密钥：源模型不存在 (${sourceId})`)
        }
        if (cipher) {
          nextCipher = cipher
          apiKeyStored = true
        }
      }
    }

    const roles = normalizeRoles(
      input.roles !== undefined ? input.roles : existing?.roles,
      ['agent']
    ) as ModelRole[]

    const profile: ModelProfile = {
      id,
      name,
      kind,
      baseUrl,
      model,
      apiKeyStored,
      temperature: clampNumber(input.temperature, DEFAULT_TEMPERATURE, 0, 2),
      maxTokens: Math.floor(clampNumber(input.maxTokens, DEFAULT_MAX_TOKENS, 1, 200_000)),
      timeoutMs: Math.floor(clampNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 600_000)),
      toolsEnabled: input.toolsEnabled ?? existing?.toolsEnabled ?? true,
      isDefault,
      roles,
      notes: typeof input.notes === 'string' ? input.notes.slice(0, 2000) : existing?.notes ?? '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastTestAt: existing?.lastTestAt ?? null,
      lastTestOk: existing?.lastTestOk ?? null
    }

    if (profile.isDefault) {
      for (const other of this.store.listModelProfiles()) {
        if (other.id !== id && other.isDefault) {
          this.store.saveModelProfile({ ...other, isDefault: false, updatedAt: now })
        }
      }
    }

    const saved = this.store.saveModelProfile(profile)

    // Persist secret only after the profile row is upserted.
    if (nextCipher !== undefined) {
      this.store.setModelSecretCipher(id, nextCipher)
    }

    const finalProfile = this.store.getModelProfile(id) ?? saved
    if (profile.isDefault) this.syncDefaultSetting(id)
    this.persistConfigFile()
    this.logger?.info('model profile saved', {
      id,
      kind,
      model,
      apiKeyStored: finalProfile.apiKeyStored
    })
    return finalProfile
  }

  remove(id: string): void {
    const existing = this.store.getModelProfile(id)
    if (!existing) throw new AppError('NOT_FOUND', `模型配置不存在: ${id}`)
    try {
      this.store.setModelSecretCipher(id, null)
    } catch (error) {
      this.logger?.warn('failed to clear model secret', { id, error: String(error) })
    }
    this.store.deleteModelProfile(id)
    if (existing.isDefault) {
      const next = this.store.listModelProfiles()[0] ?? null
      if (next) {
        this.store.saveModelProfile({ ...next, isDefault: true, updatedAt: nowIso() })
        this.syncDefaultSetting(next.id)
      } else {
        this.syncDefaultSetting(null)
      }
    }
    if (this.store.getSettings().defaultDecisionModelProfileId === id) {
      const nextDecision =
        this.store.listModelProfiles().find((p) => p.roles?.includes('decision')) ?? null
      this.syncDefaultDecisionSetting(nextDecision?.id ?? null)
    }
    this.persistConfigFile()
    this.logger?.info('model profile removed', { id })
  }

  setDefault(id: string): ModelProfile[] {
    const target = this.store.getModelProfile(id)
    if (!target) throw new AppError('NOT_FOUND', `模型配置不存在: ${id}`)
    const now = nowIso()
    for (const profile of this.store.listModelProfiles()) {
      if (profile.id === id) {
        this.store.saveModelProfile({ ...profile, isDefault: true, updatedAt: now })
      } else if (profile.isDefault) {
        this.store.saveModelProfile({ ...profile, isDefault: false, updatedAt: now })
      }
    }
    this.syncDefaultSetting(id)
    this.persistConfigFile()
    return this.list()
  }

  setDefaultDecision(id: string | null): ModelProfile[] {
    if (id === null || id === '') {
      this.syncDefaultDecisionSetting(null)
      this.persistConfigFile()
      return this.list()
    }
    const target = this.store.getModelProfile(id)
    if (!target) throw new AppError('NOT_FOUND', `模型配置不存在: ${id}`)
    const roles = normalizeRoles(target.roles)
    if (!roles.includes('decision')) {
      // Auto-tag as decision so the default JEV is always a decision-capable profile.
      this.store.saveModelProfile({
        ...target,
        roles: normalizeRoles([...roles, 'decision']),
        updatedAt: nowIso()
      })
    }
    this.syncDefaultDecisionSetting(id)
    this.persistConfigFile()
    return this.list()
  }

  /** One-click clone: copies settings + encrypted API key (never decrypts). */
  duplicate(id: string): ModelProfile {
    const source = this.store.getModelProfile(id)
    if (!source) throw new AppError('NOT_FOUND', `模型配置不存在: ${id}`)
    const cipher = this.store.getModelSecretCipher(id)
    const now = nowIso()
    const baseName = source.name.replace(/\s*副本(?:\s*\d+)?$/u, '').trim() || source.name
    const existingNames = new Set(this.store.listModelProfiles().map((p) => p.name))
    let name = `${baseName} 副本`
    let n = 2
    while (existingNames.has(name)) {
      name = `${baseName} 副本 ${n}`
      n += 1
    }
    const profile: ModelProfile = {
      ...source,
      id: newId('model'),
      name,
      isDefault: false,
      apiKeyStored: Boolean(cipher),
      createdAt: now,
      updatedAt: now,
      lastTestAt: null,
      lastTestOk: null
    }
    const saved = this.store.saveModelProfile(profile)
    if (cipher) this.store.setModelSecretCipher(saved.id, cipher)
    this.persistConfigFile()
    this.logger?.info('model profile duplicated', {
      from: id,
      to: saved.id,
      apiKeyCopied: Boolean(cipher)
    })
    return this.store.getModelProfile(saved.id) ?? saved
  }

  /* ------------------------------ discover ------------------------ */

  async discover(req: ModelDiscoverRequest): Promise<ModelDiscoverResult> {
    if (!req || typeof req !== 'object') throw new AppError('VALIDATION', '缺少探测参数')
    const baseUrlRaw = typeof req.baseUrl === 'string' ? req.baseUrl.trim() : ''
    if (!baseUrlRaw) {
      throw new AppError('VALIDATION', '请先填写 Base URL', {
        hint: '例如 https://api.deepseek.com/v1 或 http://127.0.0.1:11434'
      })
    }
    const baseUrl = normalizeModelBaseUrl(baseUrlRaw)
    const kind = inferModelKind(baseUrl, req.kind)
    const timeoutMs = Math.min(Math.max(Math.floor(req.timeoutMs ?? 15_000), 2000), 60_000)

    let apiKey: string | null = null
    if (typeof req.apiKey === 'string' && req.apiKey.trim()) {
      apiKey = req.apiKey.trim()
    } else if (req.profileId) {
      const cipher = this.store.getModelSecretCipher(req.profileId)
      if (cipher && this.secrets.available()) {
        apiKey = this.secrets.decrypt(cipher)
      }
    }

    const started = Date.now()
    try {
      const models =
        kind === 'ollama'
          ? await this.discoverOllama(baseUrl, apiKey, timeoutMs)
          : await this.discoverOpenAi(baseUrl, apiKey, timeoutMs)
      const suggestedModel = pickSuggestedModel(models.map((m) => m.id), kind)
      const suggestedName = suggestedModel
        ? `${kind === 'ollama' ? 'Ollama' : 'API'} · ${shortModelLabel(suggestedModel)}`
        : undefined
      return {
        ok: true,
        kind,
        baseUrl,
        latencyMs: Date.now() - started,
        models,
        suggestedModel,
        suggestedName
      }
    } catch (error) {
      // Soft-fail so the UI can show the error inline without a toast storm.
      if (kind === 'openai') {
        try {
          const models = await this.discoverOllama(baseUrl, apiKey, timeoutMs)
          const suggestedModel = pickSuggestedModel(
            models.map((m) => m.id),
            'ollama'
          )
          return {
            ok: true,
            kind: 'ollama',
            baseUrl: normalizeModelBaseUrl(baseUrl),
            latencyMs: Date.now() - started,
            models,
            suggestedModel,
            suggestedName: suggestedModel ? `Ollama · ${shortModelLabel(suggestedModel)}` : undefined,
            hint: '按 OpenAI 兼容接口探测失败，已自动按 Ollama 识别。'
          }
        } catch {
          /* keep original error */
        }
      }
      const appError = toModelAppError(error)
      return {
        ok: false,
        kind,
        baseUrl,
        latencyMs: Date.now() - started,
        models: [],
        error: appError.message,
        hint: appError.hint
      }
    }
  }

  private async discoverOpenAi(baseUrl: string, apiKey: string | null, timeoutMs: number): Promise<DiscoveredModel[]> {
    const url = resolveOpenAiModelsUrl(baseUrl)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const guard = createFetchGuard(timeoutMs)
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: guard.signal })
      if (!response.ok) throw httpError(response.status, await response.text(), stubResolved('openai', baseUrl, apiKey, timeoutMs))
      const bodyUnknown: unknown = await response.json()
      const body = asRecord(bodyUnknown)
      const rows = Array.isArray(body.data) ? body.data : Array.isArray(bodyUnknown) ? bodyUnknown : []
      const models: DiscoveredModel[] = []
      for (const row of rows) {
        const rec = asRecord(row)
        const id = typeof rec.id === 'string' ? rec.id.trim() : typeof rec.name === 'string' ? rec.name.trim() : ''
        if (!id) continue
        models.push({
          id,
          ownedBy: typeof rec.owned_by === 'string' ? rec.owned_by : undefined,
          created: typeof rec.created === 'number' ? rec.created : undefined
        })
      }
      models.sort((a, b) => a.id.localeCompare(b.id))
      return models
    } catch (error) {
      throw this.mapChatError(error, guard, stubResolved('openai', baseUrl, apiKey, timeoutMs))
    } finally {
      guard.cleanup()
    }
  }

  private async discoverOllama(baseUrl: string, apiKey: string | null, timeoutMs: number): Promise<DiscoveredModel[]> {
    const url = resolveOllamaTagsUrl(baseUrl)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const guard = createFetchGuard(timeoutMs)
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: guard.signal })
      if (!response.ok) throw httpError(response.status, await response.text(), stubResolved('ollama', baseUrl, apiKey, timeoutMs))
      const body = (await response.json()) as { models?: unknown }
      const rows = Array.isArray(body.models) ? body.models : []
      const models: DiscoveredModel[] = []
      for (const row of rows) {
        const rec = asRecord(row)
        const id =
          typeof rec.name === 'string'
            ? rec.name.trim()
            : typeof rec.model === 'string'
              ? rec.model.trim()
              : ''
        if (!id) continue
        models.push({ id })
      }
      models.sort((a, b) => a.id.localeCompare(b.id))
      return models
    } catch (error) {
      throw this.mapChatError(error, guard, stubResolved('ollama', baseUrl, apiKey, timeoutMs))
    } finally {
      guard.cleanup()
    }
  }

  /* ------------------------------ resolve ------------------------- */

  resolve(profileId?: string | null): ResolvedModel {
    let profile: ModelProfile | null = null
    if (profileId) {
      profile = this.store.getModelProfile(profileId)
      if (!profile) {
        throw new AppError('MODEL_ERROR', `模型配置不存在: ${profileId}`, {
          hint: '该模型配置可能已被删除，请在“模型设置”中重新选择默认模型。'
        })
      }
    } else {
      const settings = this.store.getSettings()
      profile = settings.defaultModelProfileId ? this.store.getModelProfile(settings.defaultModelProfileId) : null
      if (!profile) profile = this.store.listModelProfiles().find((p) => p.isDefault) ?? null
      if (!profile) profile = this.store.listModelProfiles()[0] ?? null
    }
    if (!profile) {
      throw new AppError('MODEL_ERROR', '尚未配置任何模型', {
        hint: '请在“模型设置”中添加一个 OpenAI 兼容 API 或本地 Ollama 模型，并设为默认模型。'
      })
    }

    let apiKey: string | null = null
    const cipher = this.store.getModelSecretCipher(profile.id)
    if (cipher) {
      if (!this.secrets.available()) {
        throw new AppError('SECRET_ERROR', '系统密钥库不可用，无法解密 API Key', {
          hint: '请确认系统密钥库可用后重新保存 API Key，或改用本地 Ollama 模型。'
        })
      }
      apiKey = this.secrets.decrypt(cipher)
      if (apiKey === null) {
        throw new AppError('SECRET_ERROR', 'API Key 解密失败', {
          hint: '密钥可能已失效，请在“模型设置”中重新保存 API Key。'
        })
      }
    }

    return {
      profileId: profile.id,
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      timeoutMs: profile.timeoutMs,
      toolsEnabled: profile.toolsEnabled
    }
  }

  resolveDecision(profileId?: string | null): ResolvedModel | null {
    let profile: ModelProfile | null = null
    if (profileId) {
      profile = this.store.getModelProfile(profileId)
      if (!profile) {
        throw new AppError('MODEL_ERROR', `决策模型配置不存在: ${profileId}`, {
          hint: '该 JEV 配置可能已被删除，请在“模型设置”中重新选择默认决策模型。'
        })
      }
    } else {
      const settings = this.store.getSettings()
      profile = settings.defaultDecisionModelProfileId
        ? this.store.getModelProfile(settings.defaultDecisionModelProfileId)
        : null
      if (!profile) {
        profile = this.store.listModelProfiles().find((p) => p.roles?.includes('decision')) ?? null
      }
    }
    if (!profile) return null
    // Reuse resolve() secret/URL path for a known id.
    return this.resolve(profile.id)
  }

  /* ------------------------------ test ---------------------------- */

  async test(id: string): Promise<ModelTestResult> {
    const profile = this.store.getModelProfile(id)
    if (!profile) throw new AppError('NOT_FOUND', `模型配置不存在: ${id}`)
    const base = this.resolve(id)
    const resolved: ResolvedModel = { ...base, timeoutMs: Math.min(base.timeoutMs, 30_000) }
    const probe: ToolDefinition = {
      name: 'ping',
      description: 'Echo a numeric value. Used to probe tool-calling support.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'number', description: 'value to echo' } },
        required: ['value'],
        additionalProperties: false
      },
      permission: 'read',
      requiresApproval: false,
      timeoutMs: 10_000
    }
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a connectivity probe. When a tool is available you must call it exactly once. Do not answer with text.'
      },
      { role: 'user', content: 'Call the ping tool with value 42.' }
    ]
    const started = Date.now()
    let result: ModelTestResult

    try {
      const completion = await this.chat(resolved, messages, { tools: [probe] })
      result = {
        ok: true,
        latencyMs: Date.now() - started,
        model: profile.model,
        provider: profile.kind,
        sample: sampleOf(completion),
        toolSupport: completion.toolCalls.length > 0 ? 'supported' : 'unknown'
      }
    } catch (error) {
      const appError = toModelAppError(error)
      const toolsRejected = looksLikeToolsUnsupported(appError.message)
      if (toolsRejected) {
        // Retry without tools so the connectivity result stays truthful.
        try {
          const completion = await this.chat(resolved, messages, {})
          result = {
            ok: true,
            latencyMs: Date.now() - started,
            model: profile.model,
            provider: profile.kind,
            sample: sampleOf(completion),
            toolSupport: 'unsupported',
            hint: '模型可以对话，但该服务不支持 tools/function calling，Agent 只能进行无工具的对话。'
          } as ModelTestResult
        } catch (retryError) {
          const retryAppError = toModelAppError(retryError)
          result = {
            ok: false,
            latencyMs: Date.now() - started,
            model: profile.model,
            provider: profile.kind,
            error: retryAppError.message,
            hint: retryAppError.hint,
            toolSupport: 'unsupported'
          }
        }
      } else {
        result = {
          ok: false,
          latencyMs: Date.now() - started,
          model: profile.model,
          provider: profile.kind,
          error: appError.message,
          hint: appError.hint,
          toolSupport: 'unknown'
        }
      }
    }

    try {
      const latest = this.store.getModelProfile(id) ?? profile
      this.store.saveModelProfile({ ...latest, lastTestAt: nowIso(), lastTestOk: result.ok })
    } catch (error) {
      this.logger?.warn('failed to persist model test result', { id, error: String(error) })
    }
    this.logger?.info('model test finished', { id, ok: result.ok, latencyMs: result.latencyMs, toolSupport: result.toolSupport })
    return result
  }

  /* ------------------------------ chat ---------------------------- */

  async chat(model: ResolvedModel, messages: ChatMessage[], opts: ChatStreamOptions = {}): Promise<ChatCompletion> {
    if (!model) throw new AppError('MODEL_ERROR', '缺少模型配置')
    if (!Array.isArray(messages) || messages.length === 0) throw new AppError('VALIDATION', 'messages 不能为空')
    this.logger?.debug('model chat request', {
      provider: model.kind,
      model: model.model,
      messages: messages.length,
      tools: opts.tools?.length ?? 0
    })
    return model.kind === 'ollama' ? this.chatOllama(model, messages, opts) : this.chatOpenAi(model, messages, opts)
  }

  private async chatOpenAi(
    model: ResolvedModel,
    messages: ChatMessage[],
    opts: ChatStreamOptions
  ): Promise<ChatCompletion> {
    const url = resolveOpenAiChatUrl(model.baseUrl)
    const body: Record<string, unknown> = {
      model: model.model,
      messages: toOpenAiMessages(messages),
      stream: true,
      temperature: model.temperature,
      max_tokens: model.maxTokens,
      stream_options: { include_usage: true }
    }
    if (model.toolsEnabled && opts.tools?.length) {
      body.tools = toOpenAiTools(opts.tools)
      body.tool_choice = 'auto'
    }
    if (opts.jsonMode) body.response_format = { type: 'json_object' }
    const headers = this.buildHeaders(model)

    const guard = createFetchGuard(model.timeoutMs, opts.signal)
    try {
      let response = await this.send(url, headers, body, guard, model)
      if (!response.ok && response.status === 400) {
        const text = await response.text()
        if (/stream_options/i.test(text)) {
          delete body.stream_options
          response = await this.send(url, headers, body, guard, model)
          if (!response.ok) throw httpError(response.status, await response.text(), model)
        } else {
          throw httpError(400, text, model)
        }
      } else if (!response.ok) {
        throw httpError(response.status, await response.text(), model)
      }
      if (!response.body) throw new AppError('MODEL_ERROR', '模型服务返回了空响应体')

      let content = ''
      const calls = new Map<number, RawToolCall>()
      let finishReason = ''
      let usage = { prompt: 0, completion: 0, total: 0 }

      for await (const line of readLines(response.body)) {
        if (guard.externallyAborted()) {
          throw new AppError('CANCELLED', '模型请求已取消', { hint: '任务已被用户取消' })
        }
        if (guard.timedOut()) throw new AppError('TIMEOUT', `模型流式响应超时（${model.timeoutMs}ms）`)
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.startsWith(':')) continue // SSE comment / keep-alive
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') break
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue // tolerate non-JSON keep-alives
        }
        const chunkError = chunk.error
        if (chunkError) {
          const message = typeof chunkError === 'string' ? chunkError : extractErrorMessage(JSON.stringify({ error: chunkError }))
          throw new AppError('MODEL_ERROR', `模型服务流式返回错误：${redactSecret(message, model.apiKey).slice(0, 500)}`, {
            hint: '请检查模型服务日志、模型名称与参数后重试。'
          })
        }
        const chunkUsage = asRecord(chunk.usage)
        if (Object.keys(chunkUsage).length) {
          usage = {
            prompt: toInt(chunkUsage.prompt_tokens ?? chunkUsage.input_tokens),
            completion: toInt(chunkUsage.completion_tokens ?? chunkUsage.output_tokens),
            total: toInt(chunkUsage.total_tokens)
          }
          if (!usage.total) usage.total = usage.prompt + usage.completion
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : []
        const choice = asRecord(choices[0])
        if (!choice) continue
        const delta = asRecord(choice.delta)
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content
          opts.onDelta?.(delta.content)
        }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason
        const toolDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
        for (let i = 0; i < toolDeltas.length; i++) {
          const toolDelta = asRecord(toolDeltas[i])
          const fn = asRecord(toolDelta.function)
          const index = typeof toolDelta.index === 'number' ? toolDelta.index : i
          const entry = calls.get(index) ?? { index, id: '', name: '', argumentsText: '' }
          if (typeof toolDelta.id === 'string' && toolDelta.id) entry.id = toolDelta.id
          if (typeof fn.name === 'string' && fn.name) entry.name = fn.name
          if (typeof fn.arguments === 'string') {
            if (entry.argumentsText.length < MAX_TOOL_ARGUMENT_CHARS) entry.argumentsText += fn.arguments
          } else if (fn.arguments && typeof fn.arguments === 'object') {
            entry.argumentsText = JSON.stringify(fn.arguments)
          }
          calls.set(index, entry)
        }
      }

      const toolCalls = finalizeToolCalls(Array.from(calls.values()))
      return {
        content,
        toolCalls,
        finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
        usage
      }
    } catch (error) {
      throw this.mapChatError(error, guard, model)
    } finally {
      guard.cleanup()
    }
  }

  private async chatOllama(
    model: ResolvedModel,
    messages: ChatMessage[],
    opts: ChatStreamOptions
  ): Promise<ChatCompletion> {
    const url = resolveOllamaChatUrl(model.baseUrl)
    const body: Record<string, unknown> = {
      model: model.model,
      messages: toOllamaMessages(messages),
      stream: true,
      options: { temperature: model.temperature, num_predict: model.maxTokens }
    }
    if (model.toolsEnabled && opts.tools?.length) body.tools = toOllamaTools(opts.tools)
    if (opts.jsonMode) body.format = 'json'
    const headers = this.buildHeaders(model)

    const guard = createFetchGuard(model.timeoutMs, opts.signal)
    try {
      const response = await this.send(url, headers, body, guard, model)
      if (!response.ok) throw httpError(response.status, await response.text(), model)
      if (!response.body) throw new AppError('MODEL_ERROR', '模型服务返回了空响应体')

      let content = ''
      const calls = new Map<number, RawToolCall>()
      let finishReason = ''
      let usage = { prompt: 0, completion: 0, total: 0 }

      for await (const line of readLines(response.body)) {
        if (guard.externallyAborted()) {
          throw new AppError('CANCELLED', '模型请求已取消', { hint: '任务已被用户取消' })
        }
        if (guard.timedOut()) throw new AppError('TIMEOUT', `模型流式响应超时（${model.timeoutMs}ms）`)
        const trimmed = line.trim()
        if (!trimmed) continue
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }
        if (chunk.error) {
          const message = typeof chunk.error === 'string' ? chunk.error : extractErrorMessage(JSON.stringify({ error: chunk.error }))
          throw new AppError('MODEL_ERROR', `Ollama 返回错误：${redactSecret(message, model.apiKey).slice(0, 500)}`, {
            hint: '请确认 Ollama 服务已启动且模型已通过 `ollama pull` 下载。'
          })
        }
        const message = asRecord(chunk.message)
        if (typeof message.content === 'string' && message.content) {
          content += message.content
          opts.onDelta?.(message.content)
        }
        const messageToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
        for (let i = 0; i < messageToolCalls.length; i++) {
          const toolCall = asRecord(messageToolCalls[i])
          const fn = asRecord(toolCall.function)
          const index = typeof toolCall.index === 'number' ? toolCall.index : i
          const entry = calls.get(index) ?? { index, id: '', name: '', argumentsText: '' }
          if (typeof toolCall.id === 'string' && toolCall.id) entry.id = toolCall.id
          if (typeof fn.name === 'string' && fn.name) entry.name = fn.name
          if (typeof fn.arguments === 'string') {
            if (entry.argumentsText.length < MAX_TOOL_ARGUMENT_CHARS) entry.argumentsText += fn.arguments
          } else if (fn.arguments && typeof fn.arguments === 'object') {
            // Ollama returns complete argument objects (not partial JSON fragments).
            entry.argumentsText = JSON.stringify(fn.arguments)
          }
          calls.set(index, entry)
        }
        if (chunk.done === true) {
          usage = {
            prompt: toInt(chunk.prompt_eval_count),
            completion: toInt(chunk.eval_count),
            total: toInt(chunk.prompt_eval_count) + toInt(chunk.eval_count)
          }
          finishReason = typeof chunk.done_reason === 'string' ? chunk.done_reason : 'stop'
        }
      }

      const toolCalls = finalizeToolCalls(Array.from(calls.values()))
      return {
        content,
        toolCalls,
        finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
        usage
      }
    } catch (error) {
      throw this.mapChatError(error, guard, model)
    } finally {
      guard.cleanup()
    }
  }

  /* ----------------------------- helpers -------------------------- */

  private buildHeaders(model: ResolvedModel): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/x-ndjson, application/json'
    }
    if (model.apiKey) headers.authorization = `Bearer ${model.apiKey}`
    return headers
  }

  private async send(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    guard: FetchGuard,
    model: ResolvedModel
  ): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: guard.signal
      })
    } catch (error) {
      throw networkError(error, guard, model)
    }
  }

  private mapChatError(error: unknown, guard: FetchGuard, model: ResolvedModel): AppError {
    if (error instanceof AppError) return error
    return networkError(error, guard, model)
  }

  private syncDefaultSetting(profileId: string | null): void {
    try {
      const settings = this.store.getSettings()
      if (settings.defaultModelProfileId !== profileId) {
        this.store.updateSettings({ defaultModelProfileId: profileId })
      }
    } catch (error) {
      this.logger?.warn('failed to sync default model setting', { error: String(error) })
    }
  }

  private syncDefaultDecisionSetting(profileId: string | null): void {
    try {
      const settings = this.store.getSettings()
      if (settings.defaultDecisionModelProfileId !== profileId) {
        this.store.updateSettings({ defaultDecisionModelProfileId: profileId })
      }
    } catch (error) {
      this.logger?.warn('failed to sync default decision model setting', { error: String(error) })
    }
  }

  private persistConfigFile(): void {
    if (!this.configFilePath) return
    try {
      const profiles = this.list()
      const settings = this.store.getSettings()
      const defaultId = settings.defaultModelProfileId ?? profiles.find((p) => p.isDefault)?.id ?? null
      const defaultDecisionId =
        settings.defaultDecisionModelProfileId ??
        profiles.find((p) => p.roles?.includes('decision'))?.id ??
        null
      writeModelsConfigFile(this.configFilePath, profiles, defaultId, defaultDecisionId)
    } catch (error) {
      this.logger?.warn('failed to write models-config.json', { error: String(error), path: this.configFilePath })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Small local helpers                                                 */
/* ------------------------------------------------------------------ */

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : value === undefined || value === null ? NaN : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function isModelDeps(value: unknown): value is ModelServiceOptions {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ModelServiceOptions).store?.listModelProfiles === 'function' &&
    typeof (value as ModelServiceOptions).secrets?.decrypt === 'function'
  )
}

function toModelAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  return new AppError('MODEL_ERROR', error instanceof Error ? error.message : String(error))
}

function looksLikeToolsUnsupported(message: string): boolean {
  if (!/(tool|function[_ ]?call|functions)/i.test(message)) return false
  return /(not support|unsupported|unknown|invalid|does not support|不支持|无法识别|not allowed|not available)/i.test(message)
}

function sampleOf(completion: ChatCompletion): string {
  const text = (completion.content ?? '').trim()
  if (text) return text.slice(0, 200)
  if (completion.toolCalls.length) return `tool_call: ${completion.toolCalls.map((call) => call.name).join(', ')}`
  return '(空响应)'
}

function stubResolved(
  kind: ModelProviderKind,
  baseUrl: string,
  apiKey: string | null,
  timeoutMs: number
): ResolvedModel {
  return {
    profileId: 'discover',
    kind,
    baseUrl,
    model: '',
    apiKey,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs,
    toolsEnabled: false
  }
}

function shortModelLabel(modelId: string): string {
  const parts = modelId.split(/[/:]/)
  return parts[parts.length - 1] || modelId
}

/** Prefer common chat models; otherwise the first id. */
export function pickSuggestedModel(ids: string[], kind: ModelProviderKind): string | undefined {
  if (ids.length === 0) return undefined
  const prefer =
    kind === 'ollama'
      ? [/qwen/i, /llama/i, /mistral/i, /deepseek/i, /gemma/i]
      : [/deepseek-chat/i, /gpt-4o-mini/i, /gpt-4o/i, /claude/i, /qwen/i, /kimi/i, /chat/i]
  for (const re of prefer) {
    const hit = ids.find((id) => re.test(id))
    if (hit) return hit
  }
  return ids[0]
}
