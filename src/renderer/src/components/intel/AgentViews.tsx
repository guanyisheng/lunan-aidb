import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  ListChecks,
  ShieldAlert,
  Wrench,
  XCircle
} from 'lucide-react'
import type {
  AgentPlan,
  AgentStep,
  AgentTask,
  AgentTaskStatus,
  ApprovalRequest,
  RecoveryPlanSummary,
  RiskLevel
} from '@shared/types'
import { riskLabel } from '../../lib/format'
import { Button, Callout, RiskBadge } from '../ui'
import { JsonBlock, MetaGrid, SqlBlock, formatNumber } from './IntelCommon'
import { MarkdownView } from '../markdown/MarkdownView'

/* ------------------------------------------------------------------ */
/* labels                                                              */
/* ------------------------------------------------------------------ */

export const agentStatusLabel: Record<AgentTaskStatus, string> = {
  queued: '排队中',
  planning: '规划中',
  awaiting_approval: '等待审批',
  executing: '执行中',
  verifying: '验证中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  max_steps_reached: '达到步数上限',
  timed_out: '已超时'
}

export const agentStatusClass: Record<AgentTaskStatus, string> = {
  queued: 'badge neutral',
  planning: 'badge accent',
  awaiting_approval: 'badge warn',
  executing: 'badge accent',
  verifying: 'badge accent',
  completed: 'badge ok',
  failed: 'badge danger',
  cancelled: 'badge neutral',
  max_steps_reached: 'badge warn',
  timed_out: 'badge danger'
}

const phaseLabel: Record<AgentStep['phase'], string> = {
  reasoning: '推理',
  tool_call: '调用工具',
  tool_result: '工具结果',
  approval: '审批',
  verification: '验证',
  final: '最终回答'
}

const strategyLabel: Record<RecoveryPlanSummary['strategy'], string> = {
  none: '无需额外恢复措施',
  before_image: '变更前镜像（按主键反向恢复）',
  schema_snapshot: '结构快照（DDL 不可依赖事务回滚）',
  full_backup: '完整备份（高风险）',
  refuse_unsafe: '拒绝执行（无法安全恢复）'
}

export function isFinalStatus(status: AgentTaskStatus | null | undefined): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'max_steps_reached' ||
    status === 'timed_out'
  )
}

/* ------------------------------------------------------------------ */
/* step card                                                           */
/* ------------------------------------------------------------------ */

export function AgentStepCard(props: { step: AgentStep; defaultOpen?: boolean }): ReactNode {
  const { step } = props
  const [open, setOpen] = useState(Boolean(props.defaultOpen))
  const hasDetail = Boolean(step.toolInput || step.toolResultSummary || step.text || step.error)
  const statusBadge =
    step.status === 'ok'
      ? { cls: 'badge ok', text: '成功' }
      : step.status === 'failed'
        ? { cls: 'badge danger', text: '失败' }
        : step.status === 'denied'
          ? { cls: 'badge warn', text: '被拒绝' }
          : { cls: 'badge accent', text: '执行中' }

  return (
    <div className={`intel-step ${step.writeOperation ? 'write' : ''} ${step.status === 'denied' ? 'denied' : ''}`}>
      <div className="intel-step-head" onClick={() => hasDetail && setOpen((value) => !value)}>
        {hasDetail ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span style={{ width: 13 }} />}
        <span className="intel-step-index">#{step.index + 1}</span>
        <span className="badge neutral">{phaseLabel[step.phase]}</span>
        {step.toolName && (
          <span className="intel-step-tool">
            <Wrench size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
            {step.toolName}
          </span>
        )}
        <span className={statusBadge.cls}>{statusBadge.text}</span>
        {step.writeOperation && (
          <span className="badge danger">
            <ShieldAlert size={10} /> 写操作
          </span>
        )}
        <div className="spacer" />
        {step.durationMs !== undefined && <span className="muted xs mono">{Math.round(step.durationMs)} ms</span>}
      </div>
      {open && hasDetail && (
        <div className="intel-step-body">
          {step.text && (
            <div>
              <div className="intel-step-label">模型输出</div>
              <div className="intel-step-text">
                <MarkdownView content={step.text} />
              </div>
            </div>
          )}
          {step.toolInput && (
            <div>
              <div className="intel-step-label">工具参数（不可信输入）</div>
              <JsonBlock value={step.toolInput} />
            </div>
          )}
          {step.toolResultSummary && (
            <div>
              <div className="intel-step-label">结果摘要</div>
              <div className="intel-step-text">{step.toolResultSummary}</div>
            </div>
          )}
          {step.error && <Callout kind="danger" title="步骤错误">{step.error}</Callout>}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* plan card                                                           */
/* ------------------------------------------------------------------ */

export function RecoveryPlanSummaryView(props: { plan: RecoveryPlanSummary | undefined }): ReactNode {
  if (!props.plan) return null
  return (
    <div className="mt-2">
      <div className="intel-step-label">恢复方案</div>
      <MetaGrid
        items={[
          { k: '策略', v: strategyLabel[props.plan.strategy] ?? props.plan.strategy },
          { k: '需要备份', v: props.plan.needsBackup ? <span className="badge warn">是</span> : '否' },
          {
            k: '备份范围',
            v: props.plan.needsBackup
              ? `${props.plan.backupScope === 'tables' ? '指定表' : '整库'}${
                  props.plan.backupTables?.length ? `：${props.plan.backupTables.join(', ')}` : ''
                }`
              : '—'
          },
          { k: '预计影响行数', v: formatNumber(props.plan.estimatedAffectedRows) },
          { k: '变更前镜像', v: props.plan.beforeImageSupported ? '支持' : '不支持' }
        ]}
      />
      {props.plan.reason && <div className="small muted mt-1">{props.plan.reason}</div>}
      {props.plan.warnings.length > 0 && (
        <Callout kind="warn" title="恢复方案警告">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {props.plan.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  )
}

export function AgentPlanCard(props: { plan: AgentPlan }): ReactNode {
  const { plan } = props
  return (
    <div className="intel-plan">
      <div className="row wrap mb-1">
        <ListChecks size={14} />
        <span className="strong">执行计划</span>
        <RiskBadge risk={plan.risk} />
        {plan.requiresApproval && <span className="badge danger">需要人工审批</span>}
      </div>
      <div className="intel-step-text">{plan.summary || '（无摘要）'}</div>
      {plan.steps.length > 0 && (
        <div className="mt-2">
          <div className="intel-step-label">计划步骤</div>
          <ol className="small" style={{ margin: '2px 0 0', paddingLeft: 18 }}>
            {plan.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </div>
      )}
      <div className="mt-2">
        <div className="intel-step-label">目标对象</div>
        <div className="small mono">{plan.targets.length > 0 ? plan.targets.join(', ') : '（未指定）'}</div>
      </div>
      <RecoveryPlanSummaryView plan={plan.recoveryPlan} />
      {plan.sql && <SqlBlock sql={plan.sql} title="计划包含的 SQL（执行前预览，未经批准不会执行）" short />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* approval card                                                       */
/* ------------------------------------------------------------------ */

function useCountdown(expiresAt: string): { expired: boolean; text: string } {
  const compute = (): { expired: boolean; text: string } => {
    const remain = Date.parse(expiresAt) - Date.now()
    if (!Number.isFinite(remain)) return { expired: false, text: '未知' }
    if (remain <= 0) return { expired: true, text: '已过期' }
    const seconds = Math.floor(remain / 1000)
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return { expired: false, text: minutes > 0 ? `${minutes} 分 ${rest} 秒后过期` : `${rest} 秒后过期` }
  }
  const [state, setState] = useState(compute)
  useEffect(() => {
    const timer = window.setInterval(() => setState(compute()), 1000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt])
  return state
}

const approvalKindLabel: Record<ApprovalRequest['kind'], string> = {
  execute_sql: 'SQL 写操作',
  restore: '恢复操作',
  backup_delete: '删除备份',
  run_tool: '工具调用'
}

export function AgentApprovalCard(props: {
  approval: ApprovalRequest
  busy?: boolean
  live?: boolean
  onRespond: (approved: boolean) => void
}): ReactNode {
  const { approval } = props
  const countdown = useCountdown(approval.expiresAt)
  const pending = approval.status === 'pending' && !countdown.expired
  const palette =
    approval.status === 'approved' ? 'approved' : approval.status === 'denied' || approval.status === 'expired' ? 'denied' : ''

  return (
    <div className={`intel-approval ${palette}`}>
      <div className="intel-approval-head">
        <AlertTriangle size={15} style={{ color: 'var(--warn)' }} />
        <span className="intel-approval-title">需要人工批准：{approvalKindLabel[approval.kind] ?? approval.kind}</span>
        <RiskBadge risk={approval.risk} />
        {approval.status === 'pending' && !countdown.expired && <span className="badge warn">待批准</span>}
        {approval.status === 'approved' && <span className="badge ok">已批准</span>}
        {approval.status === 'denied' && <span className="badge danger">已拒绝</span>}
        {approval.status === 'expired' && <span className="badge neutral">已过期</span>}
        <div className="spacer" />
        <span className="muted xs row" title="审批到期后自动作废">
          <Clock3 size={11} />
          {countdown.text}
        </span>
      </div>

      <div className="intel-kv-inline mb-2">
        <span>
          <span className="k">审批 ID</span> <span className="mono">{approval.id}</span>
        </span>
        <span>
          <span className="k">目标</span> {approval.targets.join(', ') || '（未指定）'}
        </span>
        <span>
          <span className="k">风险</span> {riskLabel[approval.risk]}
        </span>
      </div>

      <div className="small mb-2">{approval.summary}</div>
      <div className="small dim mb-2">{approval.impact}</div>

      {approval.sql && <SqlBlock sql={approval.sql} title="待执行的 SQL（将由主进程安全服务执行）" short />}
      <RecoveryPlanSummaryView plan={approval.recoveryPlan} />

      <div className="row wrap mt-2">
        <Button
          variant={pending ? 'primary' : 'default'}
          disabled={!pending || props.busy}
          loading={props.busy}
          onClick={() => props.onRespond(true)}
        >
          <CheckCircle2 size={13} /> 批准并继续
        </Button>
        <Button variant="danger" disabled={!pending || props.busy} onClick={() => props.onRespond(false)}>
          <Ban size={13} /> 拒绝
        </Button>
        {!props.live && props.approval.status === 'pending' && (
          <span className="muted xs">该任务当前没有活动运行实例，批准记录仍会同步到持久化审批表。</span>
        )}
        {props.approval.comment && <span className="muted xs">审批备注：{props.approval.comment}</span>}
      </div>
      {countdown.expired && approval.status === 'pending' && (
        <div className="small mt-2" style={{ color: '#ff9d9d' }}>
          审批已过期，请重新发起任务或刷新任务状态。过期审批不会被执行。
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* task metrics                                                        */
/* ------------------------------------------------------------------ */

export function AgentTaskMetrics(props: {
  task: AgentTask | null
  status?: AgentTaskStatus | null
  statusMessage?: string | null
  /** When false, metrics start collapsed (default). */
  defaultOpen?: boolean
}): ReactNode {
  const task = props.task
  const status = props.status ?? task?.status ?? null
  const [open, setOpen] = useState(Boolean(props.defaultOpen))
  if (!task && !status) return null
  const elapsed =
    task && task.createdAt
      ? (task.finishedAt ? Date.parse(task.finishedAt) : Date.now()) - Date.parse(task.createdAt)
      : null
  const budgetPct =
    task && task.contextBudget.limitChars > 0
      ? Math.min(100, Math.round((task.contextBudget.usedChars / task.contextBudget.limitChars) * 100))
      : null
  const tokenShort = task?.tokenUsage ? formatNumber(task.tokenUsage.total) : null
  const summaryBits = [
    status ? agentStatusLabel[status] : null,
    task ? `${task.stepCount}/${task.maxSteps} 步` : null,
    task ? `${task.toolCallCount} 工具` : null,
    tokenShort ? `${tokenShort} tok` : null,
    elapsed !== null ? `${(elapsed / 1000).toFixed(1)}s` : null
  ].filter(Boolean)

  return (
    <div className="codex-metrics">
      <button type="button" className="codex-metrics-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="strong small">运行指标</span>
        {!open && summaryBits.length > 0 && (
          <span className="muted xs truncate" style={{ flex: 1, textAlign: 'left' }}>
            {summaryBits.join(' · ')}
          </span>
        )}
        {task && <span className="mono xs muted">{task.id}</span>}
      </button>
      {open && (
        <div className="codex-metrics-body">
          <div className="intel-meta-grid">
            <div>
              <span className="k">状态</span>
              <span className="v">
                {status ? <span className={agentStatusClass[status]}>{agentStatusLabel[status]}</span> : '—'}
              </span>
            </div>
            <div>
              <span className="k">步数</span>
              <span className="v intel-num">{task ? `${task.stepCount} / ${task.maxSteps}` : '—'}</span>
            </div>
            <div>
              <span className="k">工具调用</span>
              <span className="v intel-num">{task ? task.toolCallCount : '—'}</span>
            </div>
            <div>
              <span className="k">Token 用量</span>
              <span className="v intel-num">
                {task?.tokenUsage
                  ? `${formatNumber(task.tokenUsage.total)}（输入 ${formatNumber(task.tokenUsage.prompt)} / 输出 ${formatNumber(
                      task.tokenUsage.completion
                    )}）`
                  : '—'}
              </span>
            </div>
            <div>
              <span className="k">耗时</span>
              <span className="v intel-num">{elapsed !== null ? `${(elapsed / 1000).toFixed(1)} s` : '—'}</span>
            </div>
            <div>
              <span className="k">上下文预算</span>
              <span className="v intel-num">
                {task
                  ? `${formatNumber(task.contextBudget.usedChars)} / ${formatNumber(task.contextBudget.limitChars)} 字符`
                  : '—'}
                {budgetPct !== null && <span className="muted"> （{budgetPct}%）</span>}
              </span>
            </div>
          </div>
          {props.statusMessage && <div className="small muted mt-1">状态说明：{props.statusMessage}</div>}
          {task?.finishedAt && (
            <div className="small muted mt-1">
              结束时间：{new Date(task.finishedAt).toLocaleString('zh-CN')} · 模型配置{' '}
              {task.modelProfileId ? <span className="mono">{task.modelProfileId}</span> : '默认'}
              {task.decisionModelProfileId && (
                <>
                  {' '}
                  · JEV <span className="mono">{task.decisionModelProfileId}</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Codex-style transcript                                              */
/* ------------------------------------------------------------------ */

export function AgentThinkingPanel(props: {
  steps: AgentStep[]
  plan: AgentPlan | null
  streamText: string
  live: boolean
  hasFinalAnswer: boolean
}): ReactNode {
  const { steps, plan, streamText, live, hasFinalAnswer } = props
  const processSteps = steps.filter((s) => s.phase !== 'final')
  const showStreamInThinking = Boolean(streamText) && (!hasFinalAnswer || live)
  const hasContent = processSteps.length > 0 || Boolean(plan) || showStreamInThinking
  // Keep collapsed by default — live work still shows in the title row.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (hasFinalAnswer) setOpen(false)
  }, [hasFinalAnswer])

  if (!hasContent) return null

  const title = live
    ? `思考中…（${processSteps.length || '…'} 步，默认收起）`
    : processSteps.length > 0
      ? `思考过程（${processSteps.length} 步）`
      : '思考过程'

  return (
    <div className={`codex-thinking ${live ? 'live' : ''}`}>
      <button type="button" className="codex-thinking-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <CircleDashed
          size={14}
          style={live ? { color: 'var(--accent)', animation: 'spin 1.6s linear infinite' } : { color: 'var(--text-muted)' }}
        />
        <span className="codex-thinking-title">{title}</span>
        {live && <span className="spinner" />}
        <span className="muted xs" style={{ marginLeft: 'auto' }}>
          {open ? '收起' : '展开'}
        </span>
      </button>
      {open && (
        <div className="codex-thinking-body">
          {plan && <AgentPlanCard plan={plan} />}
          {showStreamInThinking && !hasFinalAnswer && (
            <div className="codex-stream-scratch">
              <div className="intel-step-label">模型流式输出</div>
              <MarkdownView content={streamText} plainCode={live} />
            </div>
          )}
          {processSteps.length > 0 && (
            <div className="intel-timeline">
              {processSteps.map((step) => (
                <AgentStepCard
                  key={`${step.index}-${step.phase}-${step.toolName ?? 'step'}`}
                  step={step}
                  defaultOpen={step.writeOperation || step.status === 'failed' || (live && step.status === 'running')}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function AgentAnswerBubble(props: {
  content: string
  live?: boolean
  failed?: boolean
}): ReactNode {
  if (!props.content && !props.live) return null
  return (
    <div className={`codex-answer ${props.failed ? 'error' : ''}`}>
      <div className="codex-answer-who">
        <span>AI 回答</span>
        <span className="muted xs">（不可信内容）</span>
        {props.live && <span className="spinner" style={{ marginLeft: 6 }} />}
      </div>
      {props.content ? (
        <MarkdownView content={props.content} plainCode={props.live} />
      ) : (
        <div className="muted small">正在生成…</div>
      )}
    </div>
  )
}

export function TaskStatusDot(props: { status: AgentTaskStatus }): ReactNode {
  if (isFinalStatus(props.status)) {
    return props.status === 'completed' ? (
      <CheckCircle2 size={13} style={{ color: 'var(--ok)' }} />
    ) : (
      <XCircle size={13} style={{ color: 'var(--danger)' }} />
    )
  }
  if (props.status === 'awaiting_approval') return <AlertTriangle size={13} style={{ color: 'var(--warn)' }} />
  if (props.status === 'executing' || props.status === 'planning' || props.status === 'verifying')
    return <CircleDashed size={13} style={{ color: 'var(--accent)', animation: 'spin 1.6s linear infinite' }} />
  return <CircleDashed size={13} style={{ color: 'var(--text-muted)' }} />
}

export function riskOf(risk: RiskLevel | null | undefined): RiskLevel {
  return risk ?? 'none'
}
