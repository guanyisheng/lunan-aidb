import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Download,
  FolderOpen,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldCheck,
  Upload,
  Wrench
} from 'lucide-react'
import type { AppSettings, AuditEvent, AuditActor, ConfigExportScope, HealthReport } from '@shared/types'
import { call } from '../lib/api'
import { useAppStore } from '../lib/store'
import { formatBytes, formatDate } from '../lib/format'
import {
  Button,
  Callout,
  Card,
  DataTable,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Select,
  RiskBadge
} from '../components/ui'
import type { Column } from '../components/ui'
import { ErrorLine, IdText, MetaGrid, Pager, RefreshButton, SectionTitle, StatCard, useAsync } from '../components/intel/IntelCommon'

/* ------------------------------------------------------------------ */

interface Draft {
  autoProtection: boolean
  requireApprovalForWrites: boolean
  allowSampling: boolean
  maxSampleRows: string
  sqlTimeoutMs: string
  maxResultRows: string
  maxAgentSteps: string
  agentTimeoutMs: string
  backupDir: string
  retentionDays: string
  maxBackupBytes: string
  diskWarnBytes: string
  defaultModelProfileId: string
  theme: AppSettings['theme']
  jevQualityGateEnabled: boolean
  jevMinConfidence: string
}

function draftFrom(settings: AppSettings): Draft {
  return {
    autoProtection: settings.autoProtection,
    requireApprovalForWrites: settings.requireApprovalForWrites,
    allowSampling: settings.allowSampling,
    maxSampleRows: String(settings.maxSampleRows),
    sqlTimeoutMs: String(settings.sqlTimeoutMs),
    maxResultRows: String(settings.maxResultRows),
    maxAgentSteps: String(settings.maxAgentSteps),
    agentTimeoutMs: String(settings.agentTimeoutMs),
    backupDir: settings.backupDir,
    retentionDays: String(settings.retentionDays),
    maxBackupBytes: String(settings.maxBackupBytes),
    diskWarnBytes: String(settings.diskWarnBytes),
    defaultModelProfileId: settings.defaultModelProfileId ?? '',
    theme: settings.theme,
    jevQualityGateEnabled: Boolean(settings.jevQualityGateEnabled),
    jevMinConfidence: String(settings.jevMinConfidence ?? 60)
  }
}

const CONFIG_SCOPE_OPTIONS: { id: ConfigExportScope; label: string; hint: string }[] = [
  { id: 'settings', label: '应用设置', hint: '安全、限额、主题、JEV 门控等' },
  { id: 'models', label: 'AI 模型', hint: '模型配置（不含 API Key）' },
  { id: 'connections', label: '数据库连接', hint: '主机/账号等（不含密码）' },
  { id: 'projects', label: '项目', hint: '项目与数据库简介 MD' }
]

interface NumRule {
  label: string
  min: number
  max: number
  integer?: boolean
}

function parseNum(value: string, rule: NumRule): number | string {
  const trimmed = value.trim()
  if (trimmed === '') return `请填写${rule.label}`
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return `${rule.label}必须是数字`
  if (rule.integer && !Number.isInteger(parsed)) return `${rule.label}必须是整数`
  if (parsed < rule.min || parsed > rule.max) return `${rule.label}必须在 ${rule.min}–${rule.max} 之间`
  return parsed
}

const OUTCOME_LABEL: Record<AuditEvent['outcome'], string> = {
  success: '成功',
  failure: '失败',
  denied: '被拒绝',
  info: '信息'
}

const ACTOR_LABEL: Record<AuditActor, string> = {
  user: '用户',
  agent: 'AI Agent',
  system: '系统'
}

const outcomeClass: Record<AuditEvent['outcome'], string> = {
  success: 'badge ok',
  failure: 'badge danger',
  denied: 'badge warn',
  info: 'badge neutral'
}

/* ------------------------------------------------------------------ */

export function SettingsPage(): ReactNode {
  const projects = useAppStore((s) => s.projects)
  const info = useAppStore((s) => s.info)
  const refreshSettings = useAppStore((s) => s.refreshSettings)
  const refreshHealth = useAppStore((s) => s.refreshHealth)
  const toastOk = useAppStore((s) => s.toastOk)
  const toastError = useAppStore((s) => s.toastError)
  const toastInfo = useCallback((title: string, body?: string) => {
    useAppStore.getState().pushToast({ kind: 'info', title, body })
  }, [])

  /* ----------------------------------------------------------- settings */
  const settingsState = useAsync(async () => call('app.settings.get', undefined), [])
  const modelsState = useAsync(async () => call('model.list', undefined), [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formError, setFormError] = useState<unknown>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [configScopes, setConfigScopes] = useState<ConfigExportScope[]>(['all'])
  const [configBusy, setConfigBusy] = useState<'export' | 'import' | null>(null)

  const toggleConfigScope = useCallback((scope: ConfigExportScope) => {
    setConfigScopes((prev) => {
      if (scope === 'all') return ['all']
      const withoutAll = prev.filter((s) => s !== 'all')
      if (withoutAll.includes(scope)) {
        const next = withoutAll.filter((s) => s !== scope)
        return next.length ? next : ['all']
      }
      const next = [...withoutAll, scope]
      return next.length === 4 ? ['all'] : next
    })
  }, [])

  const exportConfig = useCallback(async () => {
    setConfigBusy('export')
    try {
      const scopes = configScopes.includes('all') ? (['all'] as ConfigExportScope[]) : configScopes
      const result = await call('config.export', { scopes })
      if (result.path) {
        toastOk('配置已导出', result.path)
      } else {
        toastInfo('已取消导出')
      }
    } catch (e) {
      toastError(e)
    } finally {
      setConfigBusy(null)
    }
  }, [configScopes, toastError, toastInfo, toastOk])

  const importConfig = useCallback(async () => {
    setConfigBusy('import')
    try {
      const scopes = configScopes.includes('all') ? undefined : configScopes
      const result = await call('config.import', scopes ? { scopes } : {})
      if (!result.path) {
        toastInfo('已取消导入')
        return
      }
      await refreshSettings()
      settingsState.reload()
      modelsState.reload()
      void useAppStore.getState().refreshProjects()
      void useAppStore.getState().refreshConnections()
      const warn = result.warnings.length ? `；注意：${result.warnings[0]}` : ''
      toastOk(
        '配置已导入',
        `范围：${result.imported.join('、') || '无'}${warn}`
      )
      if (result.warnings.length > 1) {
        toastInfo('导入提示', result.warnings.slice(1).join('\n'))
      }
    } catch (e) {
      toastError(e)
    } finally {
      setConfigBusy(null)
    }
  }, [configScopes, modelsState, refreshSettings, settingsState, toastError, toastInfo, toastOk])

  useEffect(() => {
    if (settingsState.data) setDraft(draftFrom(settingsState.data))
  }, [settingsState.data])

  const update = useCallback(<K extends keyof Draft,>(key: K, value: Draft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
  }, [])

  const reloadSettings = useCallback(() => {
    settingsState.reload()
    setFieldErrors({})
    setFormError(null)
  }, [settingsState])

  /* ------------------------------------------------------------- health */
  const [healthTick, setHealthTick] = useState(0)
  const healthState = useAsync(async () => call('app.health', undefined), [healthTick])
  const pathsState = useAsync(async () => call('app.paths', undefined), [healthTick])
  const health: HealthReport | null = healthState.data

  const reloadHealth = useCallback(() => {
    setHealthTick((value) => value + 1)
    void refreshHealth()
  }, [refreshHealth])

  /* -------------------------------------------------------------- audit */
  const [auditActor, setAuditActor] = useState<string>('')
  const [auditOutcome, setAuditOutcome] = useState<string>('')
  const [auditProjectId, setAuditProjectId] = useState<string>('')
  const [auditOffset, setAuditOffset] = useState(0)
  const auditLimit = 50
  const [auditTick, setAuditTick] = useState(0)
  const [exporting, setExporting] = useState<'json' | 'csv' | null>(null)

  const auditState = useAsync(
    async () =>
      call('audit.list', {
        ...(auditActor ? { actor: auditActor as AuditActor } : {}),
        ...(auditOutcome ? { outcome: auditOutcome as AuditEvent['outcome'] } : {}),
        ...(auditProjectId ? { projectId: auditProjectId } : {}),
        limit: auditLimit,
        offset: auditOffset
      }),
    [auditActor, auditOutcome, auditProjectId, auditOffset, auditTick]
  )

  useEffect(() => {
    setAuditOffset(0)
  }, [auditActor, auditOutcome, auditProjectId])

  const exportAudit = useCallback(
    async (format: 'json' | 'csv') => {
      setExporting(format)
      try {
        const result = await call('audit.export', {
          ...(auditProjectId ? { projectId: auditProjectId } : {}),
          format
        })
        if (result.path) {
          toastOk('审计日志已导出', `${format.toUpperCase()} · ${result.count} 条 · ${result.path}`)
          await call('app.showItemInFolder', { path: result.path }).catch(() => undefined)
        } else {
          toastInfo('已取消导出', '未选择保存位置')
        }
      } catch (e) {
        toastError(e)
      } finally {
        setExporting(null)
      }
    },
    [auditProjectId, toastError, toastInfo, toastOk]
  )

  const auditRows = auditState.data?.items ?? []
  const auditColumns = useMemo<Column<AuditEvent>[]>(
    () => [
      {
        key: 'ts',
        title: '时间',
        width: '150px',
        render: (row) => <span className="small mono">{formatDate(row.ts)}</span>
      },
      {
        key: 'actor',
        title: 'Actor',
        width: '90px',
        render: (row) => <span className={row.actor === 'agent' ? 'badge purple' : row.actor === 'system' ? 'badge neutral' : 'badge accent'}>{ACTOR_LABEL[row.actor] ?? row.actor}</span>
      },
      {
        key: 'action',
        title: 'Action',
        width: '160px',
        render: (row) => <span className="mono xs">{row.action}</span>
      },
      {
        key: 'outcome',
        title: '结果',
        width: '90px',
        render: (row) => <span className={outcomeClass[row.outcome]}>{OUTCOME_LABEL[row.outcome] ?? row.outcome}</span>
      },
      {
        key: 'risk',
        title: '风险',
        width: '80px',
        render: (row) => (row.risk ? <RiskBadge risk={row.risk} /> : <span className="muted small">—</span>)
      },
      {
        key: 'sql',
        title: 'SQL 摘要 / 目标 / 错误',
        render: (row) => (
          <div style={{ minWidth: 0 }}>
            {row.target && <div className="mono xs">{row.target}</div>}
            {row.sqlPreview && (
              <div className="mono xs muted intel-truncate" style={{ maxWidth: 460 }} title={row.sqlPreview}>
                {row.sqlPreview}
              </div>
            )}
            {row.detail && <div className="xs muted intel-truncate" style={{ maxWidth: 460 }} title={row.detail}>{row.detail}</div>}
          </div>
        )
      },
      {
        key: 'id',
        title: 'ID',
        width: '140px',
        render: (row) => <IdText value={row.id} />
      }
    ],
    []
  )

  /* -------------------------------------------------------------- save */
  const saveSettings = useCallback(async () => {
    if (!draft) return
    setFormError(null)
    setFieldErrors({})
    const errors: Record<string, string> = {}
    const maxSampleRows = parseNum(draft.maxSampleRows, { label: '最大抽样行数', min: 0, max: 100, integer: true })
    if (typeof maxSampleRows === 'string') errors.maxSampleRows = maxSampleRows
    const sqlTimeoutMs = parseNum(draft.sqlTimeoutMs, { label: 'SQL 超时', min: 1000, max: 600_000, integer: true })
    if (typeof sqlTimeoutMs === 'string') errors.sqlTimeoutMs = sqlTimeoutMs
    const maxResultRows = parseNum(draft.maxResultRows, { label: '最大结果行数', min: 1, max: 100_000, integer: true })
    if (typeof maxResultRows === 'string') errors.maxResultRows = maxResultRows
    const maxAgentSteps = parseNum(draft.maxAgentSteps, { label: '最大 Agent 步数', min: 1, max: 50, integer: true })
    if (typeof maxAgentSteps === 'string') errors.maxAgentSteps = maxAgentSteps
    const agentTimeoutMs = parseNum(draft.agentTimeoutMs, { label: 'Agent 超时', min: 5000, max: 1_800_000, integer: true })
    if (typeof agentTimeoutMs === 'string') errors.agentTimeoutMs = agentTimeoutMs
    const retentionDays = parseNum(draft.retentionDays, { label: '保留期限', min: 0, max: 3650, integer: true })
    if (typeof retentionDays === 'string') errors.retentionDays = retentionDays
    const maxBackupBytes = parseNum(draft.maxBackupBytes, { label: '备份容量上限', min: 0, max: 10 * 1024 ** 4, integer: true })
    if (typeof maxBackupBytes === 'string') errors.maxBackupBytes = maxBackupBytes
    const diskWarnBytes = parseNum(draft.diskWarnBytes, { label: '磁盘预警阈值', min: 0, max: 10 * 1024 ** 4, integer: true })
    if (typeof diskWarnBytes === 'string') errors.diskWarnBytes = diskWarnBytes
    const jevMinConfidence = parseNum(draft.jevMinConfidence, {
      label: 'JEV 最低置信度',
      min: 0,
      max: 100,
      integer: true
    })
    if (typeof jevMinConfidence === 'string') errors.jevMinConfidence = jevMinConfidence
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      setFormError(new Error('请修正表单中的错误后再保存'))
      return
    }

    const patch: Partial<AppSettings> = {
      autoProtection: draft.autoProtection,
      requireApprovalForWrites: draft.requireApprovalForWrites,
      allowSampling: draft.allowSampling,
      maxSampleRows: maxSampleRows as number,
      sqlTimeoutMs: sqlTimeoutMs as number,
      maxResultRows: maxResultRows as number,
      maxAgentSteps: maxAgentSteps as number,
      agentTimeoutMs: agentTimeoutMs as number,
      backupDir: draft.backupDir.trim(),
      retentionDays: retentionDays as number,
      maxBackupBytes: maxBackupBytes as number,
      diskWarnBytes: diskWarnBytes as number,
      defaultModelProfileId: draft.defaultModelProfileId || null,
      theme: draft.theme,
      jevQualityGateEnabled: draft.jevQualityGateEnabled,
      jevMinConfidence: jevMinConfidence as number
    }

    setSaving(true)
    try {
      const saved = await call('app.settings.update', { patch })
      setDraft(draftFrom(saved))
      await refreshSettings()
      reloadHealth()
      toastOk('设置已保存', '主进程已应用新的安全设置')
    } catch (e) {
      setFormError(e)
      toastError(e)
    } finally {
      setSaving(false)
    }
  }, [draft, refreshSettings, reloadHealth, toastError, toastOk])

  const chooseBackupDir = useCallback(async () => {
    try {
      const result = await call('app.dialog.chooseDirectory', {
        title: '选择备份目录',
        defaultPath: draft?.backupDir || pathsState.data?.backups
      })
      if (result.dir && draft) {
        update('backupDir', result.dir)
      }
    } catch (e) {
      toastError(e)
    }
  }, [draft, pathsState.data, toastError, update])

  const showInFolder = useCallback(
    (path: string | null | undefined) => {
      if (!path) return
      void call('app.showItemInFolder', { path }).catch((e: unknown) => toastError(e))
    },
    [toastError]
  )

  /* ------------------------------------------------------------ render */
  return (
    <div className="page">
      <PageHeader
        title="安全设置"
        sub="SQL 策略、写入审批、自动保护、备份与审计——清晰可信的安全控制中心"
        actions={
          <>
            <RefreshButton onClick={reloadSettings} loading={settingsState.loading} label="重载设置" />
            <Button variant="primary" loading={saving} disabled={!draft || saving} onClick={() => void saveSettings()}>
              <ShieldCheck size={13} /> 保存设置
            </Button>
          </>
        }
      />
      <div className="page-body">
        {settingsState.error !== null && <ErrorLine error={settingsState.error} title="设置加载失败" />}
        {settingsState.loading && !draft ? (
          <LoadingBlock label="加载安全设置…" />
        ) : draft ? (
          <>
            {/* ------------------------------------------------ 安全设置 */}
            <SectionTitle icon={<Settings2 size={14} />}>安全与保护</SectionTitle>
            <div className="grid-2 mb-2">
              <Card title="自动保护" sub="高风险写操作执行前自动创建恢复点/备份">
                <label className="intel-checkline" style={{ display: 'flex' }}>
                  <input
                    type="checkbox"
                    checked={draft.autoProtection}
                    onChange={(e) => update('autoProtection', e.target.checked)}
                    style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                  />
                  <span>
                    启用自动保护
                    <div className="hint">
                      默认开启。高风险操作如果恢复点/备份失败，主进程会阻止执行，不会静默跳过保护步骤。
                    </div>
                  </span>
                </label>
                {!draft.autoProtection && (
                  <div className="intel-danger-zone mt-2">
                    <div className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
                      <AlertTriangle size={15} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
                      <div>
                        <div className="strong" style={{ color: '#ff9d9d' }}>
                          风险警告：自动保护已关闭
                        </div>
                        <div className="small" style={{ color: '#ffb3b3' }}>
                          关闭后，数据库写操作的自动恢复点/备份保护能力下降。高风险操作仍会要求已通过验证的备份，
                          但普通变更将不再自动留出可撤销的前镜像。请确认你清楚后果。
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Card>

              <Card title="写入审批" sub="任何 DML/DDL/恢复操作是否需要人工批准">
                <label className="intel-checkline" style={{ display: 'flex' }}>
                  <input
                    type="checkbox"
                    checked={draft.requireApprovalForWrites}
                    onChange={(e) => update('requireApprovalForWrites', e.target.checked)}
                    style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                  />
                  <span>
                    写入操作必须人工批准
                    <div className="hint">
                      开启时，模型生成的 SQL 必须经过用户明确批准；关闭后仍需遵守主进程的风险策略，高风险操作不会被静默执行。
                    </div>
                  </span>
                </label>
                {!draft.requireApprovalForWrites && (
                  <Callout kind="warn" title="关闭审批会降低安全性">
                    即使关闭该开关，主进程仍会对高风险 SQL 强制要求审批。建议保持开启。
                  </Callout>
                )}
              </Card>
            </div>

            <Card title="数据读取限制" sub="禁止默认读取整表业务数据" className="mb-2">
              <div className="grid-2">
                <div>
                  <label className="intel-checkline" style={{ display: 'flex' }}>
                    <input
                      type="checkbox"
                      checked={draft.allowSampling}
                      onChange={(e) => update('allowSampling', e.target.checked)}
                      style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                    />
                    <span>
                      允许受控抽样读取
                      <div className="hint">
                        Schema 扫描优先使用数据库元数据；抽样仅在权限、数据量和敏感字段检查通过后读取极少量行，绝不默认读取整表业务数据。
                      </div>
                    </span>
                  </label>
                  {draft.allowSampling && (
                    <div className="field-hint mt-1" style={{ color: '#ffc76b' }}>
                      抽样可能包含敏感业务数据，请确认合规要求后再开启。
                    </div>
                  )}
                </div>
                <Field label="最大抽样行数" hint="0–100 行" error={fieldErrors.maxSampleRows}>
                  <Input value={draft.maxSampleRows} onChange={(value) => update('maxSampleRows', value)} type="number" />
                </Field>
              </div>
            </Card>

            <Card title="SQL 与 Agent 限额" className="mb-2">
              <div className="grid-3">
                <Field label="SQL 超时（毫秒）" hint="1000–600000" error={fieldErrors.sqlTimeoutMs}>
                  <Input value={draft.sqlTimeoutMs} onChange={(value) => update('sqlTimeoutMs', value)} type="number" />
                </Field>
                <Field label="最大结果行数" hint="1–100000" error={fieldErrors.maxResultRows}>
                  <Input value={draft.maxResultRows} onChange={(value) => update('maxResultRows', value)} type="number" />
                </Field>
                <Field label="最大 Agent 步数" hint="1–50" error={fieldErrors.maxAgentSteps}>
                  <Input value={draft.maxAgentSteps} onChange={(value) => update('maxAgentSteps', value)} type="number" />
                </Field>
                <Field label="Agent 超时（毫秒）" hint="5000–1800000" error={fieldErrors.agentTimeoutMs}>
                  <Input value={draft.agentTimeoutMs} onChange={(value) => update('agentTimeoutMs', value)} type="number" />
                </Field>
                <Field label="默认模型配置" hint="Agent 启动时使用，可在 Agent 页面覆盖">
                  <Select
                    value={draft.defaultModelProfileId}
                    onChange={(value) => update('defaultModelProfileId', value)}
                    options={[
                      { value: '', label: '未指定（由 Agent 选择）' },
                      ...(modelsState.data ?? []).map((model) => ({
                        value: model.id,
                        label: `${model.name}${model.isDefault ? '（默认）' : ''}`
                      }))
                    ]}
                  />
                </Field>
                <Field label="主题偏好" hint="保存到设置；界面主题切换取决于样式支持">
                  <Select
                    value={draft.theme}
                    onChange={(value) => update('theme', value)}
                    options={[
                      { value: 'dark', label: '深色' },
                      { value: 'light', label: '浅色' },
                      { value: 'system', label: '跟随系统' }
                    ]}
                  />
                </Field>
              </div>
              <div className="field-hint">
                当前版本的默认模型由「模型设置」页维护；此处保存的默认模型 ID 与 Agent 运行时选择保持一致即可。
              </div>
              {modelsState.error !== null && (
                <div className="field-error">模型配置加载失败：{String((modelsState.error as Error)?.message ?? modelsState.error)}</div>
              )}
            </Card>

            <Card title="JEV 决策质量门控" sub="开启后，最终结论置信度低于阈值会要求主模型重写一次" className="mb-2">
              <div className="grid-2">
                <label className="intel-checkline" style={{ display: 'flex' }}>
                  <input
                    type="checkbox"
                    checked={draft.jevQualityGateEnabled}
                    onChange={(e) => update('jevQualityGateEnabled', e.target.checked)}
                    style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                  />
                  <span>
                    启用 JEV 置信度门控
                    <div className="hint">
                      需要已配置决策（JEV）模型。低于阈值时自动要求主模型重新生成结论，再评审一次。
                    </div>
                  </span>
                </label>
                <Field
                  label="最低置信度（%）"
                  hint="0–100，例如 60 表示低于 60% 则重生成"
                  error={fieldErrors.jevMinConfidence}
                >
                  <Input
                    value={draft.jevMinConfidence}
                    onChange={(value) => update('jevMinConfidence', value)}
                    type="number"
                    disabled={!draft.jevQualityGateEnabled}
                  />
                </Field>
              </div>
            </Card>

            <Card title="配置导入 / 导出" sub="可导出设置、AI 模型、数据库连接、项目（单项或全部）；密钥与密码不会写入文件" className="mb-2">
              <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
                <label className="intel-checkline" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={configScopes.includes('all')}
                    onChange={() => toggleConfigScope('all')}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span className="strong">全部</span>
                </label>
                {CONFIG_SCOPE_OPTIONS.map((opt) => (
                  <label
                    key={opt.id}
                    className="intel-checkline"
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    title={opt.hint}
                  >
                    <input
                      type="checkbox"
                      checked={configScopes.includes('all') || configScopes.includes(opt.id)}
                      disabled={configScopes.includes('all')}
                      onChange={() => toggleConfigScope(opt.id)}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              <div className="hint mb-2">导出不含数据库密码与模型 API Key；导入后请在对应页面重新填写。</div>
              <div className="row" style={{ gap: 8 }}>
                <Button
                  variant="primary"
                  loading={configBusy === 'export'}
                  disabled={Boolean(configBusy)}
                  onClick={() => void exportConfig()}
                >
                  <Download size={13} /> 导出配置
                </Button>
                <Button
                  loading={configBusy === 'import'}
                  disabled={Boolean(configBusy)}
                  onClick={() => void importConfig()}
                >
                  <Upload size={13} /> 导入配置
                </Button>
              </div>
            </Card>

            <Card title="备份与磁盘" className="mb-2">
              <Field label="备份目录" hint="留空使用应用默认备份目录；备份文件与项目数据分离存储">
                <div className="row" style={{ gap: 6 }}>
                  <Input value={draft.backupDir} onChange={(value) => update('backupDir', value)} placeholder="（应用默认目录）" />
                  <Button onClick={() => void chooseBackupDir()}>
                    <FolderOpen size={13} /> 选择目录
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => showInFolder(draft.backupDir || health?.backupDir.path)}
                    disabled={!draft.backupDir && !health?.backupDir.path}
                  >
                    打开
                  </Button>
                </div>
              </Field>
              <div className="grid-3">
                <Field label="保留期限（天）" hint="0–3650；清理前检查恢复点引用" error={fieldErrors.retentionDays}>
                  <Input value={draft.retentionDays} onChange={(value) => update('retentionDays', value)} type="number" />
                </Field>
                <Field label="备份容量上限（字节）" hint="0 表示不限制" error={fieldErrors.maxBackupBytes}>
                  <div>
                    <Input value={draft.maxBackupBytes} onChange={(value) => update('maxBackupBytes', value)} type="number" />
                    <div className="field-hint">{formatBytes(Number(draft.maxBackupBytes) || 0)}</div>
                  </div>
                </Field>
                <Field label="磁盘可用空间预警（字节）" error={fieldErrors.diskWarnBytes}>
                  <div>
                    <Input value={draft.diskWarnBytes} onChange={(value) => update('diskWarnBytes', value)} type="number" />
                    <div className="field-hint">{formatBytes(Number(draft.diskWarnBytes) || 0)}</div>
                  </div>
                </Field>
              </div>
            </Card>

            {formError !== null && <ErrorLine error={formError} title="设置保存失败" />}
            <div className="row" style={{ justifyContent: 'flex-end', paddingBottom: 16 }}>
              <Button variant="ghost" loading={saving} disabled={saving} onClick={reloadSettings}>
                放弃修改
              </Button>
              <Button variant="primary" loading={saving} disabled={saving} onClick={() => void saveSettings()}>
                <ShieldCheck size={13} /> 保存设置
              </Button>
            </div>

            <div className="divider" />

            {/* ------------------------------------------------ 健康状态 */}
            <div className="row between mb-2">
              <SectionTitle icon={<Wrench size={14} />}>系统健康</SectionTitle>
              <RefreshButton onClick={reloadHealth} loading={healthState.loading} />
            </div>
            {healthState.error !== null && <ErrorLine error={healthState.error} title="健康检查失败" />}
            {healthState.loading && !health ? (
              <LoadingBlock label="检查系统健康…" />
            ) : health ? (
              <>
                <div className="intel-grid-stat mb-2">
                  <StatCard
                    label="应用数据库"
                    value={health.appDb.ok ? '正常' : '异常'}
                    tone={health.appDb.ok ? 'ok' : 'danger'}
                    hint={`迁移版本 ${health.appDb.migrations}`}
                  />
                  <StatCard
                    label="记忆数据库"
                    value={health.memoryDb.ok ? '正常' : '异常'}
                    tone={health.memoryDb.ok ? 'ok' : 'danger'}
                    hint="与事务性 SQLite 同库"
                  />
                  <StatCard
                    label="备份目录"
                    value={health.backupDir.writable ? '可写' : '不可写'}
                    tone={health.backupDir.writable ? 'ok' : 'danger'}
                    hint={`剩余 ${formatBytes(health.backupDir.freeBytes)}`}
                  />
                  <StatCard
                    label="mysqldump"
                    value={health.toolSupport.mysqldump ? '可用' : '不可用'}
                    tone={health.toolSupport.mysqldump ? 'ok' : 'warn'}
                    hint={health.toolSupport.mysqldumpVersion ?? '外部工具缺失时使用内置备份引擎'}
                  />
                  <StatCard
                    label="系统密钥库"
                    value={health.secrets?.available ? '可用' : '不可用'}
                    tone={health.secrets?.available ? 'ok' : 'danger'}
                    hint={
                      health.secrets?.backend === 'safeStorage'
                        ? 'safeStorage（Keychain / DPAPI）'
                        : health.secrets?.backend === 'memory'
                          ? '内存回退（不持久）'
                          : '未知后端'
                    }
                  />
                </div>

                {!health.appDb.ok && (
                  <Callout kind="danger" title="应用数据库异常">
                    {health.appDb.error ?? '无法读取应用数据库，设置与历史可能不可用。'}
                  </Callout>
                )}
                {health.secrets && !health.secrets.available && (
                  <Callout kind="danger" title="系统密钥库不可用">
                    无法安全保存数据库密码与 API Key。请检查 macOS 钥匙串 / Windows 凭据管理器后重启应用。
                  </Callout>
                )}

                <div className="grid-2">
                  <Card title="路径" sub="数据存储位置">
                    <MetaGrid
                      items={[
                        {
                          k: '应用数据库',
                          v: (
                            <span className="row wrap" style={{ gap: 4 }}>
                              <span className="mono xs">{health.appDb.path}</span>
                              <button type="button" className="btn ghost sm" title="打开所在文件夹" onClick={() => showInFolder(health.appDb.path)}>
                                <FolderOpen size={11} />
                              </button>
                            </span>
                          )
                        },
                        {
                          k: '备份目录',
                          v: (
                            <span className="row wrap" style={{ gap: 4 }}>
                              <span className="mono xs">{health.backupDir.path}</span>
                              <button type="button" className="btn ghost sm" title="打开所在文件夹" onClick={() => showInFolder(health.backupDir.path)}>
                                <FolderOpen size={11} />
                              </button>
                            </span>
                          )
                        },
                        { k: '用户数据目录', v: <span className="mono xs">{info?.userDataPath ?? pathsState.data?.userData ?? '—'}</span> },
                        { k: '日志目录', v: <span className="mono xs">{pathsState.data?.logs ?? '—'}</span> },
                        { k: '恢复点目录', v: <span className="mono xs">{pathsState.data?.recoveryPoints ?? '—'}</span> },
                        { k: '临时目录', v: <span className="mono xs">{pathsState.data?.temp ?? '—'}</span> }
                      ]}
                    />
                  </Card>

                  <Card title="平台信息" sub="应用与运行时版本">
                    <MetaGrid
                      items={[
                        { k: '应用', v: `${info?.name ?? 'Lunan AIDB'} v${info?.version ?? '—'}` },
                        { k: 'Electron', v: info?.electron ?? '—' },
                        { k: 'Node', v: info?.node ?? '—' },
                        { k: 'Chrome', v: info?.chrome ?? '—' },
                        { k: '平台 / 架构', v: `${info?.platform ?? '—'} / ${info?.arch ?? '—'}` },
                        { k: '许可证', v: info?.license ?? 'AGPL-3.0-only' }
                      ]}
                    />
                  </Card>
                </div>
                {!health.backupDir.writable && (
                  <Callout kind="danger" title="备份目录不可写">
                    高风险操作将无法创建经过验证的备份，主进程会因此拒绝执行。请修改备份目录或修复权限。
                  </Callout>
                )}
              </>
            ) : null}

            <div className="divider" />

            {/* ------------------------------------------------ 审计日志 */}
            <div className="row between mb-2">
              <SectionTitle icon={<ScrollText size={14} />}>审计日志</SectionTitle>
              <div className="row" style={{ gap: 6 }}>
                <Button loading={exporting === 'json'} disabled={exporting !== null} onClick={() => void exportAudit('json')}>
                  <Download size={13} /> 导出 JSON
                </Button>
                <Button loading={exporting === 'csv'} disabled={exporting !== null} onClick={() => void exportAudit('csv')}>
                  <Download size={13} /> 导出 CSV
                </Button>
                <RefreshButton onClick={() => setAuditTick((value) => value + 1)} loading={auditState.loading} />
              </div>
            </div>
            <div className="intel-toolbar">
              <Field label="Actor">
                <Select
                  value={auditActor}
                  onChange={setAuditActor}
                  options={[
                    { value: '', label: '全部' },
                    { value: 'user', label: '用户' },
                    { value: 'agent', label: 'AI Agent' },
                    { value: 'system', label: '系统' }
                  ]}
                />
              </Field>
              <Field label="结果">
                <Select
                  value={auditOutcome}
                  onChange={setAuditOutcome}
                  options={[
                    { value: '', label: '全部' },
                    { value: 'success', label: '成功' },
                    { value: 'failure', label: '失败' },
                    { value: 'denied', label: '被拒绝' },
                    { value: 'info', label: '信息' }
                  ]}
                />
              </Field>
              <Field label="项目">
                <Select
                  value={auditProjectId}
                  onChange={setAuditProjectId}
                  options={[
                    { value: '', label: '全部项目' },
                    ...projects.map((project) => ({ value: project.id, label: project.name }))
                  ]}
                />
              </Field>
            </div>

            {auditState.error !== null && <ErrorLine error={auditState.error} title="审计日志加载失败" />}
            {auditState.loading && auditRows.length === 0 ? (
              <LoadingBlock label="加载审计日志…" />
            ) : (
              <>
                <DataTable
                  columns={auditColumns}
                  rows={auditRows}
                  rowKey={(row) => row.id}
                  empty={<div className="intel-empty-hint">没有符合条件的审计记录。</div>}
                />
                <Pager
                  total={auditState.data?.total ?? 0}
                  offset={auditOffset}
                  limit={auditLimit}
                  loading={auditState.loading}
                  onChange={(offset) => setAuditOffset(offset)}
                />
              </>
            )}
            <div className="small muted" style={{ paddingBottom: 20 }}>
              审计日志记录重要数据库变更、恢复、备份、模型与审批操作。失败记录会如实标注为失败/被拒绝，不会隐藏。
            </div>

            {settingsState.data && (
              <div className="small muted" style={{ paddingBottom: 20 }}>
                当前设置版本来自主进程 app.settings.get；最近一次成功保存会立即应用到后续 SQL/Agent/备份流程。
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
