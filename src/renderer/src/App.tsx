import { useCallback, useEffect, useMemo, type CSSProperties, type ReactNode } from 'react'
import {
  Bot,
  BrainCircuit,
  Clock4,
  Cpu,
  Database,
  History,
  Home,
  Moon,
  Settings2,
  ShieldCheck,
  Sun
} from 'lucide-react'
import { call } from './lib/api'
import { useAppStore, type PageKey } from './lib/store'
import { onEvent } from './lib/api'
import { Toasts, Button } from './components/ui'
import { AiStar } from './components/AiStar'
import { BrandMark } from './components/BrandMark'
import { HomePage } from './pages/HomePage'
import { WorkspacePage } from './pages/WorkspacePage'
import { HistoryPage } from './pages/HistoryPage'
import { AgentPage } from './pages/AgentPage'
import { MemoryPage } from './pages/MemoryPage'
import { TimeMachinePage } from './pages/TimeMachinePage'
import { ModelsPage } from './pages/ModelsPage'
import { SettingsPage } from './pages/SettingsPage'

interface NavItem {
  key: PageKey
  label: string
  icon: ReactNode
  group: string
}

const NAV: NavItem[] = [
  { key: 'home', label: '首页', icon: <Home size={15} />, group: '工作区' },
  { key: 'workspace', label: '数据库工作区', icon: <Database size={15} />, group: '工作区' },
  { key: 'agent', label: 'AI Agent', icon: <Bot size={15} />, group: '工作区' },
  { key: 'history', label: '操作历史', icon: <History size={15} />, group: '安全与历史' },
  { key: 'timemachine', label: '时间机器', icon: <Clock4 size={15} />, group: '安全与历史' },
  { key: 'memory', label: '记忆中心', icon: <BrainCircuit size={15} />, group: '智能' },
  { key: 'models', label: '模型设置', icon: <Cpu size={15} />, group: '智能' },
  { key: 'settings', label: '安全设置', icon: <Settings2 size={15} />, group: '智能' }
]

const PAGES: Record<PageKey, () => ReactNode> = {
  home: HomePage,
  workspace: WorkspacePage,
  agent: AgentPage,
  history: HistoryPage,
  timemachine: TimeMachinePage,
  memory: MemoryPage,
  models: ModelsPage,
  settings: SettingsPage
}

export function App(): ReactNode {
  const page = useAppStore((s) => s.page)
  const navigate = useAppStore((s) => s.navigate)
  const init = useAppStore((s) => s.init)
  const initialized = useAppStore((s) => s.initialized)
  const initError = useAppStore((s) => s.initError)
  const currentProject = useAppStore((s) => s.currentProject)
  const connections = useAppStore((s) => s.connections)
  const activeConnectionId = useAppStore((s) => s.activeConnectionId)
  const activeDatabase = useAppStore((s) => s.activeDatabase)
  const settings = useAppStore((s) => s.settings)
  const refreshSettings = useAppStore((s) => s.refreshSettings)
  const refreshConnections = useAppStore((s) => s.refreshConnections)
  const pushToast = useAppStore((s) => s.pushToast)
  const info = useAppStore((s) => s.info)

  useEffect(() => {
    void init()
  }, [init])

  const refreshAgentBusy = useAppStore((s) => s.refreshAgentBusy)
  useEffect(() => {
    const sync = (): void => {
      void refreshAgentBusy(activeConnectionId).catch(() => undefined)
    }
    sync()
    const off = onEvent('agent.event', (event) => {
      if (
        event.type === 'task.started' ||
        event.type === 'task.status' ||
        event.type === 'task.finished' ||
        event.type === 'error'
      ) {
        sync()
      }
    })
    const timer = window.setInterval(sync, 4000)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [activeConnectionId, refreshAgentBusy])

  const resolvedTheme = useMemo((): 'dark' | 'light' => {
    const pref = settings?.theme ?? 'dark'
    if (pref === 'light') return 'light'
    if (pref === 'dark') return 'dark'
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light'
    }
    return 'dark'
  }, [settings?.theme])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    if (settings?.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = (): void => {
      document.documentElement.setAttribute('data-theme', mq.matches ? 'light' : 'dark')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings?.theme])

  const toggleTheme = useCallback(async () => {
    const next = resolvedTheme === 'dark' ? 'light' : 'dark'
    try {
      await call('app.settings.update', { patch: { theme: next } })
      await refreshSettings()
    } catch {
      document.documentElement.setAttribute('data-theme', next)
    }
  }, [refreshSettings, resolvedTheme])

  useEffect(() => {
    const offState = onEvent('conn.state', () => {
      void refreshConnections().catch(() => undefined)
    })
    const offSchema = onEvent('schema.changed', (payload) => {
      pushToast({
        kind: 'warn',
        title: '检测到数据库结构变化',
        body: `新增 ${payload.diff.addedTables.length} / 删除 ${payload.diff.removedTables.length} / 变更 ${payload.diff.changedTables.length} 张表，${payload.invalidatedMemories} 条记忆被标记失效`
      })
    })
    return () => {
      offState()
      offSchema()
    }
  }, [pushToast, refreshConnections])

  const Page = PAGES[page]
  const groups = [...new Set(NAV.map((n) => n.group))]

  const activeConnection = useMemo(
    () => connections.find((c) => c.id === activeConnectionId) ?? null,
    [connections, activeConnectionId]
  )
  const connected = activeConnection?.lastState === 'connected'

  return (
    <div className="app-shell">
      <header className="app-titlebar">
        <div className="brand-inline">
          <div className="brand-mark">
            <BrandMark size={24} />
          </div>
          <span className="brand-title">Lunan AIDB</span>
          <span className="brand-tag">AI Database IDE · beta</span>
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 8 } as CSSProperties}>
          <span className="title-chip" title={currentProject?.name ?? '未打开项目'}>
            <span className="truncate">{currentProject ? currentProject.name : '未打开项目'}</span>
          </span>
          <span className="title-chip" title={activeConnection ? `${activeConnection.host}:${activeConnection.port}` : '无连接'}>
            <span className={`dot ${connected ? 'on' : ''}`} />
            <span className="truncate">
              {activeConnection
                ? `${activeConnection.name}${activeDatabase ? ` · ${activeDatabase}` : ''}`
                : '无连接'}
            </span>
          </span>
          <span className="title-chip" title="当前默认模型配置">
            <AiStar size={12} />
            <span className="truncate">{settings?.defaultModelProfileId ? '已配置模型' : '未配置模型'}</span>
          </span>
          <div className="title-actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void toggleTheme()}
              icon={resolvedTheme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
              title={resolvedTheme === 'dark' ? '切换浅色皮肤' : '切换深色皮肤'}
            >
              {resolvedTheme === 'dark' ? '浅色' : '深色'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => navigate('models')} icon={<Cpu size={13} />}>
              模型
            </Button>
            <Button size="sm" variant="ghost" onClick={() => navigate('settings')} icon={<Settings2 size={13} />}>
              设置
            </Button>
            <span className="xs muted">v{info?.version ?? '1.0.0'}</span>
          </div>
        </div>
      </header>
      <aside className="sidebar">
        <nav className="nav">
          {groups.map((group) => (
            <div key={group}>
              <div className="nav-group-label">{group}</div>
              {NAV.filter((n) => n.group === group).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`nav-item ${page === item.key ? 'active' : ''}`}
                  onClick={() => navigate(item.key)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="row">
            <ShieldCheck size={13} />
            <span className="truncate">{currentProject ? currentProject.name : '选择或创建项目开始'}</span>
          </div>
        </div>
      </aside>
      <main className="main">
        {!initialized ? (
          <div className="empty">
            <AiStar size={28} thinking />
            <div className="muted small mt-2">正在初始化…</div>
          </div>
        ) : initError ? (
          <div className="page-body">
            <div className="callout danger">
              <div className="strong">初始化失败</div>
              <div className="mono small mt-1">{initError}</div>
            </div>
          </div>
        ) : (
          <Page />
        )}
      </main>
      <Toasts />
    </div>
  )
}
