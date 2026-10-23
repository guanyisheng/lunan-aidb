import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Bot, CircleStop, Minimize2, Plus, Search, Send, Sparkles, X } from 'lucide-react'
import type {
  AgentEvent,
  AgentPlan,
  AgentStep,
  AgentTask,
  AgentTaskStatus,
  AppErrorPayload,
  ApprovalRequest
} from '@shared/types'
import { call, onEvent } from '../../lib/api'
import { errorMessage, useAppStore } from '../../lib/store'
import { Button, Textarea } from '../ui'
import {
  AgentAnswerBubble,
  AgentApprovalCard,
  AgentThinkingPanel,
  isFinalStatus
} from '../intel/AgentViews'
import './workspace.css'

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
      return { ...finished, streamText: finished.finalAnswer ? '' : prev.streamText }
    }
    case 'error':
      return { ...prev, error: event.error }
    default:
      return prev
  }
}

function buildSearchPrompt(keyword: string, database: string, table?: string | null): string {
  const focus = table
    ? `优先在表 \`${table}\` 中查找；若不够再扩展到同库相关表。`
    : '先扫库表结构，再定位最可能的表。'
  return [
    `请在数据库 \`${database}\` 中搜索与「${keyword.trim()}」相关的数据。`,
    focus,
    '要求：只用只读 SQL（SELECT / SHOW / DESCRIBE）；给出命中表、关键行摘要，以及可继续深挖的查询建议。',
    '不要修改任何数据。'
  ].join('\n')
}

export interface WorkspaceAiFloatProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Prefill / auto-send when opening from a row action. */
  seed?: { message: string; autoSend?: boolean } | null
  onSeedConsumed?: () => void
  connectionId: string | null
  database: string | null
  projectId: string | null
  table?: string | null
}

export function WorkspaceAiFloat(props: WorkspaceAiFloatProps): ReactNode {
  const toastOk = useAppStore((s) => s.toastOk)
  const toastError = useAppStore((s) => s.toastError)
  const settings = useAppStore((s) => s.settings)

  const [message, setMessage] = useState('')
  const [starting, setStarting] = useState(false)
  const [respondBusy, setRespondBusy] = useState<string | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [view, setView] = useState<TaskView>(EMPTY_VIEW)
  const [localError, setLocalError] = useState<string | null>(null)

  const activeIdRef = useRef<string | null>(null)
  const pendingRef = useRef<{ message: string; buffer: AgentEvent[] } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const seedHandledRef = useRef<string | null>(null)

  const busy = Boolean(view.status && !isFinalStatus(view.status))
  const canRun = Boolean(props.projectId && props.connectionId && props.database)

  useEffect(() => {
    const off = onEvent('agent.event', (event) => {
      const active = activeIdRef.current
      if (!active) {
        if (pendingRef.current) pendingRef.current.buffer.push(event)
        return
      }
      if (event.taskId !== active) return
      setView((prev) => applyAgentEvent(prev, event))
    })
    return () => off()
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    })
  }, [])

  useEffect(() => {
    if (!props.open) return
    scrollToBottom()
  }, [
    view.streamText,
    view.finalAnswer,
    view.steps.length,
    view.approvals.length,
    view.task?.userMessage,
    view.status,
    props.open,
    starting,
    scrollToBottom
  ])

  const adoptTask = useCallback((task: AgentTask) => {
    activeIdRef.current = task.id
    const buffered = pendingRef.current?.buffer ?? []
    pendingRef.current = null
    let next = fromTask(task)
    for (const event of buffered) {
      if (event.taskId === task.id) next = applyAgentEvent(next, event)
    }
    setView(next)
  }, [])

  const send = useCallback(
    async (raw: string, continuing = false) => {
      const trimmed = raw.trim()
      if (!trimmed) return
      if (!props.projectId || !props.connectionId || !props.database) {
        setLocalError('请先打开项目并选择连接 / 数据库')
        return
      }
      setLocalError(null)
      setStarting(true)
      if (!continuing) {
        setView(EMPTY_VIEW)
        activeIdRef.current = null
        pendingRef.current = { message: trimmed, buffer: [] }
      } else if (view.taskId) {
        activeIdRef.current = view.taskId
        pendingRef.current = null
      }
      try {
        const result = await call('agent.run', {
          projectId: props.projectId,
          connectionId: props.connectionId,
          database: props.database,
          message: trimmed,
          maxSteps: settings?.maxAgentSteps ?? 12,
          ...(settings?.defaultDecisionModelProfileId
            ? { decisionModelProfileId: settings.defaultDecisionModelProfileId }
            : {}),
          ...(continuing && view.taskId ? { taskId: view.taskId } : {})
        })
        adoptTask(result.task)
        setMessage('')
        toastOk(continuing ? '已继续' : '已开始', '工作区 AI 浮窗内处理')
      } catch (e) {
        pendingRef.current = null
        setLocalError(errorMessage(e))
        toastError(e)
      } finally {
        setStarting(false)
      }
    },
    [
      adoptTask,
      props.connectionId,
      props.database,
      props.projectId,
      settings?.maxAgentSteps,
      toastError,
      toastOk,
      view.taskId
    ]
  )

  const seedMessage = props.seed?.message
  const seedAutoSend = props.seed?.autoSend
  const onSeedConsumed = props.onSeedConsumed

  useEffect(() => {
    if (!props.open || !seedMessage) return
    if (seedHandledRef.current === seedMessage) return
    seedHandledRef.current = seedMessage
    setMessage(seedMessage)
    onSeedConsumed?.()
    if (seedAutoSend) void send(seedMessage, false)
  }, [onSeedConsumed, props.open, seedAutoSend, seedMessage, send])

  useEffect(() => {
    if (!props.open) seedHandledRef.current = null
  }, [props.open])

  const startNewChat = useCallback(() => {
    const hadPrev = Boolean(view.taskId)
    setView(EMPTY_VIEW)
    activeIdRef.current = null
    pendingRef.current = null
    setLocalError(null)
    if (hadPrev) {
      toastOk('已开新对话', '不会带上之前的聊天记录；数据库说明与库结构仍会注入。')
    }
    scrollToBottom()
  }, [scrollToBottom, toastOk, view.taskId])

  const onSubmit = useCallback(() => {
    const continuing = Boolean(view.taskId && isFinalStatus(view.status))
    if (!continuing && view.taskId) {
      toastOk('新对话', '本次发送不会带上上一段对话内容')
    }
    void send(message, continuing)
    scrollToBottom()
  }, [message, scrollToBottom, send, toastOk, view.status, view.taskId])

  const searchDb = useCallback(() => {
    const kw = message.trim()
    if (!kw) {
      setLocalError('先输入要搜索的关键词或业务描述')
      return
    }
    if (!props.database) {
      setLocalError('请先选择数据库')
      return
    }
    void send(buildSearchPrompt(kw, props.database, props.table), false)
  }, [message, props.database, props.table, send])

  const cancel = useCallback(async () => {
    if (!view.taskId) return
    setCancelBusy(true)
    try {
      await call('agent.cancel', { taskId: view.taskId })
    } catch (e) {
      toastError(e)
    } finally {
      setCancelBusy(false)
    }
  }, [toastError, view.taskId])

  const respond = useCallback(
    async (approval: ApprovalRequest, approved: boolean) => {
      setRespondBusy(approval.id)
      try {
        await call('agent.approval.respond', { approvalId: approval.id, approved })
      } catch (e) {
        toastError(e)
      } finally {
        setRespondBusy(null)
      }
    },
    [toastError]
  )

  const pendingApprovals = useMemo(
    () => view.approvals.filter((item) => item.status === 'pending'),
    [view.approvals]
  )

  const contextHint = useMemo(() => {
    const parts: string[] = []
    if (props.database) parts.push(props.database)
    if (props.table) parts.push(props.table)
    return parts.join(' · ') || '未选库'
  }, [props.database, props.table])

  if (!props.open) {
    return (
      <button
        type="button"
        className="ws-ai-fab"
        title="打开工作区 AI"
        onClick={() => props.onOpenChange(true)}
      >
        <Sparkles size={18} />
        <span>AI</span>
      </button>
    )
  }

  return (
    <div className="ws-ai-float" role="dialog" aria-label="工作区 AI">
      <div className="ws-ai-float-head">
        <Bot size={15} style={{ color: 'var(--accent)' }} />
        <div className="ws-ai-float-titles">
          <span className="strong xs">工作区 AI</span>
          <span className="muted xs mono truncate" title={contextHint}>
            {contextHint}
          </span>
        </div>
        <span className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus size={12} />}
          disabled={busy || starting}
          title="新对话（不带上一段聊天）"
          onClick={startNewChat}
        >
          新对话
        </Button>
        {busy && (
          <Button size="sm" variant="ghost" loading={cancelBusy} onClick={() => void cancel()} icon={<CircleStop size={12} />}>
            停止
          </Button>
        )}
        <button type="button" className="ws-ai-icon-btn" title="最小化" onClick={() => props.onOpenChange(false)}>
          <Minimize2 size={14} />
        </button>
        <button
          type="button"
          className="ws-ai-icon-btn"
          title="关闭并清空"
          onClick={() => {
            setView(EMPTY_VIEW)
            activeIdRef.current = null
            setMessage('')
            setLocalError(null)
            props.onOpenChange(false)
          }}
        >
          <X size={14} />
        </button>
      </div>

      <div className="ws-ai-float-body" ref={bodyRef}>
        {!view.task && !busy && (
          <div className="ws-ai-empty">
            <p className="small">在当前库内提问、搜索或修改（写操作仍需批准）。不离开数据库工作区。</p>
            <div className="ws-ai-chips">
              <button
                type="button"
                className="ws-ai-chip"
                disabled={!props.database}
                onClick={() => {
                  const kw = message.trim() || (props.table ? props.table : '核心业务表')
                  if (props.database) void send(buildSearchPrompt(kw, props.database, props.table))
                }}
              >
                <Search size={12} /> 搜索数据库
              </button>
              {props.table && (
                <button
                  type="button"
                  className="ws-ai-chip"
                  onClick={() =>
                    void send(
                      `请用只读 SQL 概述表 \`${props.table}\` 的用途、关键字段、行量级，并给 3 个常用查询示例。`,
                      false
                    )
                  }
                >
                  分析当前表
                </button>
              )}
              <button
                type="button"
                className="ws-ai-chip"
                onClick={() =>
                  void send(
                    `在库 \`${props.database ?? ''}\` 中查找可能的慢查询 / 缺少索引的大表，只读分析，给出建议。`,
                    false
                  )
                }
              >
                检查慢查询线索
              </button>
            </div>
          </div>
        )}

        {(view.task || busy) && (
          <>
            {view.task?.userMessage && (
              <div className="ws-ai-user-bubble">
                <div className="muted xs mb-1">你</div>
                <div className="pre-wrap small">{view.task.userMessage}</div>
              </div>
            )}
            <AgentThinkingPanel
              steps={view.steps}
              plan={view.plan}
              streamText={view.streamText}
              live={busy && !view.finalAnswer}
              hasFinalAnswer={Boolean(view.finalAnswer)}
            />
            {pendingApprovals.map((approval) => (
              <AgentApprovalCard
                key={approval.id}
                approval={approval}
                busy={respondBusy === approval.id}
                live
                onRespond={(approved) => void respond(approval, approved)}
              />
            ))}
            <AgentAnswerBubble
              content={view.finalAnswer || (!isFinalStatus(view.status) ? view.streamText : '')}
              live={busy && !view.finalAnswer}
              failed={view.status === 'failed'}
            />
            {view.error && <div className="ws-ai-error">{view.error.message}</div>}
            {view.status === 'failed' && view.task?.error && (
              <div className="ws-ai-error">{view.task.error}</div>
            )}
          </>
        )}

        {localError && <div className="ws-ai-error">{localError}</div>}
        {!canRun && (
          <div className="ws-ai-error">需要已打开项目 + 已选连接/数据库，才能在此运行 AI。</div>
        )}
      </div>

      <div className="ws-ai-float-foot">
        <div className="ws-ai-chips compact">
          <button type="button" className="ws-ai-chip" disabled={!canRun || starting || busy} onClick={searchDb}>
            <Search size={12} /> 搜库
          </button>
          {view.taskId && isFinalStatus(view.status) && (
            <span className="muted xs">「继续」保留上文 · 「新对话」剥离上文</span>
          )}
        </div>
        <Textarea
          value={message}
          onChange={setMessage}
          placeholder={
            props.table
              ? `问 AI：搜库、解释 ${props.table}、改某一行…`
              : '问 AI：搜索数据库、查表、分析业务…'
          }
          rows={2}
          disabled={starting || busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (!starting && !busy) onSubmit()
            }
          }}
        />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button
            size="sm"
            variant="primary"
            icon={<Send size={13} />}
            loading={starting}
            disabled={!canRun || busy || !message.trim()}
            onClick={onSubmit}
          >
            {view.taskId && isFinalStatus(view.status) ? '继续' : '发送'}
          </Button>
        </div>
      </div>
    </div>
  )
}
