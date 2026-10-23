import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  Clock4,
  Database,
  DatabaseZap,
  FolderOpen,
  HardDrive,
  History,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff
} from 'lucide-react'
import { AiStar } from '../components/AiStar'
import type {
  ConnectionInput,
  ConnectionState,
  ConnectionStatus,
  ConnectionSummary,
  ConnectionTestResult,
  HealthReport,
  Project,
  ProjectStats
} from '@shared/types'
import { ApiError, call, onEvent } from '../lib/api'
import { errorMessage, useAppStore } from '../lib/store'
import { formatBytes, formatDate, formatRelative } from '../lib/format'
import {
  Badge,
  Button,
  Callout,
  Card,
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
import { ConnectionDialog } from '../components/workspace/ConnectionDialog'
import '../components/workspace/workspace.css'

const stateLabel: Record<ConnectionState, string> = {
  disconnected: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  error: '连接异常'
}

const stateBadgeClass: Record<ConnectionState, string> = {
  disconnected: 'badge neutral',
  connecting: 'badge accent',
  connected: 'badge ok',
  error: 'badge danger'
}

interface ProjectStatsState {
  loading?: boolean
  data?: ProjectStats
  error?: string
}

interface TestState {
  ok?: boolean
  loading?: boolean
  result?: ConnectionTestResult
  error?: string
}

/** Convert an ApiError (or anything thrown) into a human readable detail line. */
function apiDetail(e: unknown): string {
  if (e instanceof ApiError) {
    return e.hint ? `${e.code}：${e.message}（${e.hint}）` : `${e.code}：${e.message}`
  }
  return errorMessage(e)
}

function connectionTestInput(connection: ConnectionSummary): ConnectionInput {
  // Password intentionally omitted: the trusted layer reuses the stored secret.
  return {
    name: connection.name,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    database: connection.database || undefined,
    ssl: connection.ssl,
    charset: connection.charset
  }
}

export function HomePage(): ReactNode {
  const projects = useAppStore((s) => s.projects)
  const connections = useAppStore((s) => s.connections)
  const settings = useAppStore((s) => s.settings)
  const info = useAppStore((s) => s.info)
  const refreshProjects = useAppStore((s) => s.refreshProjects)
  const refreshConnections = useAppStore((s) => s.refreshConnections)
  const openProject = useAppStore((s) => s.openProject)
  const navigate = useAppStore((s) => s.navigate)
  const setAgentDraft = useAppStore((s) => s.setAgentDraft)
  const currentProject = useAppStore((s) => s.currentProject)
  const toastError = useAppStore((s) => s.toastError)
  const toastOk = useAppStore((s) => s.toastOk)
  const pushToast = useAppStore((s) => s.pushToast)

  const [homePrompt, setHomePrompt] = useState('')

  const goAgentWith = (prompt: string): void => {
    const trimmed = prompt.trim()
    if (trimmed) setAgentDraft(trimmed)
    navigate('agent')
  }

  const QUICK_TASKS = [
    { label: '分析数据库', prompt: '请分析当前数据库的主要表结构、核心业务实体与表之间的关系。' },
    { label: '查询业务数据', prompt: '帮我查询最近的业务数据，并解释结果含义。' },
    { label: '检查慢查询', prompt: '检查可能的慢查询风险，并给出可验证的 SQL 与优化建议。' },
    { label: '查看最近变更', prompt: '汇总最近的数据库变更与操作历史，标出高风险项。' },
    { label: '检查数据库安全', prompt: '检查当前连接与安全设置相关的风险点，并给出改进建议。' },
    { label: '恢复历史版本', prompt: '列出可用恢复点，并说明如何安全恢复到临时库验证。' }
  ] as const

  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [connectionsLoading, setConnectionsLoading] = useState(false)
  const [connectionsError, setConnectionsError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthError, setHealthError] = useState<string | null>(null)

  const [stats, setStats] = useState<Record<string, ProjectStatsState>>({})
  const statsRequested = useRef<Set<string>>(new Set())
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({})
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [busy, setBusy] = useState<Record<string, string | undefined>>({})
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null)

  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [projectName, setProjectName] = useState('')
  const [projectDescription, setProjectDescription] = useState('')
  const [projectConnectionId, setProjectConnectionId] = useState('')
  const [projectSaving, setProjectSaving] = useState(false)
  const [projectFormError, setProjectFormError] = useState<unknown>(null)
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const [deleteProjectMemories, setDeleteProjectMemories] = useState(false)
  const [deletingProjectBusy, setDeletingProjectBusy] = useState(false)

  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false)
  const [editingConnection, setEditingConnection] = useState<ConnectionSummary | null>(null)
  const [deletingConnection, setDeletingConnection] = useState<ConnectionSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const setBusyFor = (key: string, value: string | undefined): void =>
    setBusy((prev) => ({ ...prev, [key]: value }))

  const loadProjects = useCallback(async (): Promise<void> => {
    setProjectsLoading(true)
    setProjectsError(null)
    try {
      await refreshProjects()
    } catch (e) {
      setProjectsError(apiDetail(e))
    } finally {
      setProjectsLoading(false)
    }
  }, [refreshProjects])

  const loadConnections = useCallback(async (): Promise<void> => {
    setConnectionsLoading(true)
    setConnectionsError(null)
    try {
      await refreshConnections()
    } catch (e) {
      setConnectionsError(apiDetail(e))
    } finally {
      setConnectionsLoading(false)
    }
  }, [refreshConnections])

  const loadHealth = useCallback(async (): Promise<void> => {
    setHealthLoading(true)
    setHealthError(null)
    try {
      setHealth(await call('app.health', undefined))
    } catch (e) {
      setHealth(null)
      setHealthError(apiDetail(e))
    } finally {
      setHealthLoading(false)
    }
  }, [])

  const loadStats = useCallback(async (projectId: string): Promise<void> => {
    setStats((prev) => ({ ...prev, [projectId]: { ...prev[projectId], loading: true, error: undefined } }))
    try {
      const data = await call('project.stats', { id: projectId })
      setStats((prev) => ({ ...prev, [projectId]: { data } }))
    } catch (e) {
      setStats((prev) => ({ ...prev, [projectId]: { error: apiDetail(e) } }))
    }
  }, [])

  useEffect(() => {
    void loadProjects()
    void loadConnections()
    void loadHealth()
  }, [loadProjects, loadConnections, loadHealth])

  // project.stats is lazy: only fetched once per project card, failures are
  // surfaced on the card instead of being swallowed.
  useEffect(() => {
    for (const project of projects) {
      if (statsRequested.current.has(project.id)) continue
      statsRequested.current.add(project.id)
      void loadStats(project.id)
    }
  }, [projects, loadStats])

  // Live connection state from the main process event channel.
  useEffect(() => {
    const off = onEvent('conn.state', (status) => {
      setStatuses((prev) => ({ ...prev, [status.connectionId]: status }))
      setStatusErrors((prev) => {
        const next = { ...prev }
        delete next[status.connectionId]
        return next
      })
    })
    return off
  }, [])

  const refreshStatuses = useCallback(async (list: ConnectionSummary[]): Promise<void> => {
    const results = await Promise.allSettled(
      list.map((connection) => call('conn.status', { id: connection.id }))
    )
    setStatuses((prev) => {
      const next = { ...prev }
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') next[list[index].id] = result.value
      })
      return next
    })
    setStatusErrors((prev) => {
      const next = { ...prev }
      results.forEach((result, index) => {
        if (result.status === 'rejected') next[list[index].id] = apiDetail(result.reason)
        else delete next[list[index].id]
      })
      return next
    })
  }, [])

  useEffect(() => {
    if (connections.length === 0) return
    void refreshStatuses(connections)
  }, [connections, refreshStatuses])

  const reloadAll = (): void => {
    void loadProjects()
    void loadConnections()
    void loadHealth()
  }

  const handleOpenProject = async (project: Project): Promise<void> => {
    setOpeningProjectId(project.id)
    try {
      await openProject(project.id)
      pushToast({ kind: 'ok', title: '项目已打开', body: project.name })
      navigate('workspace')
    } catch (e) {
      toastError(e)
    } finally {
      setOpeningProjectId(null)
    }
  }

  const openCreateProject = (): void => {
    setEditingProject(null)
    setProjectName('')
    setProjectDescription('')
    setProjectConnectionId('')
    setProjectFormError(null)
    setProjectDialogOpen(true)
  }

  const openEditProject = (project: Project): void => {
    setEditingProject(project)
    setProjectName(project.name)
    setProjectDescription(project.description ?? '')
    setProjectConnectionId(project.connectionId ?? '')
    setProjectFormError(null)
    setProjectDialogOpen(true)
  }

  const handleSaveProject = async (): Promise<void> => {
    if (!projectName.trim()) {
      setProjectFormError(new Error('请输入项目名称'))
      return
    }
    setProjectSaving(true)
    setProjectFormError(null)
    try {
      if (editingProject) {
        const updated = await call('project.update', {
          id: editingProject.id,
          patch: {
            name: projectName.trim(),
            description: projectDescription.trim() || undefined,
            connectionId: projectConnectionId || null
          }
        })
        await refreshProjects()
        setProjectDialogOpen(false)
        setEditingProject(null)
        toastOk('项目已更新', updated.name)
      } else {
        const created = await call('project.create', {
          name: projectName.trim(),
          description: projectDescription.trim() || undefined,
          connectionId: projectConnectionId || null
        })
        await refreshProjects()
        setProjectDialogOpen(false)
        setProjectName('')
        setProjectDescription('')
        setProjectConnectionId('')
        toastOk('项目已创建', created.name)
      }
    } catch (e) {
      setProjectFormError(e)
    } finally {
      setProjectSaving(false)
    }
  }

  const handleDeleteProject = async (): Promise<void> => {
    const target = deletingProject
    if (!target) return
    setDeletingProjectBusy(true)
    try {
      await call('project.delete', { id: target.id, deleteMemories: deleteProjectMemories })
      await refreshProjects()
      setDeletingProject(null)
      setDeleteProjectMemories(false)
      toastOk('项目已删除', target.name)
    } catch (e) {
      toastError(e)
    } finally {
      setDeletingProjectBusy(false)
    }
  }

  const handleTestConnection = async (connection: ConnectionSummary): Promise<void> => {
    setBusyFor(`conn:${connection.id}`, 'test')
    setTests((prev) => ({ ...prev, [connection.id]: { loading: true } }))
    try {
      const result = await call('conn.test', { id: connection.id, input: connectionTestInput(connection) })
      setTests((prev) => ({ ...prev, [connection.id]: { result, ok: result.ok } }))
      // Successful probe means the stored password works; clear stale connect errors
      // so the row doesn't show both “连接异常” and “测试连接成功”.
      if (result.ok) {
        setStatusErrors((prev) => {
          const next = { ...prev }
          delete next[connection.id]
          return next
        })
        setStatuses((prev) => {
          const current = prev[connection.id]
          if (current?.state === 'connected') return prev
          return {
            ...prev,
            [connection.id]: {
              connectionId: connection.id,
              state: 'disconnected',
              serverVersion: result.serverVersion,
              serverFlavor: result.serverFlavor,
              latencyMs: result.latencyMs
            }
          }
        })
      }
    } catch (e) {
      setTests((prev) => ({ ...prev, [connection.id]: { error: apiDetail(e) } }))
    } finally {
      setBusyFor(`conn:${connection.id}`, undefined)
    }
  }

  const handleConnect = async (connection: ConnectionSummary): Promise<void> => {
    setBusyFor(`conn:${connection.id}`, 'connect')
    try {
      const status = await call('conn.connect', { id: connection.id })
      setStatuses((prev) => ({ ...prev, [connection.id]: status }))
      await refreshConnections()
      if (status.state === 'connected') {
        pushToast({
          kind: 'ok',
          title: '连接成功',
          body: `${connection.name}${status.serverVersion ? ` · ${status.serverVersion}` : ''}`
        })
      } else {
        pushToast({ kind: 'error', title: '连接失败', body: status.error ?? '未知错误' })
      }
    } catch (e) {
      toastError(e)
      void loadConnections()
    } finally {
      setBusyFor(`conn:${connection.id}`, undefined)
    }
  }

  const handleDisconnect = async (connection: ConnectionSummary): Promise<void> => {
    setBusyFor(`conn:${connection.id}`, 'disconnect')
    try {
      await call('conn.disconnect', { id: connection.id })
      setStatuses((prev) => ({
        ...prev,
        [connection.id]: { connectionId: connection.id, state: 'disconnected' }
      }))
      await refreshConnections()
      pushToast({ kind: 'info', title: '已断开连接', body: connection.name })
    } catch (e) {
      toastError(e)
    } finally {
      setBusyFor(`conn:${connection.id}`, undefined)
    }
  }

  const handleDeleteConnection = async (): Promise<void> => {
    const target = deletingConnection
    if (!target) return
    setDeleting(true)
    try {
      await call('conn.delete', { id: target.id })
      await refreshConnections()
      setDeletingConnection(null)
      toastOk('连接已删除', target.name)
    } catch (e) {
      toastError(e)
    } finally {
      setDeleting(false)
    }
  }

  const diskWarnBytes = settings?.diskWarnBytes ?? 0
  const backupDiskLow = health !== null && diskWarnBytes > 0 && health.backupDir.freeBytes < diskWarnBytes

  const renderProjectCard = (project: Project): ReactNode => {
    const projectStats = stats[project.id]
    const connection = connections.find((c) => c.id === project.connectionId) ?? null
    const memoryCount = projectStats?.data?.memoryCount ?? project.memoryCount
    const historyCount = projectStats?.data?.historyCount ?? project.historyCount
    return (
      <Card key={project.id} className="project-card">
        <div className="project-head">
          <FolderOpen size={16} style={{ color: 'var(--accent)', marginTop: 2 }} />
          <div className="grow">
            <div className="project-name" title={project.name}>
              {project.name}
            </div>
            <div className="xs muted">
              更新于 {formatRelative(project.updatedAt)}
              {project.lastOpenedAt ? ` · 上次打开 ${formatRelative(project.lastOpenedAt)}` : ' · 尚未打开'}
            </div>
          </div>
        </div>
        <div className="project-desc" title={project.description}>
          {project.description || '暂无描述'}
        </div>
        <div className="project-meta">
          <span>
            关联连接：<b>{connection ? connection.name : '未关联'}</b>
          </span>
          <span>
            记忆数：<b>{memoryCount === undefined ? (projectStats?.loading ? '加载中…' : '—') : memoryCount}</b>
          </span>
          <span>
            历史数：<b>{historyCount === undefined ? (projectStats?.loading ? '加载中…' : '—') : historyCount}</b>
          </span>
          <span>
            备份 / 恢复点：
            <b>
              {projectStats?.data
                ? `${projectStats.data.backupCount} / ${projectStats.data.recoveryPointCount}`
                : projectStats?.loading
                  ? '加载中…'
                  : '—'}
            </b>
          </span>
        </div>
        <div className="xs muted">
          {projectStats?.error ? (
            <span style={{ color: '#ff9d9d' }}>
              统计不可用：{projectStats.error}
              <button
                type="button"
                className="btn sm ghost"
                style={{ marginLeft: 6 }}
                onClick={() => {
                  statsRequested.current.delete(project.id)
                  statsRequested.current.add(project.id)
                  void loadStats(project.id)
                }}
              >
                重试
              </button>
            </span>
          ) : projectStats?.data?.lastActivityAt ? (
            `最近活动：${formatDate(projectStats.data.lastActivityAt)}`
          ) : projectStats?.loading ? (
            <span className="row">
              <Loader2 size={11} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
              正在加载项目统计…
            </span>
          ) : (
            '—'
          )}
        </div>
        <div className="project-actions">
          <Button
            variant="primary"
            size="sm"
            icon={<FolderOpen size={13} />}
            loading={openingProjectId === project.id}
            onClick={() => void handleOpenProject(project)}
          >
            打开项目
          </Button>
          <div className="project-actions-secondary">
            <Button
              size="sm"
              variant="ghost"
              className="btn-icon-label"
              icon={<Pencil size={13} />}
              title="编辑项目"
              onClick={() => openEditProject(project)}
            >
              编辑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="btn-icon-label"
              icon={<History size={13} />}
              title="操作历史"
              onClick={() => navigate('history')}
            >
              历史
            </Button>
            <Button
              size="sm"
              variant="danger"
              className="btn-icon-label"
              icon={<Trash2 size={13} />}
              title="删除项目"
              onClick={() => setDeletingProject(project)}
            >
              删除
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  const renderConnectionRow = (connection: ConnectionSummary): ReactNode => {
    const status = statuses[connection.id]
    const test = tests[connection.id]
    const testOk = Boolean(test?.result?.ok)
    // After a successful test, don't keep showing a previous connect failure as the row state.
    const state: ConnectionState =
      testOk && (status?.state === 'error' || (!status && connection.lastState === 'error'))
        ? 'disconnected'
        : status?.state ?? connection.lastState
    const fetchError = statusErrors[connection.id]
    const connectError = testOk ? undefined : status?.error
    const rowBusy = busy[`conn:${connection.id}`]
    return (
      <div key={connection.id} className="conn-row">
        <div className="conn-main">
          <div className="conn-name">
            <span className={`status-dot ${state}`} title={stateLabel[state]} />
            <span className="truncate">{connection.name}</span>
            <Badge className={stateBadgeClass[state]}>
              {state === 'connecting' && (
                <Loader2 size={10} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
              )}
              {stateLabel[state]}
            </Badge>
            {connection.hasStoredPassword ? (
              <span title="密码保存在系统密钥库/凭证管理器中，界面不会回显">
                <Badge className="badge neutral">密码已保存</Badge>
              </span>
            ) : (
              <span title="尚未保存密码，连接时需要输入">
                <Badge className="badge warn">未保存密码</Badge>
              </span>
            )}
          </div>
          <div className="conn-meta">
            <span className="mono">
              {connection.host}:{connection.port}
            </span>
            <span>
              用户 <span className="mono">{connection.user}</span>
            </span>
            <span>
              库 <span className="mono">{connection.database || '—'}</span>
            </span>
            <span>SSL {connection.ssl}</span>
            <span>字符集 {connection.charset}</span>
            <span>最后使用 {formatRelative(connection.lastUsedAt)}</span>
          </div>
          {status?.serverVersion && (
            <div className="xs muted mt-1">
              服务端 {status.serverVersion}
              {status.serverFlavor ? ` · ${status.serverFlavor}` : ''}
              {status.latencyMs !== undefined ? ` · 延迟 ${status.latencyMs} ms` : ''}
            </div>
          )}
          {fetchError && (
            <div className="xs mt-1" style={{ color: 'var(--danger)' }}>
              状态获取失败：{fetchError}
            </div>
          )}
          {connectError && (
            <div className="xs mt-1" style={{ color: 'var(--danger)' }}>
              连接失败：{connectError}
            </div>
          )}
          {test && (
            <div className="conn-test">
              {test.loading ? (
                <span className="row muted small">
                  <Loader2 size={12} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
                  正在测试连接…
                </span>
              ) : test.error ? (
                <Callout kind="danger" title="测试连接失败">
                  <div className="pre-wrap">{test.error}</div>
                </Callout>
              ) : test.result ? (
                <Callout
                  kind={test.result.ok ? 'ok' : 'danger'}
                  title={test.result.ok ? '测试连接成功' : '测试连接失败'}
                >
                  <div className="small">
                    目标 <span className="mono">{test.result.host}</span> · 延迟 {test.result.latencyMs} ms
                    {test.result.serverVersion ? ` · ${test.result.serverVersion}` : ''}
                    {test.result.serverFlavor ? ` · ${test.result.serverFlavor}` : ''}
                    {test.result.sslActive !== undefined
                      ? ` · SSL ${test.result.sslActive ? '已启用' : '未启用'}`
                      : ''}
                  </div>
                  {test.result.error && <div className="pre-wrap mt-1">{test.result.error}</div>}
                  {test.result.hint && <div className="small mt-1">建议：{test.result.hint}</div>}
                </Callout>
              ) : null}
            </div>
          )}
        </div>
        <div className="conn-actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<Activity size={13} />}
            loading={rowBusy === 'test'}
            onClick={() => void handleTestConnection(connection)}
          >
            测试
          </Button>
          {state === 'connected' ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<WifiOff size={13} />}
              loading={rowBusy === 'disconnect'}
              onClick={() => void handleDisconnect(connection)}
            >
              断开
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              icon={<Wifi size={13} />}
              loading={rowBusy === 'connect'}
              onClick={() => void handleConnect(connection)}
            >
              连接
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Pencil size={13} />}
            onClick={() => {
              setEditingConnection(connection)
              setConnectionDialogOpen(true)
            }}
          >
            编辑
          </Button>
          <Button
            size="sm"
            variant="danger"
            icon={<Trash2 size={13} />}
            onClick={() => setDeletingConnection(connection)}
          >
            删除
          </Button>
        </div>
      </div>
    )
  }

  const hour = new Date().getHours()
  const greet = hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  return (
    <div className="page">
      <PageHeader
        title="首页"
        sub={
          currentProject
            ? `当前工作区：${currentProject.name}`
            : '选择项目与连接，开始 AI 原生数据库工作'
        }
        actions={
          <>
            <Button
              icon={<RefreshCw size={14} />}
              onClick={reloadAll}
              loading={projectsLoading || connectionsLoading || healthLoading}
            >
              刷新全部
            </Button>
            <Button
              icon={<Plus size={14} />}
              onClick={() => {
                setEditingConnection(null)
                setConnectionDialogOpen(true)
              }}
            >
              新建连接
            </Button>
            <Button variant="primary" icon={<Plus size={14} />} onClick={openCreateProject}>
              新建项目
            </Button>
          </>
        }
      />

      <div className="page-body">
        <section className="home-hero">
          <div className="home-greet">
            {greet}
            {currentProject ? `，${currentProject.name}` : ''}
            {connections.some((c) => c.lastState === 'connected')
              ? ' · 数据库已连接'
              : connections.length > 0
                ? ' · 连接待命'
                : ' · 尚未添加连接'}
          </div>
          <div className="home-star">
            <AiStar size={48} />
          </div>
          <h2 className="home-title">今天想用数据库完成什么？</h2>
          <p className="home-lead">用自然语言描述任务，Agent 会规划、校验 SQL，并在写入前请求你授权。</p>
          <div className="gemini-composer">
            <textarea
              className="composer-input"
              value={homePrompt}
              onChange={(e) => setHomePrompt(e.target.value)}
              placeholder="例如：分析最近 7 天订单金额下降的原因…"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  goAgentWith(homePrompt)
                }
              }}
            />
            <div className="composer-bar">
              <span className="muted xs">⌘/Ctrl + Enter 发送到 Agent</span>
              <button
                type="button"
                className="composer-send"
                title="发送到 AI Agent"
                disabled={!homePrompt.trim()}
                onClick={() => goAgentWith(homePrompt)}
              >
                <Send size={16} />
              </button>
            </div>
          </div>
          <div className="home-chips">
            {QUICK_TASKS.map((task) => (
              <button key={task.label} type="button" className="home-chip" onClick={() => goAgentWith(task.prompt)}>
                {task.label}
              </button>
            ))}
          </div>
        </section>

        {projectsError && (
          <div className="mb-3">
            <Callout kind="danger" title="项目列表加载失败">
              <div className="pre-wrap">{projectsError}</div>
              <div className="mt-2">
                <Button size="sm" onClick={() => void loadProjects()}>
                  重试
                </Button>
              </div>
            </Callout>
          </div>
        )}

        <div className="row between mb-2">
          <h2 className="home-section-title" style={{ margin: 0 }}>
            最近项目
            <span className="muted small" style={{ fontWeight: 400 }}>
              {projects.length} 个
            </span>
          </h2>
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={openCreateProject}>
            新建项目
          </Button>
        </div>

        {projectsLoading && projects.length === 0 ? (
          <LoadingBlock label="正在加载项目…" />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<FolderOpen size={24} />}
            title="还没有项目"
            body="项目把数据库连接、Schema 快照、记忆与操作历史关联在一起，是使用 AI 与时间机器的入口。"
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={openCreateProject}>
                创建第一个项目
              </Button>
            }
          />
        ) : (
          <div className="grid-auto">{projects.map(renderProjectCard)}</div>
        )}

        <div className="divider" style={{ margin: '22px 0 16px' }} />

        <div className="row between mb-2">
          <h2 className="home-section-title" style={{ margin: 0 }}>
            数据库连接
            <span className="muted small" style={{ fontWeight: 400 }}>
              {connections.length} 个
            </span>
          </h2>
          <div className="row">
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void loadConnections()}>
              刷新
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus size={13} />}
              onClick={() => {
                setEditingConnection(null)
                setConnectionDialogOpen(true)
              }}
            >
              新建连接
            </Button>
          </div>
        </div>

        {connectionsError && (
          <div className="mb-2">
            <Callout kind="danger" title="连接列表加载失败">
              <div className="pre-wrap">{connectionsError}</div>
              <div className="mt-2">
                <Button size="sm" onClick={() => void loadConnections()}>
                  重试
                </Button>
              </div>
            </Callout>
          </div>
        )}

        {connectionsLoading && connections.length === 0 ? (
          <LoadingBlock label="正在加载数据库连接…" />
        ) : connections.length === 0 ? (
          <EmptyState
            icon={<Server size={24} />}
            title="还没有数据库连接"
            body="添加一个 MySQL / MariaDB 连接，即可在工作区浏览结构、执行 SQL。密码会保存到系统密钥库，界面不会回显。"
            action={
              <Button
                variant="primary"
                icon={<Plus size={14} />}
                onClick={() => {
                  setEditingConnection(null)
                  setConnectionDialogOpen(true)
                }}
              >
                添加连接
              </Button>
            }
          />
        ) : (
          <div className="conn-list">{connections.map(renderConnectionRow)}</div>
        )}

        <div className="divider" style={{ margin: '22px 0 16px' }} />

        <div className="row between mb-2">
          <h2 className="home-section-title" style={{ margin: 0 }}>
            系统健康
          </h2>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void loadHealth()}>
            重新检查
          </Button>
        </div>

        {healthLoading && !health ? (
          <LoadingBlock label="正在检查应用库、备份目录与工具支持…" />
        ) : healthError ? (
          <Callout kind="warn" title="无法获取系统健康状态">
            <div className="pre-wrap">{healthError}</div>
            <div className="mt-2">
              <Button size="sm" onClick={() => void loadHealth()}>
                重试
              </Button>
            </div>
          </Callout>
        ) : health ? (
          <>
            <div className="health-grid">
              <div className="health-item">
                <div className="health-label">
                  <Database size={13} />
                  应用数据库
                  <span className="spacer" />
                  <Badge className={health.appDb.ok ? 'badge ok' : 'badge danger'}>
                    {health.appDb.ok ? '正常' : '异常'}
                  </Badge>
                </div>
                <div className="health-path" title={health.appDb.path}>
                  {health.appDb.path}
                </div>
                <div className="xs muted">已应用迁移：{health.appDb.migrations}</div>
              </div>
              <div className="health-item">
                <div className="health-label">
                  <HardDrive size={13} />
                  备份目录
                  <span className="spacer" />
                  <Badge className={health.backupDir.writable ? 'badge ok' : 'badge danger'}>
                    {health.backupDir.writable ? '可写' : '不可写'}
                  </Badge>
                </div>
                <div className="health-path" title={health.backupDir.path}>
                  {health.backupDir.path}
                </div>
                <div className="xs muted">剩余空间：{formatBytes(health.backupDir.freeBytes)}</div>
              </div>
              <div className="health-item">
                <div className="health-label">
                  <DatabaseZap size={13} />
                  记忆数据库
                  <span className="spacer" />
                  <Badge className={health.memoryDb.ok ? 'badge ok' : 'badge danger'}>
                    {health.memoryDb.ok ? '正常' : '异常'}
                  </Badge>
                </div>
                <div className="health-path" title={health.memoryDb.path}>
                  {health.memoryDb.path}
                </div>
                {health.memoryDb.error && <div className="xs" style={{ color: '#ff9d9d' }}>{health.memoryDb.error}</div>}
              </div>
              <div className="health-item">
                <div className="health-label">
                  <ShieldCheck size={13} />
                  mysqldump 工具
                  <span className="spacer" />
                  <Badge className={health.toolSupport.mysqldump ? 'badge ok' : 'badge warn'}>
                    {health.toolSupport.mysqldump ? '可用' : '未检测到'}
                  </Badge>
                </div>
                <div className="health-value">
                  {health.toolSupport.mysqldumpVersion ?? (health.toolSupport.mysqldump ? '已安装' : '将使用内置备份实现')}
                </div>
              </div>
              <div className="health-item">
                <div className="health-label">
                  <ShieldCheck size={13} />
                  系统密钥库
                  <span className="spacer" />
                  <Badge className={health.secrets?.available ? 'badge ok' : 'badge danger'}>
                    {health.secrets?.available ? '可用' : '不可用'}
                  </Badge>
                </div>
                <div className="health-value">
                  {health.secrets?.backend === 'safeStorage'
                    ? 'Electron safeStorage（macOS Keychain / Windows DPAPI）'
                    : health.secrets?.backend === 'memory'
                      ? '内存回退（重启后需重新输入密码）'
                      : '未知'}
                </div>
              </div>
            </div>

            <div className="mt-2">
              {!health.ok && (
                <Callout kind="danger" title="系统健康异常">
                  <div className="pre-wrap">
                    {health.appDb.error ??
                      (!health.secrets?.available
                        ? '系统密钥库不可用，无法安全保存数据库密码与 API Key。请检查 macOS 钥匙串 / Windows 凭据管理器后重启。'
                        : '应用数据库不可用，项目、记忆与历史可能无法读写。')}
                  </div>
                </Callout>
              )}
              {health.secrets && !health.secrets.available && (
                <div className="mb-2">
                  <Callout kind="danger" title="系统密钥库不可用">
                    当前后端为 <span className="mono">{health.secrets.backend}</span>
                    。保存连接密码或模型 API Key 将被拒绝，不会以明文落盘。
                  </Callout>
                </div>
              )}
              {!health.backupDir.writable && (
                <div className="mb-2">
                  <Callout kind="danger" title="备份目录不可写">
                    目录 <span className="mono">{health.backupDir.path}</span> 无法写入。为满足安全策略，高风险写操作在备份失败时必须被拒绝执行，请先修复目录权限或到安全设置中修改备份目录。
                  </Callout>
                </div>
              )}
              {backupDiskLow && (
                <div className="mb-2">
                  <Callout kind="warn" title="备份磁盘空间不足">
                    剩余 {formatBytes(health.backupDir.freeBytes)}，低于告警阈值 {formatBytes(diskWarnBytes)}。空间不足可能导致备份失败，从而阻止危险操作执行。
                  </Callout>
                </div>
              )}
              {!health.toolSupport.mysqldump && (
                <Callout kind="warn" title="未检测到 mysqldump">
                  应用将使用内置备份实现；部分完整备份/恢复验证能力可能受限。可在安全设置中检查备份配置。
                </Callout>
              )}
            </div>
          </>
        ) : (
          <div className="muted small">尚未获取健康状态。</div>
        )}

        {health && (
          <div className="xs muted mt-3 row">
            <AlertTriangle size={12} />
            <span>
              所有状态均来自真实 IPC（app.health / conn.status），不会显示模拟数据。应用版本{' '}
              {info?.version ?? '—'} · 数据目录 {info?.userDataPath ?? '—'}
            </span>
          </div>
        )}
        <div className="xs muted mt-2 row">
          <Clock4 size={12} />
          <span>连接凭证保存在系统密钥库/凭证管理器；界面仅显示“密码已保存”状态。</span>
        </div>
      </div>

      {/* -------------------------------------------------- 新建 / 编辑项目 */}
      <Modal
        open={projectDialogOpen}
        title={editingProject ? `编辑项目：${editingProject.name}` : '新建项目'}
        closeOnEscape={false}
        onClose={() => {
          if (!projectSaving) {
            setProjectDialogOpen(false)
            setEditingProject(null)
          }
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setProjectDialogOpen(false)
                setEditingProject(null)
              }}
              disabled={projectSaving}
            >
              取消
            </Button>
            <Button variant="primary" onClick={() => void handleSaveProject()} loading={projectSaving}>
              {editingProject ? '保存修改' : '创建项目'}
            </Button>
          </>
        }
      >
        {projectFormError instanceof ApiError ? (
          <div className="mb-2">
            <Callout kind="danger" title={`保存失败（${projectFormError.code}）`}>
              <div className="pre-wrap">{projectFormError.message}</div>
              {projectFormError.hint && <div className="small mt-1">建议：{projectFormError.hint}</div>}
            </Callout>
          </div>
        ) : projectFormError ? (
          <div className="mb-2">
            <Callout kind="danger" title="保存失败">
              <div className="pre-wrap">{errorMessage(projectFormError)}</div>
            </Callout>
          </div>
        ) : null}
        <Field label="项目名称">
          <Input value={projectName} onChange={setProjectName} placeholder="例如：订单系统分析" autoFocus maxLength={120} />
        </Field>
        <Field label="描述" hint="可选，用于说明该项目关注的业务范围">
          <Textarea value={projectDescription} onChange={setProjectDescription} rows={3} placeholder="例如：分析订单、支付与退款相关表" />
        </Field>
        <Field label="关联连接" hint="项目会记住该连接；之后可扫描结构、建立 Schema 记忆">
          <Select<string>
            value={projectConnectionId}
            onChange={setProjectConnectionId}
            options={[
              { value: '', label: connections.length === 0 ? '暂无连接（可稍后关联）' : '不关联连接' },
              ...connections.map((connection) => ({
                value: connection.id,
                label: `${connection.name}（${connection.host}:${connection.port}）`
              }))
            ]}
          />
        </Field>
      </Modal>

      <ConnectionDialog
        open={connectionDialogOpen}
        editing={editingConnection}
        onClose={() => setConnectionDialogOpen(false)}
        onSaved={(saved) => {
          setConnectionDialogOpen(false)
          void loadConnections().then(() => {
            void refreshStatuses([saved])
          })
          toastOk(editingConnection ? '连接已更新' : '连接已创建', saved.name)
          setEditingConnection(null)
        }}
      />

      <ConfirmDialog
        open={deletingConnection !== null}
        title={`删除连接：${deletingConnection?.name ?? ''}`}
        confirmLabel="删除连接"
        danger
        busy={deleting}
        onConfirm={() => void handleDeleteConnection()}
        onCancel={() => setDeletingConnection(null)}
      >
        <Callout kind="warn" title="删除后不可恢复">
          将删除该连接及其保存的密码（<span className="mono">{deletingConnection?.host}:{deletingConnection?.port}</span>）。
          项目、历史与备份记录不会被自动删除。确定要删除吗？
        </Callout>
      </ConfirmDialog>

      <ConfirmDialog
        open={deletingProject !== null}
        title={`删除项目：${deletingProject?.name ?? ''}`}
        confirmLabel="删除项目"
        danger
        busy={deletingProjectBusy}
        onConfirm={() => void handleDeleteProject()}
        onCancel={() => {
          setDeletingProject(null)
          setDeleteProjectMemories(false)
        }}
      >
        <Callout kind="warn" title="删除后不可恢复">
          将删除项目元数据。连接、备份文件与操作历史默认保留；勾选下方选项可同时清除该项目的记忆条目。
        </Callout>
        <div className="mt-2">
          <Checkbox
            checked={deleteProjectMemories}
            onChange={setDeleteProjectMemories}
            label="同时删除该项目的全部记忆"
          />
        </div>
      </ConfirmDialog>
    </div>
  )
}
