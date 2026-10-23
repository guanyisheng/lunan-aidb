import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bot, ChevronDown, ChevronRight, CircleStop, Plus, Send, ShieldAlert, Trash2 } from 'lucide-react'
import { AiStar } from '../components/AiStar'
import type {
  AgentChatTurn,
  AgentEvent,
  AgentPlan,
  AgentStep,
  AgentTask,
  AgentTaskStatus,
  AppErrorPayload,
  ApprovalRequest,
  ModelProfile
} from '@shared/types'
import { call, onEvent } from '../lib/api'
import { useAppStore } from '../lib/store'
import { formatRelative } from '../lib/format'
import { Button, Callout, EmptyState, Field, Input, PageHeader, Select } from '../components/ui'
import {
  AgentAnswerBubble,
  AgentApprovalCard,
  AgentTaskMetrics,
  AgentThinkingPanel,
  TaskStatusDot,
  agentStatusClass,
  agentStatusLabel,
  isFinalStatus
} from '../components/intel/AgentViews'
import { ErrorLine, InlineSpinner, RefreshButton } from '../components/intel/IntelCommon'

/* ------------------------------------------------------------------ */
/* conversation state                                                  */
/* ------------------------------------------------------------------ */

interface TaskView {
  taskId: string | null
  task: AgentTask | null
  status: AgentTaskStatus | null
  statusMessage: string | null
  streamText: string
  steps: AgentStep[]
  plan: AgentPlan | null
  approvals: ApprovalRequest[]
  finalAnswer: string
  error: AppErrorPayload | null
}

const EMPTY_VIEW: TaskView = {
  taskId: null,
  task: null,
  status: null,
  statusMessage: null,
  streamText: '',
  steps: [],
  plan: null,
  approvals: [],
  finalAnswer: '',
  error: null
}

function fromTask(task: AgentTask): TaskView {
  return {
    taskId: task.id,
    task,
    status: task.status,
    statusMessage: null,
    streamText: '',
    steps: [...task.steps].sort((a, b) => a.index - b.index),
    plan: task.plan ?? null,
    approvals: [...task.approvals],
    finalAnswer: task.finalAnswer ?? '',
    error: null
  }
}

function upsertStep(steps: AgentStep[], step: AgentStep): AgentStep[] {
  return steps
    .filter((existing) => existing.index !== step.index)
    .concat(step)
    .sort((a, b) => a.index - b.index)
}

function applyAgentEvent(prev: TaskView, event: AgentEvent): TaskView {
  switch (event.type) {
    case 'task.started':
      return fromTask(event.task)
    case 'task.status':
      return { ...prev, status: event.status, statusMessage: event.message ?? prev.statusMessage }
    case 'assistant.delta':
      return { ...prev, streamText: prev.streamText + event.delta, error: null }
    case 'assistant.message':
      return { ...prev, streamText: event.content }
    case 'step':
      return { ...prev, steps: upsertStep(prev.steps, event.step) }
    case 'plan':
      return { ...prev, plan: event.plan }
    case 'approval.required':
      return {
        ...prev,
        status: 'awaiting_approval',
        approvals: prev.approvals.filter((item) => item.id !== event.approval.id).concat(event.approval)
      }
    case 'approval.resolved':
      return {
        ...prev,
        approvals: prev.approvals.map((item) =>
          item.id === event.approvalId ? { ...item, status: event.approved ? 'approved' : 'denied' } : item
        )
      }
    case 'task.finished': {
      const finished = fromTask(event.task)
      // The final answer is rendered separately; drop the streaming buffer to avoid duplication.
      return { ...finished, streamText: finished.finalAnswer ? '' : prev.streamText }
    }
    case 'error':
      return { ...prev, error: event.error }
    default:
      return prev
  }
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export function AgentPage(): ReactNode {
  const projects = useAppStore((s) => s.projects)
  const connections = useAppStore((s) => s.connections)
  const currentProjectId = useAppStore((s) => s.currentProjectId)
  const currentProject = useAppStore((s) => s.currentProject)
  const activeDatabase = useAppStore((s) => s.activeDatabase)
  const settings = useAppStore((s) => s.settings)
  const toastError = useAppStore((s) => s.toastError)
  const toastOk = useAppStore((s) => s.toastOk)
  const consumeAgentDraft = useAppStore((s) => s.consumeAgentDraft)

  /* ------------------------------------------------------------- lists */
  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<unknown>(null)
  const [models, setModels] = useState<ModelProfile[]>([])
  const [modelsError, setModelsError] = useState<unknown>(null)

  const loadTasks = useCallback(async () => {
    setListLoading(true)
    try {
      const result = await call('agent.task.list', { projectId: currentProjectId ?? undefined, limit: 50 })
      setTasks(result.items)
      setListError(null)
    } catch (e) {
      setListError(e)
    } finally {
      setListLoading(false)
    }
  }, [currentProjectId])

  useEffect(() => {
    void loadTasks()
  }, [loadTasks])

  useEffect(() => {
    let alive = true
    call('model.list', undefined)
      .then((items) => {
        if (alive) {
          setModels(items)
          setModelsError(null)
        }
      })
      .catch((e: unknown) => {
        if (alive) setModelsError(e)
      })
    return () => {
      alive = false
    }
  }, [])

  /* ------------------------------------------------------------- view */
  const [view, setView] = useState<TaskView>(EMPTY_VIEW)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const [runError, setRunError] = useState<unknown>(null)
  const [respondBusy, setRespondBusy] = useState<string | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  /** Project / DB / model row — collapsed by default so it does not block the chat. */
  const [composeOptionsOpen, setComposeOptionsOpen] = useState(false)

  const activeIdRef = useRef<string | null>(null)
  const pendingRef = useRef<{ message: string; projectId: string; buffer: AgentEvent[] } | null>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const loadTasksRef = useRef(loadTasks)
  useEffect(() => {
    loadTasksRef.current = loadTasks
  }, [loadTasks])

  /* ---------------------------------------------------- event stream */
  useEffect(() => {
    const off = onEvent('agent.event', (event) => {
      const active = activeIdRef.current
      if (!active) {
        // Buffer events that belong to the task we are about to start.
        if (pendingRef.current) pendingRef.current.buffer.push(event)
        return
      }
      if (event.taskId !== active) return
      setView((prev) => applyAgentEvent(prev, event))
      if (event.type === 'task.finished' || event.type === 'task.status') {
        void loadTasksRef.current()
      }
    })
    return () => off()
  }, [])

  /* --------------------------------------------------------- compose */
  const [projectId, setProjectId] = useState<string>(currentProjectId ?? '')
  const [connectionId, setConnectionId] = useState<string>('')
  const [database, setDatabase] = useState<string>('')
  const [databaseOptions, setDatabaseOptions] = useState<string[]>([])
  const [databasesLoading, setDatabasesLoading] = useState(false)
  const [modelProfileId, setModelProfileId] = useState<string>('')
  const [decisionModelProfileId, setDecisionModelProfileId] = useState<string>('')
  const [maxSteps, setMaxSteps] = useState<string>(String(settings?.maxAgentSteps ?? 12))
  const [message, setMessage] = useState('')
  const [starting, setStarting] = useState(false)
  const AGENT_NONE = '__none__'

  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }, [view.streamText, view.finalAnswer, view.steps.length, view.approvals.length, view.taskId, view.status, starting])

  useEffect(() => {
    const draft = consumeAgentDraft()
    if (draft) setMessage(draft)
  }, [consumeAgentDraft])

  useEffect(() => {
    if (!projectId && currentProjectId) setProjectId(currentProjectId)
  }, [currentProjectId, projectId])

  const candidateConnections = useMemo(() => {
    if (!projectId) return connections
    const project = projects.find((item) => item.id === projectId)
    if (project?.connectionId) {
      const matched = connections.find((item) => item.id === project.connectionId)
      if (matched) return [matched, ...connections.filter((item) => item.id !== matched.id)]
    }
    return connections
  }, [connections, projectId, projects])

  useEffect(() => {
    if (!connectionId && candidateConnections.length > 0) {
      setConnectionId(candidateConnections[0].id)
    } else if (connectionId && !candidateConnections.some((item) => item.id === connectionId)) {
      setConnectionId(candidateConnections[0]?.id ?? '')
    }
  }, [candidateConnections, connectionId])

  useEffect(() => {
    if (!connectionId) {
      setDatabaseOptions([])
      setDatabase('')
      return
    }
    let alive = true
    setDatabasesLoading(true)
    call('schema.listDatabases', { connectionId })
      .then((list) => {
        if (!alive) return
        const names = list.filter((item) => !item.isSystem).map((item) => item.name)
        const connection = connections.find((item) => item.id === connectionId)
        const preferred =
          (activeDatabase && names.includes(activeDatabase) ? activeDatabase : '') ||
          (connection?.database && names.includes(connection.database) ? connection.database : '') ||
          names[0] ||
          connection?.database ||
          ''
        setDatabaseOptions(names)
        setDatabase((prev) => (prev && names.includes(prev) ? prev : preferred))
      })
      .catch(() => {
        if (!alive) return
        const connection = connections.find((item) => item.id === connectionId)
        const fallback = activeDatabase || connection?.database || ''
        setDatabaseOptions(fallback ? [fallback] : [])
        setDatabase(fallback)
      })
      .finally(() => {
        if (alive) setDatabasesLoading(false)
      })
    return () => {
      alive = false
    }
  }, [activeDatabase, connectionId, connections])

  const agentModels = useMemo(
    () => models.filter((model) => !model.roles?.length || model.roles.includes('agent')),
    [models]
  )
  const decisionModels = useMemo(
    () => models.filter((model) => model.roles?.includes('decision')),
    [models]
  )
  const defaultModel = useMemo(
    () => agentModels.find((model) => model.isDefault) ?? agentModels[0] ?? null,
    [agentModels]
  )
  const defaultDecision = useMemo(() => {
    const id = settings?.defaultDecisionModelProfileId
    if (id) return decisionModels.find((model) => model.id === id) ?? null
    return decisionModels[0] ?? null
  }, [decisionModels, settings?.defaultDecisionModelProfileId])
  useEffect(() => {
    if (!modelProfileId && settings?.defaultModelProfileId) setModelProfileId(settings.defaultModelProfileId)
  }, [modelProfileId, settings])
  const [decisionPrefillDone, setDecisionPrefillDone] = useState(false)
  useEffect(() => {
    if (decisionPrefillDone) return
    if (settings?.defaultDecisionModelProfileId) {
      setDecisionModelProfileId(settings.defaultDecisionModelProfileId)
      setDecisionPrefillDone(true)
    } else if (settings) {
      setDecisionPrefillDone(true)
    }
  }, [decisionPrefillDone, settings])

  /* ---------------------------------------------------------- actions */
  const adoptTask = useCallback((task: AgentTask) => {
    activeIdRef.current = task.id
    setSelectedTaskId(task.id)
    let next = fromTask(task)
    const pending = pendingRef.current
    if (pending) {
      for (const event of pending.buffer) {
        if (event.taskId === task.id) next = applyAgentEvent(next, event)
      }
      pendingRef.current = null
    }
    setView(next)
    setTasks((prev) => [task, ...prev.filter((item) => item.id !== task.id)])
  }, [])

  const startTask = useCallback(async () => {
    setRunError(null)
    setActionError(null)
    const trimmed = message.trim()
    if (!trimmed) {
      setRunError(new Error('请输入内容'))
      return
    }
    const continuing =
      Boolean(selectedTaskId) &&
      view.taskId === selectedTaskId &&
      view.task !== null &&
      isFinalStatus(view.status)

    const effectiveProjectId = continuing ? view.task!.projectId : projectId
    const effectiveConnectionId = continuing ? view.task!.connectionId : connectionId
    const effectiveDatabase = continuing ? view.task!.database : database.trim()

    if (!effectiveProjectId) {
      setRunError(new Error('请先选择项目'))
      return
    }
    if (!effectiveConnectionId) {
      setRunError(new Error('请先选择数据库连接（Agent 需要真实连接才能读取 Schema 和执行受控 SQL）'))
      return
    }
    if (!effectiveDatabase) {
      setRunError(new Error('请先选择目标数据库（与工作区当前库保持一致，避免 Agent 扫错库）'))
      return
    }
    if (view.status !== null && !isFinalStatus(view.status)) {
      setRunError(new Error('当前对话仍在回复中，请等待结束或先停止'))
      return
    }
    const useAgent = modelProfileId !== AGENT_NONE
    const useJev = Boolean(decisionModelProfileId)
    if (!useAgent && !useJev) {
      setRunError(new Error('请至少选择主模型或 JEV 决策模型'))
      return
    }
    if (useAgent) {
      const agentProfile = modelProfileId
        ? models.find((m) => m.id === modelProfileId)
        : defaultModel
      if (agentProfile?.kind === 'openai' && !agentProfile.apiKeyStored) {
        setRunError(new Error(`主模型「${agentProfile.name}」未存储 API Key，请到模型设置填写或用「复制」从已有配置复用`))
        return
      }
    }
    if (useJev) {
      const jevProfile = models.find((m) => m.id === decisionModelProfileId)
      if (jevProfile?.kind === 'openai' && !jevProfile.apiKeyStored) {
        setRunError(
          new Error(
            `JEV「${jevProfile.name}」未存储 API Key。请到模型设置补密钥，或从已有主模型点「复制」再建 JEV（会自动复用 Key）`
          )
        )
        return
      }
    }
    const stepsNum = Number(maxSteps)
    if (maxSteps.trim() !== '' && (!Number.isFinite(stepsNum) || stepsNum < 1 || stepsNum > 50)) {
      setRunError(new Error('最大步数必须是 1–50 的整数'))
      return
    }
    setStarting(true)
    if (!continuing) {
      setView(EMPTY_VIEW)
      activeIdRef.current = null
      pendingRef.current = { message: trimmed, projectId: effectiveProjectId, buffer: [] }
    } else {
      activeIdRef.current = selectedTaskId
      pendingRef.current = null
      // Optimistically show the user follow-up while the round starts.
      setView((prev) => {
        const optimistic: AgentChatTurn = {
          id: `local-${Date.now()}`,
          role: 'user',
          content: trimmed,
          createdAt: new Date().toISOString()
        }
        const task = prev.task
          ? {
              ...prev.task,
              turns: [...(prev.task.turns ?? []), optimistic],
              status: 'queued' as const,
              finalAnswer: undefined,
              finishedAt: null
            }
          : prev.task
        return {
          ...prev,
          task,
          status: 'queued',
          statusMessage: '继续对话',
          streamText: '',
          finalAnswer: '',
          error: null
        }
      })
    }
    try {
      const result = await call('agent.run', {
        projectId: effectiveProjectId,
        connectionId: effectiveConnectionId,
        database: effectiveDatabase,
        message: trimmed,
        ...(useAgent
          ? { modelProfileId: modelProfileId || undefined }
          : { modelProfileId: '' }),
        ...(useJev ? { decisionModelProfileId } : {}),
        maxSteps: maxSteps.trim() === '' ? undefined : Math.floor(stepsNum),
        ...(continuing && selectedTaskId ? { taskId: selectedTaskId } : {})
      })
      adoptTask(result.task)
      setMessage('')
      toastOk(continuing ? '已发送回复' : '任务已启动', continuing ? '正在同一对话中继续' : `任务 ${result.task.id}`)
    } catch (e) {
      pendingRef.current = null
      setRunError(e)
    } finally {
      setStarting(false)
    }
  }, [
    adoptTask,
    connectionId,
    database,
    decisionModelProfileId,
    defaultModel,
    maxSteps,
    message,
    modelProfileId,
    models,
    projectId,
    selectedTaskId,
    toastOk,
    view.status,
    view.task,
    view.taskId
  ])

  const openTask = useCallback(async (task: AgentTask) => {
    setActionError(null)
    setRunError(null)
    activeIdRef.current = task.id
    pendingRef.current = null
    setSelectedTaskId(task.id)
    setDetailLoading(true)
    setView(EMPTY_VIEW)
    setProjectId(task.projectId)
    setConnectionId(task.connectionId)
    setDatabase(task.database)
    if (task.modelProfileId) setModelProfileId(task.modelProfileId)
    if (task.decisionModelProfileId) setDecisionModelProfileId(task.decisionModelProfileId)
    try {
      const full = await call('agent.task.get', { taskId: task.id })
      if (!full) {
        setView(fromTask(task))
        setActionError(new Error('主进程未找到该任务，展示的是任务列表中的快照'))
        return
      }
      setView(fromTask(full))
    } catch (e) {
      setView(fromTask(task))
      setActionError(e)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const respond = useCallback(
    async (approval: ApprovalRequest, approved: boolean) => {
      setRespondBusy(approval.id)
      setActionError(null)
      try {
        await call('agent.approval.respond', { approvalId: approval.id, approved })
        setView((prev) => ({
          ...prev,
          approvals: prev.approvals.map((item) =>
            item.id === approval.id ? { ...item, status: approved ? 'approved' : 'denied' } : item
          )
        }))
        toastOk(approved ? '已批准' : '已拒绝', `${approval.id} 的审批结果已提交给主进程`)
      } catch (e) {
        setActionError(e)
        toastError(e)
      } finally {
        setRespondBusy(null)
      }
    },
    [toastError, toastOk]
  )

  const cancelTask = useCallback(async () => {
    if (!selectedTaskId) return
    setCancelBusy(true)
    setActionError(null)
    try {
      await call('agent.cancel', { taskId: selectedTaskId })
      const task = await call('agent.task.get', { taskId: selectedTaskId }).catch(() => null)
      if (task) setView(fromTask(task))
      toastOk(
        task?.status === 'cancelled' ? '已停止' : '已请求停止',
        task?.status === 'cancelled' ? '任务已标记为取消' : '正在中止模型请求与工具调用'
      )
      void loadTasks()
    } catch (e) {
      setActionError(e)
      toastError(e)
    } finally {
      setCancelBusy(false)
    }
  }, [loadTasks, selectedTaskId, toastError, toastOk])

  const deleteTask = useCallback(async () => {
    if (!selectedTaskId) return
    const ok = window.confirm('确定删除该对话任务？删除后不可恢复。')
    if (!ok) return
    setDeleteBusy(true)
    setActionError(null)
    try {
      await call('agent.task.delete', { taskId: selectedTaskId })
      toastOk('已删除任务', selectedTaskId)
      if (activeIdRef.current === selectedTaskId) activeIdRef.current = null
      setSelectedTaskId(null)
      setView(EMPTY_VIEW)
      void loadTasks()
    } catch (e) {
      setActionError(e)
      toastError(e)
    } finally {
      setDeleteBusy(false)
    }
  }, [loadTasks, selectedTaskId, toastError, toastOk])

  const newTask = useCallback(() => {
    const hadPrev = Boolean(selectedTaskId)
    activeIdRef.current = null
    pendingRef.current = null
    setSelectedTaskId(null)
    setView(EMPTY_VIEW)
    setRunError(null)
    setActionError(null)
    setMessage('')
    if (hadPrev) {
      toastOk('已开新对话', '不会带上之前的聊天记录；项目数据库说明与库结构仍会注入。')
    }
  }, [selectedTaskId, toastOk])

  /* ----------------------------------------------------------- render */
  const pendingApprovals = view.approvals.filter((approval) => approval.status === 'pending')
  const live = view.status !== null && !isFinalStatus(view.status)
  const canCancel = view.taskId !== null && live
  const canContinue = Boolean(view.task && isFinalStatus(view.status))
  const turns: AgentChatTurn[] =
    view.task?.turns && view.task.turns.length > 0
      ? view.task.turns
      : view.task
        ? [
            {
              id: `${view.task.id}-u0`,
              role: 'user' as const,
              content: view.task.userMessage,
              createdAt: view.task.createdAt
            },
            ...(view.finalAnswer
              ? [
                  {
                    id: `${view.task.id}-a0`,
                    role: 'assistant' as const,
                    content: view.finalAnswer,
                    createdAt: view.task.finishedAt ?? view.task.updatedAt
                  }
                ]
              : [])
          ]
        : []
  // While live, the latest assistant turn may not exist yet — show thinking + stream instead of stale answer.
  const completedTurns = live
    ? turns.filter((t, i) => !(t.role === 'assistant' && i === turns.length - 1 && !view.finalAnswer))
    : turns
  // Prefer transcript turns; fall back to finalAnswer bubble only when turns lack assistant.
  const lastCompletedIsAssistant = completedTurns[completedTurns.length - 1]?.role === 'assistant'

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="row">
            <AiStar size={18} thinking={live} />
            AI Agent
          </span>
        }
        sub="自然语言查改库（需项目「数据库说明」才听得懂业务说法）· 写操作仍须人工审批"
        actions={
          <>
            <RefreshButton onClick={() => void loadTasks()} loading={listLoading} label="刷新任务" />
            <Button
              variant="primary"
              onClick={newTask}
              icon={<Plus size={13} />}
              title="新对话不会带上之前聊天记录"
            >
              新建任务
            </Button>
          </>
        }
      />

      <div className="intel-banner danger">
        <ShieldAlert size={15} className="intel-banner-icon" />
        <div>
          <span className="strong">AI 输出为不可信内容。</span>
          模型生成的 SQL、Schema 说明和工具参数都只作为数据展示；任何写操作、DDL、恢复都必须经过主进程安全校验与
          <span className="strong">人工批准</span>，模型不能直接执行 shell 或绕过审批。
        </div>
      </div>

      <div className="page-body flush">
        <div className="intel-split narrow-left" style={{ height: '100%' }}>
          {/* ------------------------------------------------ task list */}
          <aside className="intel-pane">
            <div className="intel-pane-head">
              <span className="intel-pane-title">任务列表</span>
              <span className="badge neutral">{tasks.length}</span>
              <span className="muted xs truncate" title="任务列表按当前打开的项目过滤">
                {currentProject ? `项目：${currentProject.name}` : '全部项目'}
              </span>
              <div className="spacer" />
              <RefreshButton onClick={() => void loadTasks()} loading={listLoading} />
            </div>
            <div className="intel-pane-body">
              {listError ? (
                <ErrorLine error={listError} title="任务列表加载失败" />
              ) : listLoading && tasks.length === 0 ? (
                <InlineSpinner />
              ) : tasks.length === 0 ? (
                <div className="intel-empty-hint">暂无 Agent 任务。在右侧输入数据库任务后点击「启动任务」。</div>
              ) : (
                <div className="intel-list">
                  {tasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      className={`intel-list-item ${selectedTaskId === task.id ? 'active' : ''}`}
                      style={{ textAlign: 'left', width: '100%' }}
                      onClick={() => void openTask(task)}
                    >
                      <div className="row between" style={{ gap: 6 }}>
                        <span className="title truncate">{task.title || task.userMessage}</span>
                        <span className={agentStatusClass[task.status]}>{agentStatusLabel[task.status]}</span>
                      </div>
                      <div className="meta row wrap" style={{ gap: 6 }}>
                        <TaskStatusDot status={task.status} />
                        <span>{formatRelative(task.updatedAt)}</span>
                        <span>·</span>
                        <span>
                          {task.stepCount}/{task.maxSteps} 步
                        </span>
                        {task.database && (
                          <>
                            <span>·</span>
                            <span className="mono truncate">{task.database}</span>
                          </>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>

          {/* -------------------------------------------------- conversation */}
          <section className="intel-pane">
            <div className="intel-pane-head">
              <Bot size={14} />
              <span className="intel-pane-title">{view.task ? view.task.title : '新任务'}</span>
              {view.status && <span className={agentStatusClass[view.status]}>{agentStatusLabel[view.status]}</span>}
              {live && <span className="spinner" />}
              <div className="spacer" />
              {detailLoading && <InlineSpinner label="加载任务详情…" />}
              {canCancel && (
                <Button variant="danger" size="sm" loading={cancelBusy} onClick={() => void cancelTask()}>
                  <CircleStop size={12} /> 停止
                </Button>
              )}
              {view.taskId && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={deleteBusy}
                  onClick={() => void deleteTask()}
                  title={live ? '先停止再删除（会一并取消）' : '删除此对话任务'}
                >
                  <Trash2 size={12} /> 删除
                </Button>
              )}
            </div>

            <div className="intel-pane-body" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
              <div className="grow" style={{ overflow: 'auto', minHeight: 0 }} ref={chatScrollRef}>
                {!view.task && !starting ? (
                  <div style={{ padding: 28 }}>
                    <EmptyState
                      icon={<AiStar size={36} />}
                      title="开始一个数据库任务"
                      body={
                        <div className="small" style={{ maxWidth: 560, margin: '0 auto' }}>
                          例如：「统计最近 7 天每个渠道的订单数并解释业务含义」、「给 users 表加一个 last_login_at
                          字段（会先展示计划与恢复方案，批准后才执行）」。只读查询可以在权限允许范围内简化确认；写操作必须人工批准。
                        </div>
                      }
                    />
                  </div>
                ) : (
                  <div className="intel-chat codex-chat">
                    {view.task && (
                      <AgentTaskMetrics
                        task={view.task}
                        status={view.status}
                        statusMessage={view.statusMessage}
                      />
                    )}

                    {completedTurns.map((turn, index) => {
                      const isLastUser =
                        turn.role === 'user' &&
                        !completedTurns.slice(index + 1).some((t) => t.role === 'user')
                      const showThinkingHere =
                        isLastUser &&
                        (live || view.steps.length > 0 || Boolean(view.plan) || Boolean(view.streamText))
                      return (
                        <Fragment key={turn.id}>
                          {turn.role === 'user' ? (
                            <div className="intel-bubble user">
                              <div className="bubble-who">你</div>
                              {turn.content}
                            </div>
                          ) : (
                            <AgentAnswerBubble
                              content={turn.content}
                              failed={
                                view.status === 'failed' &&
                                turn.id === completedTurns[completedTurns.length - 1]?.id
                              }
                            />
                          )}
                          {showThinkingHere && (
                            <AgentThinkingPanel
                              steps={view.steps}
                              plan={view.plan}
                              streamText={view.streamText}
                              live={live}
                              hasFinalAnswer={Boolean(view.finalAnswer) || lastCompletedIsAssistant}
                            />
                          )}
                        </Fragment>
                      )
                    })}

                    {completedTurns.length === 0 && (live || view.steps.length > 0) && (
                      <AgentThinkingPanel
                        steps={view.steps}
                        plan={view.plan}
                        streamText={view.streamText}
                        live={live}
                        hasFinalAnswer={Boolean(view.finalAnswer)}
                      />
                    )}

                    {view.approvals.map((approval) => (
                      <AgentApprovalCard
                        key={approval.id}
                        approval={approval}
                        busy={respondBusy === approval.id}
                        live={Boolean(view.task && !isFinalStatus(view.status))}
                        onRespond={(approved) => void respond(approval, approved)}
                      />
                    ))}

                    {!live && view.finalAnswer && !lastCompletedIsAssistant && (
                      <AgentAnswerBubble content={view.finalAnswer} failed={view.status === 'failed'} />
                    )}
                    {!live && !view.finalAnswer && view.streamText && !lastCompletedIsAssistant && (
                      <AgentAnswerBubble content={view.streamText} failed={view.status === 'failed'} />
                    )}

                    {view.error && (
                      <Callout kind="danger" title={`Agent 错误：${view.error.code}`}>
                        <div>{view.error.message}</div>
                        {view.error.hint && <div className="small muted mt-1">{view.error.hint}</div>}
                      </Callout>
                    )}

                    {actionError !== null && <ErrorLine error={actionError} />}

                    {live && pendingApprovals.length === 0 && !view.streamText && view.steps.length === 0 && (
                      <div className="small muted">正在回复…</div>
                    )}
                  </div>
                )}
              </div>

              {/* ------------------------------------------------ compose */}
              <div className="intel-compose gemini-dock">
                {modelsError !== null && (
                  <div className="callout warn mb-2" style={{ fontSize: 11.5 }}>
                    <div className="strong">模型配置加载失败</div>
                    <div className="small">{String((modelsError as Error)?.message ?? modelsError)}</div>
                  </div>
                )}
                {runError !== null && <ErrorLine error={runError} title="无法启动任务" />}

                <div className="gemini-composer docked">
                  <button
                    type="button"
                    className="compose-options-toggle"
                    onClick={() => setComposeOptionsOpen((v) => !v)}
                  >
                    {composeOptionsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span className="strong xs">运行配置</span>
                    {!composeOptionsOpen && (
                      <span className="muted xs truncate" style={{ flex: 1, textAlign: 'left' }}>
                        {[
                          projects.find((p) => p.id === projectId)?.name || '未选项目',
                          database || '未选库',
                          modelProfileId === AGENT_NONE
                            ? '仅 JEV'
                            : models.find((m) => m.id === modelProfileId)?.name ||
                              defaultModel?.name ||
                              '默认模型',
                          decisionModelProfileId
                            ? `JEV ${models.find((m) => m.id === decisionModelProfileId)?.name || ''}`
                            : null
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                    <span className="muted xs">{composeOptionsOpen ? '收起' : '展开'}</span>
                  </button>
                  {composeOptionsOpen && (
                    <div className="row wrap mb-1 compose-options-body" style={{ gap: 8 }}>
                      <Field label="项目" className="grow" hint={canContinue ? '本对话已锁定' : undefined}>
                        <Select
                          value={projectId}
                          onChange={setProjectId}
                          disabled={canContinue}
                          options={[
                            { value: '', label: '选择项目…' },
                            ...projects.map((project) => ({ value: project.id, label: project.name }))
                          ]}
                        />
                      </Field>
                      <Field label="数据库" className="grow" hint={canContinue ? '本对话已锁定' : undefined}>
                        <Select
                          value={connectionId}
                          onChange={setConnectionId}
                          disabled={canContinue}
                          options={[
                            { value: '', label: connections.length === 0 ? '无可用连接' : '选择连接…' },
                            ...candidateConnections.map((connection) => ({
                              value: connection.id,
                              label: `${connection.name}（${connection.host}:${connection.port}）`
                            }))
                          ]}
                        />
                      </Field>
                      <Field
                        label="目标库"
                        hint={
                          canContinue
                            ? '本对话已锁定'
                            : databasesLoading
                              ? '读取中…'
                              : activeDatabase
                                ? `工作区：${activeDatabase}`
                                : undefined
                        }
                        className="grow"
                      >
                        <Select
                          value={database}
                          onChange={setDatabase}
                          disabled={canContinue}
                          options={[
                            {
                              value: '',
                              label: !connectionId
                                ? '先选连接'
                                : databasesLoading
                                  ? '加载中…'
                                  : databaseOptions.length === 0
                                    ? '无可用库'
                                    : '选择数据库…'
                            },
                            ...databaseOptions.map((name) => ({
                              value: name,
                              label: name === activeDatabase ? `${name}（工作区）` : name
                            }))
                          ]}
                        />
                      </Field>
                      <Field label="主模型" className="grow">
                        <Select
                          value={modelProfileId}
                          onChange={setModelProfileId}
                          options={[
                            { value: '', label: defaultModel ? `默认：${defaultModel.name}` : '使用默认 Agent' },
                            { value: AGENT_NONE, label: '不使用（仅 JEV）' },
                            ...agentModels.map((model) => ({
                              value: model.id,
                              label: `${model.name}${model.isDefault ? '（默认）' : ''}`
                            }))
                          ]}
                        />
                      </Field>
                      <Field
                        label="JEV / 决策"
                        hint={defaultDecision ? `默认 JEV：${defaultDecision.name}` : '可空 = 不评审'}
                        className="grow"
                      >
                        <Select
                          value={decisionModelProfileId}
                          onChange={setDecisionModelProfileId}
                          options={[
                            { value: '', label: '不使用 JEV' },
                            ...decisionModels.map((model) => ({
                              value: model.id,
                              label: `${model.name}${
                                settings?.defaultDecisionModelProfileId === model.id ? '（默认）' : ''
                              }`
                            })),
                            ...models
                              .filter((model) => !decisionModels.some((d) => d.id === model.id))
                              .map((model) => ({
                                value: model.id,
                                label: `${model.name}（未标 JEV）`
                              }))
                          ]}
                        />
                      </Field>
                      <Field label="步数" className="intel-max-steps">
                        <Input value={maxSteps} onChange={setMaxSteps} type="number" placeholder="12" />
                      </Field>
                    </div>
                  )}
                  <textarea
                    className="composer-input"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={2}
                    placeholder={
                      canContinue
                        ? '继续对话，输入追问或补充要求…'
                        : '描述数据库任务，例如：统计每个渠道最近 7 天的订单数，并解释结果。'
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !starting && !live) {
                        e.preventDefault()
                        void startTask()
                      }
                    }}
                  />
                  <div className="composer-bar">
                    <span className="muted xs">
                      {live ? (
                        <span className="row">
                          <AiStar size={12} thinking /> 正在回复
                        </span>
                      ) : canContinue ? (
                        <>继续本对话 · ⌘/Ctrl + Enter · 点「新建任务」另开会话</>
                      ) : (
                        <>
                          ⌘/Ctrl + Enter · 超时{' '}
                          {settings ? Math.round(settings.agentTimeoutMs / 1000) : '—'} s
                        </>
                      )}
                    </span>
                    {canCancel ? (
                      <Button variant="danger" size="sm" loading={cancelBusy} onClick={() => void cancelTask()}>
                        <CircleStop size={12} /> 停止
                      </Button>
                    ) : (
                      <button
                        type="button"
                        className="composer-send"
                        title={canContinue ? '发送回复' : '启动任务'}
                        disabled={starting || !message.trim()}
                        onClick={() => void startTask()}
                      >
                        {starting ? <span className="spinner" /> : <Send size={16} />}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
