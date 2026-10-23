import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  CheckCircle2,
  Copy,
  Cpu,
  FolderOpen,
  KeyRound,
  Pencil,
  Plus,
  Radar,
  ShieldCheck,
  Star,
  Trash2,
  XCircle,
  Zap
} from 'lucide-react'
import type {
  DiscoveredModel,
  ModelDiscoverResult,
  ModelProfile,
  ModelProfileInput,
  ModelProviderKind,
  ModelTestResult
} from '@shared/types'
import { call } from '../lib/api'
import { useAppStore } from '../lib/store'
import { formatDate, formatDuration, formatRelative } from '../lib/format'
import {
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  Textarea
} from '../components/ui'
import { ErrorLine, MetaGrid, RefreshButton, useAsync } from '../components/intel/IntelCommon'

/* ------------------------------------------------------------------ */

const KIND_LABEL: Record<ModelProviderKind, string> = {
  openai: '外部 OpenAI 兼容 API',
  ollama: '本地 Ollama（可选）'
}

const TOOL_SUPPORT_LABEL: Record<ModelTestResult['toolSupport'], string> = {
  supported: '支持工具调用',
  unsupported: '不支持工具调用',
  unknown: '未知'
}

/** One-click presets: all go through external HTTP OpenAI-compatible gateways. */
const API_PRESETS: Array<{
  id: string
  label: string
  name: string
  kind: ModelProviderKind
  baseUrl: string
  model: string
  notes: string
}> = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek Chat',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    notes: '外部 API：https://api.deepseek.com/v1'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'OpenAI GPT',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    notes: '外部 API：https://api.openai.com/v1'
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    name: 'Moonshot Kimi',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    notes: '外部 API：https://api.moonshot.cn/v1'
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    name: 'SiliconFlow',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    notes: '外部 API：https://api.siliconflow.cn/v1'
  },
  {
    id: 'custom',
    label: '自定义网关',
    name: '自定义 OpenAI 兼容',
    kind: 'openai',
    baseUrl: 'https://your-gateway.example.com/v1',
    model: 'your-model-id',
    notes: '任意 OpenAI 兼容网关：填写 /v1 基址 + API Key'
  }
]

interface FormState {
  id: string | null
  name: string
  kind: ModelProviderKind
  baseUrl: string
  model: string
  apiKey: string
  temperature: string
  maxTokens: string
  timeoutMs: string
  toolsEnabled: boolean
  isDefault: boolean
  roleAgent: boolean
  roleDecision: boolean
  notes: string
  apiKeyStored: boolean
  /** When set, save will copy encrypted API key from this profile. */
  copyApiKeyFromId: string | null
}

const EMPTY_FORM: FormState = {
  id: null,
  name: 'DeepSeek Chat',
  kind: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  temperature: '0.2',
  maxTokens: '8192',
  timeoutMs: '180000',
  toolsEnabled: true,
  isDefault: false,
  roleAgent: true,
  roleDecision: false,
  notes: '外部 API：https://api.deepseek.com/v1',
  apiKeyStored: false,
  copyApiKeyFromId: null
}

function parseNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/* ------------------------------------------------------------------ */

export function ModelsPage(): ReactNode {
  const toastOk = useAppStore((s) => s.toastOk)
  const toastError = useAppStore((s) => s.toastError)
  const info = useAppStore((s) => s.info)
  const settings = useAppStore((s) => s.settings)
  const refreshSettings = useAppStore((s) => s.refreshSettings)

  const list = useAsync(async () => call('model.list', undefined), [])
  const models = list.data ?? []

  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formError, setFormError] = useState<unknown>(null)
  const [formFieldError, setFormFieldError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<ModelProfile | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<unknown>(null)

  const [testBusyId, setTestBusyId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ profile: ModelProfile; result: ModelTestResult } | null>(null)
  const [testError, setTestError] = useState<unknown>(null)
  const [defaultBusyId, setDefaultBusyId] = useState<string | null>(null)
  const [decisionBusyId, setDecisionBusyId] = useState<string | null>(null)
  const [duplicateBusyId, setDuplicateBusyId] = useState<string | null>(null)

  const [discoverBusy, setDiscoverBusy] = useState(false)
  const [discoverResult, setDiscoverResult] = useState<ModelDiscoverResult | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([])
  const [configPath, setConfigPath] = useState<string>(info?.modelsConfigPath ?? '')

  useEffect(() => {
    if (info?.modelsConfigPath) setConfigPath(info.modelsConfigPath)
    else {
      void call('model.configPath', undefined)
        .then((res) => setConfigPath(res.path))
        .catch(() => undefined)
    }
  }, [info?.modelsConfigPath])

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const openCreate = useCallback((presetId = 'deepseek') => {
    const preset = API_PRESETS.find((item) => item.id === presetId) ?? API_PRESETS[0]
    setForm({
      ...EMPTY_FORM,
      name: preset.name,
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      model: preset.model,
      notes: preset.notes,
      toolsEnabled: true,
      copyApiKeyFromId: null
    })
    setDiscovered([])
    setDiscoverResult(null)
    setFormError(null)
    setFormFieldError(null)
    setFormOpen(true)
  }, [])

  const openEdit = useCallback((profile: ModelProfile) => {
    const roles = profile.roles?.length ? profile.roles : (['agent'] as Array<'agent' | 'decision'>)
    setForm({
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: '',
      temperature: String(profile.temperature),
      maxTokens: String(profile.maxTokens),
      timeoutMs: String(profile.timeoutMs),
      toolsEnabled: profile.toolsEnabled,
      isDefault: profile.isDefault,
      roleAgent: roles.includes('agent'),
      roleDecision: roles.includes('decision'),
      notes: profile.notes,
      apiKeyStored: profile.apiKeyStored,
      copyApiKeyFromId: null
    })
    setDiscovered([])
    setDiscoverResult(null)
    setFormError(null)
    setFormFieldError(null)
    setFormOpen(true)
  }, [])

  const openDuplicate = useCallback(
    async (profile: ModelProfile) => {
      setDuplicateBusyId(profile.id)
      try {
        const created = await call('model.duplicate', { id: profile.id })
        list.reload()
        toastOk(
          '已复制模型配置',
          created.apiKeyStored
            ? `${created.name}（已复用 API Key）`
            : `${created.name}（原配置无密钥，请手动填写）`
        )
        openEdit(created)
      } catch (e) {
        toastError(e)
      } finally {
        setDuplicateBusyId(null)
      }
    },
    [list, openEdit, toastError, toastOk]
  )

  const runDiscover = useCallback(async () => {
    setFormFieldError(null)
    setDiscoverResult(null)
    const baseUrl = form.baseUrl.trim()
    if (!baseUrl) {
      setFormFieldError('请先填写 Base URL，再检测可用模型')
      return
    }
    setDiscoverBusy(true)
    try {
      const result = await call('model.discover', {
        baseUrl,
        kind: form.kind,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        ...(!form.apiKey.trim() && (form.id || form.copyApiKeyFromId)
          ? { profileId: form.id || form.copyApiKeyFromId || undefined }
          : {})
      })
      setDiscoverResult(result)
      setDiscovered(result.models)
      if (result.ok && result.models.length > 0) {
        setForm((prev) => ({
          ...prev,
          kind: result.kind,
          baseUrl: result.baseUrl || prev.baseUrl,
          model: result.suggestedModel || prev.model || result.models[0].id,
          name:
            !prev.id && (prev.name === EMPTY_FORM.name || prev.name.startsWith('DeepSeek') || prev.name.includes('自定义'))
              ? result.suggestedName || prev.name
              : prev.name
        }))
        toastOk('已检测模型列表', `共 ${result.models.length} 个，已自动填写推荐模型`)
      } else if (result.ok) {
        toastOk('检测完成', '服务可达，但未返回模型列表，请手动填写模型名')
      }
    } catch (e) {
      setFormError(e)
    } finally {
      setDiscoverBusy(false)
    }
  }, [form.apiKey, form.baseUrl, form.copyApiKeyFromId, form.id, form.kind, toastOk])

  const submit = useCallback(async () => {
    setFormError(null)
    setFormFieldError(null)
    const name = form.name.trim()
    const baseUrl = form.baseUrl.trim()
    const model = form.model.trim()
    if (!name) {
      setFormFieldError('请填写配置名称')
      return
    }
    if (!baseUrl) {
      setFormFieldError('请填写 Base URL')
      return
    }
    if (!model) {
      setFormFieldError('请填写模型名')
      return
    }
    if (form.kind === 'openai' && !/^https?:\/\//i.test(baseUrl)) {
      setFormFieldError('OpenAI 兼容地址必须以 http:// 或 https:// 开头，并建议填写到 /v1 级别')
      return
    }
    if (form.kind === 'ollama' && !/^https?:\/\//i.test(baseUrl)) {
      setFormFieldError('Ollama 地址必须以 http:// 或 https:// 开头，例如 http://127.0.0.1:11434')
      return
    }
    const temperature = parseNumber(form.temperature)
    const maxTokens = parseNumber(form.maxTokens)
    const timeoutMs = parseNumber(form.timeoutMs)
    if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
      setFormFieldError('temperature 必须在 0–2 之间')
      return
    }
    if (maxTokens !== undefined && (maxTokens < 1 || maxTokens > 1_000_000 || !Number.isInteger(maxTokens))) {
      setFormFieldError('maxTokens 必须是 1–1000000 的整数')
      return
    }
    if (timeoutMs !== undefined && (timeoutMs < 1000 || timeoutMs > 600_000 || !Number.isInteger(timeoutMs))) {
      setFormFieldError('timeoutMs 必须是 1000–600000 的整数')
      return
    }
    if (!form.roleAgent && !form.roleDecision) {
      setFormFieldError('请至少勾选一个角色：主模型(Agent) 或 决策模型(JEV)')
      return
    }
    const roles: ModelProfileInput['roles'] = []
    if (form.roleAgent) roles.push('agent')
    if (form.roleDecision) roles.push('decision')

    const input: ModelProfileInput = {
      ...(form.id ? { id: form.id } : {}),
      name,
      kind: form.kind,
      baseUrl,
      model,
      ...(form.apiKey.trim()
        ? { apiKey: form.apiKey }
        : !form.id && form.copyApiKeyFromId
          ? { copyApiKeyFromProfileId: form.copyApiKeyFromId }
          : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      toolsEnabled: form.toolsEnabled,
      isDefault: form.isDefault,
      roles,
      notes: form.notes
    }

    setSaving(true)
    try {
      await call('model.save', input)
      setFormOpen(false)
      list.reload()
      toastOk('模型配置已保存', `${name}（${KIND_LABEL[form.kind]}）`)
    } catch (e) {
      setFormError(e)
    } finally {
      setSaving(false)
    }
  }, [form, list, toastOk])

  const remove = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await call('model.delete', { id: deleteTarget.id })
      toastOk('模型配置已删除', deleteTarget.name)
      setDeleteTarget(null)
      list.reload()
    } catch (e) {
      setDeleteError(e)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, list, toastOk])

  const setDefault = useCallback(
    async (profile: ModelProfile) => {
      setDefaultBusyId(profile.id)
      try {
        await call('model.setDefault', { id: profile.id })
        list.reload()
        void refreshSettings?.()
        toastOk('已设为默认 Agent 模型', profile.name)
      } catch (e) {
        toastError(e)
      } finally {
        setDefaultBusyId(null)
      }
    },
    [list, refreshSettings, toastError, toastOk]
  )

  const setDefaultDecision = useCallback(
    async (profile: ModelProfile) => {
      setDecisionBusyId(profile.id)
      try {
        await call('model.setDefaultDecision', { id: profile.id })
        list.reload()
        void refreshSettings?.()
        toastOk('已设为默认 JEV', profile.name)
      } catch (e) {
        toastError(e)
      } finally {
        setDecisionBusyId(null)
      }
    },
    [list, refreshSettings, toastError, toastOk]
  )

  const runTest = useCallback(
    async (profile: ModelProfile) => {
      setTestBusyId(profile.id)
      setTestError(null)
      setTestResult(null)
      try {
        const result = await call('model.test', { id: profile.id })
        setTestResult({ profile, result })
        list.reload()
      } catch (e) {
        setTestError(e)
      } finally {
        setTestBusyId(null)
      }
    },
    [list]
  )

  const defaultModel = useMemo(() => models.find((profile) => profile.isDefault) ?? null, [models])
  const defaultDecisionId = settings?.defaultDecisionModelProfileId ?? null
  const defaultDecision = useMemo(
    () => (defaultDecisionId ? models.find((profile) => profile.id === defaultDecisionId) ?? null : null),
    [defaultDecisionId, models]
  )

  const baseUrlHint =
    form.kind === 'openai'
      ? 'OpenAI 兼容端点请填写到 /v1 级别，例如 https://api.example.com/v1（不要填写完整的 /chat/completions）'
      : '本地 Ollama 通常为 http://127.0.0.1:11434（不要带 /api/chat 路径）'

  const renderForm = (): ReactNode => (
    <div className="col" style={{ gap: 10 }}>
      <Callout kind="info" title="默认走外部 API 链接">
        填写 OpenAI 兼容网关的 Base URL（到 /v1）和 API Key 即可。模型只负责推理；SQL / 备份 / 恢复仍由主进程受控执行，写操作必须人工审批。
      </Callout>

      {!form.id && (
        <Field label="快速预设" hint="点击后自动填入外部 API 地址与模型名，再粘贴你的 API Key">
          <div className="row wrap" style={{ gap: 6 }}>
            {API_PRESETS.map((preset) => (
              <Button key={preset.id} size="sm" variant="ghost" onClick={() => openCreate(preset.id)}>
                {preset.label}
              </Button>
            ))}
          </div>
        </Field>
      )}

      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <Field label="配置名称" className="grow" error={formFieldError && formFieldError.includes('名称') ? formFieldError : undefined}>
          <Input value={form.name} onChange={(value) => update('name', value)} placeholder="例如：DeepSeek 生产 / 公司网关" maxLength={120} />
        </Field>
        <Field label="接口类型" className="grow">
          <Select
            value={form.kind}
            onChange={(value) => {
              update('kind', value)
              if (value === 'openai' && (!form.baseUrl.trim() || form.baseUrl.includes('11434'))) {
                update('baseUrl', 'https://api.deepseek.com/v1')
              }
              if (value === 'ollama' && !form.baseUrl.trim()) {
                update('baseUrl', 'http://127.0.0.1:11434')
              }
            }}
            options={[
              { value: 'openai', label: '外部 OpenAI 兼容 API（推荐）' },
              { value: 'ollama', label: '本地 Ollama（可选）' }
            ]}
          />
        </Field>
      </div>

      <Field label="API Base URL" hint={baseUrlHint}>
        <div className="row" style={{ gap: 8 }}>
          <Input
            value={form.baseUrl}
            onChange={(value) => update('baseUrl', value)}
            placeholder={form.kind === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.deepseek.com/v1'}
          />
          <Button
            variant="primary"
            loading={discoverBusy}
            onClick={() => void runDiscover()}
            icon={<Radar size={13} />}
            title="请求服务端模型列表并自动填写"
          >
            检测模型
          </Button>
        </div>
      </Field>

      <Field
        label="API Key"
        hint={
          form.id
            ? form.apiKeyStored
              ? '已由系统密钥库加密存储。留空表示不修改已存密钥；检测模型时可复用。'
              : '尚未存储密钥。留空表示不修改。'
            : form.copyApiKeyFromId
              ? '将从原配置安全复制已存密钥，无需重新粘贴。若填写新 Key 则改用新值。'
              : '仅以密文写入系统密钥库。检测模型时需要时会临时使用，不会写入配置文件。'
        }
      >
        <Input
          value={form.apiKey}
          onChange={(value) => {
            update('apiKey', value)
            if (value.trim()) update('copyApiKeyFromId', null)
          }}
          type="password"
          placeholder={
            form.copyApiKeyFromId
              ? '••••••••（将复用原配置密钥，留空即可）'
              : form.apiKeyStored
                ? '••••••••（已存储，留空不修改）'
                : '粘贴 API Key（可选，Ollama 通常不需要）'
          }
        />
      </Field>
      {form.copyApiKeyFromId && (
        <Callout kind="ok" title="已准备复用 API Key">
          保存后会把原配置中的密钥复制到新模型，明文不会出现在剪贴板或配置文件里。
        </Callout>
      )}

      <Field
        label="模型名"
        hint={
          discovered.length > 0
            ? `已检测到 ${discovered.length} 个模型，可从列表选择或继续手填`
            : form.kind === 'ollama'
              ? '填写 Base URL 后点「检测模型」可自动拉取本地列表'
              : '填写 Base URL + API Key 后点「检测模型」可自动拉取并填写'
        }
      >
        {discovered.length > 0 ? (
          <Select
            value={form.model}
            onChange={(value) => update('model', value)}
            options={[
              { value: '', label: '选择检测到的模型…' },
              ...discovered.map((item) => ({
                value: item.id,
                label: item.ownedBy ? `${item.id}（${item.ownedBy}）` : item.id
              })),
              ...(form.model && !discovered.some((d) => d.id === form.model)
                ? [{ value: form.model, label: `${form.model}（当前）` }]
                : [])
            ]}
          />
        ) : (
          <Input
            value={form.model}
            onChange={(value) => update('model', value)}
            placeholder={form.kind === 'ollama' ? 'qwen2.5-coder' : 'gpt-4o-mini'}
          />
        )}
      </Field>

      {discoverResult && (
        <Callout
          kind={discoverResult.ok ? (discoverResult.models.length ? 'ok' : 'warn') : 'danger'}
          title={
            discoverResult.ok
              ? `检测成功 · ${discoverResult.kind} · ${discoverResult.latencyMs} ms`
              : '检测失败'
          }
        >
          {discoverResult.ok ? (
            <div className="small">
              Base URL <span className="mono">{discoverResult.baseUrl}</span>
              {discoverResult.suggestedModel ? (
                <>
                  {' '}
                  · 已推荐 <span className="mono">{discoverResult.suggestedModel}</span>
                </>
              ) : null}
              {discoverResult.hint ? <div className="muted mt-1">{discoverResult.hint}</div> : null}
            </div>
          ) : (
            <div className="small">
              {discoverResult.error}
              {discoverResult.hint ? <div className="muted mt-1">提示：{discoverResult.hint}</div> : null}
            </div>
          )}
        </Callout>
      )}

      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <Field label="temperature" hint="建议 0.2（Agent 查库）" className="grow">
          <Input value={form.temperature} onChange={(value) => update('temperature', value)} type="number" />
        </Field>
        <Field label="maxTokens" hint="建议 8192（2048 易截断）" className="grow">
          <Input value={form.maxTokens} onChange={(value) => update('maxTokens', value)} type="number" />
        </Field>
        <Field label="timeoutMs" hint="建议 180000（3 分钟）" className="grow">
          <Input value={form.timeoutMs} onChange={(value) => update('timeoutMs', value)} type="number" />
        </Field>
        <Button
          size="sm"
          variant="ghost"
          title="填入 Agent 推荐：0.2 / 8192 / 180000"
          onClick={() =>
            setForm((prev) => ({
              ...prev,
              temperature: '0.2',
              maxTokens: '8192',
              timeoutMs: '180000'
            }))
          }
        >
          推荐参数
        </Button>
      </div>

      <div className="col" style={{ gap: 6 }}>
        <div className="field-label">角色（可多选）</div>
        <Checkbox
          checked={form.roleAgent}
          onChange={(checked) => update('roleAgent', checked)}
          label="主模型 (Agent) — 工具调用 / 查库 / 改库主循环"
        />
        <Checkbox
          checked={form.roleDecision}
          onChange={(checked) => update('roleDecision', checked)}
          label="决策模型 (JEV) — 审计划、拍板、校验结论（无工具）"
        />
        <Checkbox
          checked={form.toolsEnabled}
          onChange={(checked) => update('toolsEnabled', checked)}
          label="允许该模型使用受控工具（list_databases / inspect_schema / search_memory / run_readonly_query / explain_query / propose_sql_change / execute_approved_change / verify_task_result）"
        />
        <Checkbox checked={form.isDefault} onChange={(checked) => update('isDefault', checked)} label="设为默认 Agent 模型" />
        {!form.roleAgent && form.roleDecision && (
          <div className="field-hint">仅勾选 JEV 时，此配置只用于决策评审，不会出现在 Agent 主模型默认候选中。</div>
        )}
        {!form.toolsEnabled && form.roleAgent && (
          <div className="field-hint" style={{ color: '#ffc76b' }}>
            关闭工具后，Agent 只能进行纯文本对话，无法读取 Schema 或执行数据库任务。
          </div>
        )}
      </div>

      <Field label="备注">
        <Textarea value={form.notes} onChange={(value) => update('notes', value)} rows={3} placeholder="例如：用途、限流说明、代理配置" />
      </Field>

      {formFieldError && <div className="field-error">{formFieldError}</div>}
      {formError !== null && <ErrorLine error={formError} title="保存失败" />}
    </div>
  )

  return (
    <div className="page">
      <PageHeader
        title="模型设置"
        sub="自动检测可用模型并填写；配置写入本地 models-config.json，关闭应用不会丢失"
        actions={
          <>
            <RefreshButton onClick={list.reload} loading={list.loading} />
            <Button variant="primary" onClick={() => openCreate('deepseek')} icon={<Plus size={13} />}>
              新建外部 API
            </Button>
          </>
        }
      />
      <div className="page-body">
        <div className="intel-banner info mb-2">
          <ShieldCheck size={15} className="intel-banner-icon" />
          <div>
            走外部 API 链接：保存后会同步到持久配置文件。API Key 只进系统密钥库，不进 JSON；模型不能直接执行 SQL / shell。
          </div>
        </div>

        {configPath && (
          <div className="callout info mb-3">
            <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
              <FolderOpen size={15} style={{ marginTop: 2, flexShrink: 0 }} />
              <div className="grow">
                <div className="strong mb-1">持久配置文件</div>
                <div className="mono xs pre-wrap">{configPath}</div>
                <div className="field-hint mt-1">
                  每次保存 / 删除 / 设默认都会更新此文件；下次启动若数据库为空会自动从该文件恢复配置（API Key 需重新填写）。
                </div>
              </div>
            </div>
          </div>
        )}

        {(defaultModel || defaultDecision) && (
          <div className="col mb-2" style={{ gap: 6 }}>
            {defaultModel && (
              <div className="row wrap">
                <span className="badge accent">
                  <Star size={10} /> 默认 Agent
                </span>
                <span className="small">
                  {defaultModel.name} · {KIND_LABEL[defaultModel.kind]} · <span className="mono">{defaultModel.model}</span>
                </span>
              </div>
            )}
            {defaultDecision && (
              <div className="row wrap">
                <span className="badge purple">
                  <ShieldCheck size={10} /> 默认 JEV
                </span>
                <span className="small">
                  {defaultDecision.name} · {KIND_LABEL[defaultDecision.kind]} ·{' '}
                  <span className="mono">{defaultDecision.model}</span>
                </span>
              </div>
            )}
          </div>
        )}

        {testError !== null && <ErrorLine error={testError} title="模型测试请求失败" />}

        {list.error !== null && <ErrorLine error={list.error} title="模型配置加载失败" />}
        {list.loading && models.length === 0 ? (
          <LoadingBlock label="加载模型配置…" />
        ) : models.length === 0 ? (
          <EmptyState
            icon={<Cpu size={24} />}
            title="还没有模型配置"
            body="添加 OpenAI 兼容 API 或本地 Ollama 配置后，即可在 AI Agent 中选择模型。配置可随时测试连通性与工具支持情况。"
            action={
              <Button variant="primary" onClick={() => openCreate('deepseek')}>
                <Plus size={13} /> 新建外部 API
              </Button>
            }
          />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {models.map((profile) => {
              const roles = profile.roles?.length ? profile.roles : (['agent'] as Array<'agent' | 'decision'>)
              const isDefaultJev = defaultDecisionId === profile.id
              return (
              <div className="intel-row-card" key={profile.id}>
                <div className="intel-row-head">
                  <Cpu size={14} />
                  <span className="intel-row-title">{profile.name}</span>
                  {profile.isDefault && (
                    <span className="badge accent">
                      <Star size={10} /> 默认 Agent
                    </span>
                  )}
                  {isDefaultJev && (
                    <span className="badge purple">
                      <ShieldCheck size={10} /> 默认 JEV
                    </span>
                  )}
                  {roles.includes('agent') && <span className="badge neutral">Agent</span>}
                  {roles.includes('decision') && <span className="badge purple">JEV</span>}
                  <span className="badge neutral">{KIND_LABEL[profile.kind]}</span>
                  <span className={profile.apiKeyStored ? 'badge ok' : 'badge neutral'}>
                    <KeyRound size={10} /> {profile.apiKeyStored ? '密钥已存储' : '无密钥'}
                  </span>
                  {profile.lastTestOk === true && <span className="badge ok">最近测试通过</span>}
                  {profile.lastTestOk === false && <span className="badge danger">最近测试失败</span>}
                  {profile.toolsEnabled ? <span className="badge purple">工具已启用</span> : <span className="badge warn">工具已关闭</span>}
                  <div className="spacer" />
                  <div className="intel-row-actions">
                    <Button size="sm" loading={testBusyId === profile.id} disabled={testBusyId !== null} onClick={() => void runTest(profile)}>
                      <Zap size={12} /> 测试
                    </Button>
                    {!profile.isDefault && roles.includes('agent') && (
                      <Button size="sm" loading={defaultBusyId === profile.id} onClick={() => void setDefault(profile)}>
                        <Star size={12} /> 设为默认 Agent
                      </Button>
                    )}
                    {!isDefaultJev && (
                      <Button size="sm" loading={decisionBusyId === profile.id} onClick={() => void setDefaultDecision(profile)}>
                        <ShieldCheck size={12} /> 设为默认 JEV
                      </Button>
                    )}
                    <Button
                      size="sm"
                      loading={duplicateBusyId === profile.id}
                      disabled={duplicateBusyId !== null}
                      onClick={() => void openDuplicate(profile)}
                      title="一键复制配置并复用已存 API Key"
                    >
                      <Copy size={12} /> 复制
                    </Button>
                    <Button size="sm" onClick={() => openEdit(profile)}>
                      <Pencil size={12} /> 编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setDeleteTarget(profile)
                        setDeleteError(null)
                      }}
                    >
                      <Trash2 size={12} /> 删除
                    </Button>
                  </div>
                </div>
                <div className="mt-2">
                  <MetaGrid
                    items={[
                      { k: 'Base URL', v: <span className="mono xs">{profile.baseUrl}</span> },
                      { k: '模型', v: <span className="mono">{profile.model}</span> },
                      { k: 'temperature / maxTokens', v: `${profile.temperature} / ${profile.maxTokens}` },
                      { k: '超时', v: formatDuration(profile.timeoutMs) },
                      { k: '最近测试', v: profile.lastTestAt ? formatRelative(profile.lastTestAt) : '从未测试' },
                      { k: '更新时间', v: formatDate(profile.updatedAt) }
                    ]}
                  />
                  {profile.notes && <div className="small muted mt-1">{profile.notes}</div>}
                </div>
              </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------- form modal */}
      <Modal
        open={formOpen}
        title={
          form.id ? '编辑模型配置' : form.copyApiKeyFromId ? '复制为新模型配置' : '新建模型配置'
        }
        wide
        closeOnEscape={false}
        onClose={() => !saving && setFormOpen(false)}
        footer={
          <>
            <Button variant="ghost" disabled={saving} onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void submit()}>
              {form.copyApiKeyFromId ? '创建副本' : '保存配置'}
            </Button>
          </>
        }
      >
        {renderForm()}
      </Modal>

      {/* ------------------------------------------------- test result modal */}
      <Modal
        open={testResult !== null}
        title="模型测试结果"
        wide
        onClose={() => setTestResult(null)}
        footer={
          <Button variant="ghost" onClick={() => setTestResult(null)}>
            关闭
          </Button>
        }
      >
        {testResult && (
          <div className="col" style={{ gap: 10 }}>
            <div className="row wrap">
              {testResult.result.ok ? (
                <span className="badge ok">
                  <CheckCircle2 size={11} /> 连通成功
                </span>
              ) : (
                <span className="badge danger">
                  <XCircle size={11} /> 连通失败
                </span>
              )}
              <span className="small">
                {testResult.profile.name} · {KIND_LABEL[testResult.result.provider]}
              </span>
            </div>
            <MetaGrid
              items={[
                { k: '延迟', v: formatDuration(testResult.result.latencyMs) },
                { k: '模型', v: <span className="mono">{testResult.result.model}</span> },
                { k: '工具支持', v: TOOL_SUPPORT_LABEL[testResult.result.toolSupport] }
              ]}
            />
            {testResult.result.toolSupport === 'unsupported' && testResult.profile.toolsEnabled && (
              <Callout kind="warn" title="该模型可能不支持工具调用">
                Agent 的数据库任务依赖工具调用。若模型不支持工具，请关闭该配置的「允许使用受控工具」或更换支持 function calling 的模型。
              </Callout>
            )}
            {testResult.result.sample && (
              <div>
                <div className="intel-step-label mb-1">示例响应（不可信内容）</div>
                <pre className="intel-code short">{testResult.result.sample}</pre>
              </div>
            )}
            {testResult.result.error && (
              <Callout kind="danger" title="错误">
                {testResult.result.error}
                {testResult.result.hint && <div className="small muted mt-1">提示：{testResult.result.hint}</div>}
              </Callout>
            )}
            {!testResult.result.error && testResult.result.hint && (
              <Callout kind="info" title="提示">
                {testResult.result.hint}
              </Callout>
            )}
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------ delete modal */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除模型配置"
        danger
        confirmLabel="确认删除"
        busy={deleting}
        onConfirm={() => void remove()}
        onCancel={() => !deleting && setDeleteTarget(null)}
      >
        <div>
          确定删除模型配置「<span className="strong">{deleteTarget?.name}</span>」吗？删除后其 API Key 会从密钥库移除。
          {deleteTarget?.isDefault && (
            <div className="mt-2" style={{ color: '#ffc76b' }}>
              这是当前默认模型。删除后需要重新指定默认模型，否则 Agent 可能无法运行。
            </div>
          )}
        </div>
        {deleteError !== null && <ErrorLine error={deleteError} title="删除失败" />}
      </ConfirmDialog>
    </div>
  )
}
