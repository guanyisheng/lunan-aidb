import { create } from 'zustand'
import type {
  AgentBusyState,
  AppInfo,
  AppSettings,
  ConnectionSummary,
  HealthReport,
  Project,
  SchemaSnapshot
} from '@shared/types'
import { ApiError, call } from './api'

export type PageKey =
  | 'home'
  | 'workspace'
  | 'agent'
  | 'history'
  | 'timemachine'
  | 'memory'
  | 'models'
  | 'settings'

export interface Toast {
  id: number
  kind: 'ok' | 'error' | 'warn' | 'info'
  title: string
  body?: string
}

export interface SessionState {
  info: AppInfo | null
  health: HealthReport | null
  settings: AppSettings | null
  projects: Project[]
  connections: ConnectionSummary[]
  currentProjectId: string | null
  currentProject: Project | null
  activeConnectionId: string | null
  activeDatabase: string
  schema: SchemaSnapshot | null
  initialized: boolean
  initError: string | null
  /** Live Agent tasks occupying a DB connection (usually max 1 concurrent feel). */
  agentBusy: AgentBusyState
}

export interface AppStoreState extends SessionState {
  page: PageKey
  toasts: Toast[]
  /** Draft prompt carried from Home shortcuts into Agent */
  agentDraft: string
  navigate: (page: PageKey) => void
  setAgentDraft: (draft: string) => void
  consumeAgentDraft: () => string
  init: () => Promise<void>
  refreshInfo: () => Promise<void>
  refreshHealth: () => Promise<void>
  refreshSettings: () => Promise<AppSettings | null>
  refreshProjects: () => Promise<Project[]>
  refreshConnections: () => Promise<ConnectionSummary[]>
  refreshAgentBusy: (connectionId?: string | null) => Promise<AgentBusyState>
  openProject: (id: string) => Promise<void>
  closeProject: () => void
  setActiveConnection: (id: string | null) => void
  setActiveDatabase: (database: string) => void
  setSchema: (schema: SchemaSnapshot | null) => void
  pushToast: (toast: Omit<Toast, 'id'>) => void
  dismissToast: (id: number) => void
  toastError: (e: unknown) => void
  toastOk: (title: string, body?: string) => void
  /** Warn when user tries live DB ops while Agent is busy. Returns true if blocked. */
  guardAgentBusy: (actionLabel?: string) => boolean
}

let toastSeq = 1

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.hint ? `${e.message}（${e.hint}）` : e.message
  if (e instanceof Error) return e.message
  return String(e)
}

export const useAppStore = create<AppStoreState>()((set, get) => ({
  info: null,
  health: null,
  settings: null,
  projects: [],
  connections: [],
  currentProjectId: null,
  currentProject: null,
  activeConnectionId: null,
  activeDatabase: '',
  schema: null,
  initialized: false,
  initError: null,
  agentBusy: { busy: false, tasks: [] },
  page: 'home',
  toasts: [],
  agentDraft: '',

  navigate: (page) => set({ page }),
  setAgentDraft: (draft) => set({ agentDraft: draft }),
  consumeAgentDraft: () => {
    const draft = get().agentDraft
    if (draft) set({ agentDraft: '' })
    return draft
  },

  init: async () => {
    try {
      const [info, settings, projects, connections] = await Promise.all([
        call('app.info', undefined),
        call('app.settings.get', undefined),
        call('project.list', undefined),
        call('conn.list', undefined)
      ])
      set({
        info,
        settings,
        projects,
        connections,
        initialized: true,
        initError: null,
        activeConnectionId: get().activeConnectionId ?? connections[0]?.id ?? null
      })
      void get()
        .refreshHealth()
        .catch(() => undefined)
      void get()
        .refreshAgentBusy(get().activeConnectionId)
        .catch(() => undefined)
      // Auto-open the most recently used project so the title bar is not stuck on「未打开项目」.
      if (!get().currentProjectId && projects.length > 0) {
        const sorted = [...projects].sort((a, b) => {
          const ta = Date.parse(a.lastOpenedAt ?? a.updatedAt) || 0
          const tb = Date.parse(b.lastOpenedAt ?? b.updatedAt) || 0
          return tb - ta
        })
        void get()
          .openProject(sorted[0].id)
          .catch(() => undefined)
      }
    } catch (e) {
      set({ initialized: true, initError: errorMessage(e) })
    }
  },

  refreshInfo: async () => {
    set({ info: await call('app.info', undefined) })
  },

  refreshHealth: async () => {
    try {
      set({ health: await call('app.health', undefined) })
    } catch {
      /* health is advisory */
    }
  },

  refreshSettings: async () => {
    try {
      const settings = await call('app.settings.get', undefined)
      set({ settings })
      return settings
    } catch (e) {
      get().toastError(e)
      return null
    }
  },

  refreshProjects: async () => {
    const projects = await call('project.list', undefined)
    set({ projects })
    return projects
  },

  refreshConnections: async () => {
    const connections = await call('conn.list', undefined)
    set((state) => ({
      connections,
      activeConnectionId:
        state.activeConnectionId && connections.some((c) => c.id === state.activeConnectionId)
          ? state.activeConnectionId
          : connections[0]?.id ?? null
    }))
    return connections
  },

  refreshAgentBusy: async (connectionId) => {
    try {
      const state = await call(
        'agent.busy',
        connectionId ? { connectionId } : ({} as { connectionId?: string })
      )
      set({ agentBusy: state })
      return state
    } catch {
      const empty = { busy: false, tasks: [] as AgentBusyState['tasks'] }
      set({ agentBusy: empty })
      return empty
    }
  },

  guardAgentBusy: (actionLabel) => {
    const busy = get().agentBusy
    if (!busy.busy) return false
    const title = busy.tasks[0]?.title
    get().pushToast({
      kind: 'warn',
      title: '正在进行 AI 任务',
      body: `${actionLabel ? `${actionLabel}已暂缓。` : ''}当前连接被 Agent 占用${
        title ? `（${title.slice(0, 40)}）` : ''
      }。表浏览可继续看本地缓存；写操作/扫描请等 AI 结束或在右下角浮窗停止。`
    })
    return true
  },

  openProject: async (id) => {
    const opened = await call('project.open', { id })
    set({
      currentProjectId: id,
      currentProject: opened.project,
      activeConnectionId: opened.connection?.id ?? get().activeConnectionId,
      schema: opened.snapshot
    })
    void get().refreshHealth()
  },

  closeProject: () =>
    set({ currentProjectId: null, currentProject: null, schema: null, activeDatabase: '' }),

  setActiveConnection: (id) =>
    set({ activeConnectionId: id, activeDatabase: '', schema: null }),

  setActiveDatabase: (database) => set({ activeDatabase: database }),

  setSchema: (schema) => set({ schema }),

  pushToast: (toast) => {
    const id = toastSeq++
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    const ttl = toast.kind === 'error' ? 9000 : 4200
    window.setTimeout(() => get().dismissToast(id), ttl)
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  toastError: (e) => {
    const message = errorMessage(e)
    get().pushToast({ kind: 'error', title: '操作失败', body: message })
  },

  toastOk: (title, body) => get().pushToast({ kind: 'ok', title, body })
}))

export const usePage = (): PageKey => useAppStore((s) => s.page)
