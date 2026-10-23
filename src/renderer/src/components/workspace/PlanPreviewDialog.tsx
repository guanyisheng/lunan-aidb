import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { RecoveryStrategy, SqlPlan, StatementRisk } from '@shared/types'
import { formatDate, kindLabel, riskLabel } from '../../lib/format'
import { Badge, Button, Callout, Checkbox, Modal, RiskBadge } from '../ui'
import './workspace.css'

export interface PlanPreviewDialogProps {
  plan: SqlPlan | null
  open: boolean
  /** True while approve/execute is running; the dialog cannot be dismissed. */
  busy: boolean
  /** Close without executing: deny (when approval was required) and return. */
  onCancel: () => void
  /**
   * User confirmed. The parent MUST still run approval.approve (when needed)
   * before sql.execute — the dialog itself NEVER executes SQL.
   */
  onConfirm: (comment: string) => void
}

const strategyLabel: Record<RecoveryStrategy, string> = {
  none: '无恢复策略（不可自动回滚）',
  before_image: '变更前镜像（行级恢复）',
  schema_snapshot: '结构快照（DDL 恢复参考）',
  full_backup: '完整备份',
  refuse_unsafe: '拒绝执行（无法安全保护）'
}

const strategyNote: Record<RecoveryStrategy, string> = {
  none: '恢复计划为空。该操作执行后无法通过时间机器保证回滚，请谨慎确认。',
  before_image: '执行前捕获受影响行的前镜像；恢复时会检查冲突，已发生新变更的行不会被静默覆盖。',
  schema_snapshot: 'MySQL 的 DDL 会隐式提交，事务回滚无法撤销；恢复依赖独立的结构快照，需人工确认后执行。',
  full_backup: '执行前创建完整备份；备份失败时服务层会拒绝继续执行危险语句。',
  refuse_unsafe: '服务层判定该操作无法可靠保护，将拒绝执行或要求更严格的保护措施。'
}

function StatementItem(props: { statement: StatementRisk }): ReactNode {
  const statement = props.statement
  return (
    <div className="statement-item">
      <div className="row wrap">
        <Badge className="badge neutral">#{statement.statementIndex + 1}</Badge>
        <span className="strong">{kindLabel[statement.kind] ?? statement.kind}</span>
        <RiskBadge risk={statement.risk} />
        <Badge className="badge neutral">{statement.category}</Badge>
        {statement.requiresApproval && <Badge className="badge warn">需审批</Badge>}
        {statement.requiresBackup && <Badge className="badge danger">需备份</Badge>}
        {statement.implicitCommit && <Badge className="badge warn">隐式提交</Badge>}
        <span className="spacer" />
        <span className="muted xs">
          预计影响：{statement.estimatedRows === null ? '未知' : `${statement.estimatedRows} 行`}
        </span>
      </div>
      <div className="stmt-sql">{statement.sql}</div>
      {statement.targetTables.length > 0 && (
        <div className="chip-list mt-1">
          {statement.targetTables.map((table) => (
            <span key={table} className="chip">
              {table}
            </span>
          ))}
        </div>
      )}
      {statement.reasons.length > 0 && (
        <div className="small muted mt-1">判定依据：{statement.reasons.join('；')}</div>
      )}
      {statement.parseError && (
        <div className="small mt-1" style={{ color: '#ffc76b' }}>
          解析回退：{statement.parseError}
        </div>
      )}
      {statement.unbounded && (
        <div className="small mt-1" style={{ color: '#ffc76b' }}>
          该语句没有 LIMIT，可能影响大量行。
        </div>
      )}
    </div>
  )
}

/**
 * Mandatory plan preview between `sql.plan` and `sql.execute`.
 *
 * Security-critical: this component only collects the user's decision. The
 * write path (approval.approve -> sql.execute) lives in WorkspacePage and the
 * trusted main process re-validates the approval status and plan hash.
 */
export function PlanPreviewDialog(props: PlanPreviewDialogProps): ReactNode {
  const [acknowledged, setAcknowledged] = useState(false)
  const [comment, setComment] = useState('')
  const plan = props.plan

  useEffect(() => {
    setAcknowledged(false)
    setComment('')
  }, [props.open, plan?.planId])

  if (!plan) return null

  const readOnly = plan.analysis.readOnly
  const recovery = plan.recoveryPlan
  const severe = plan.analysis.overallRisk === 'high' || plan.analysis.overallRisk === 'critical'
  const canConfirm = readOnly || acknowledged

  return (
    <Modal
      open={props.open}
      wide
      title="执行计划预览"
      onClose={() => {
        if (!props.busy) props.onCancel()
      }}
      footer={
        <>
          <span className="muted small">
            planId：<span className="mono">{plan.planId}</span>
          </span>
          <span className="spacer" />
          <Button variant="ghost" onClick={props.onCancel} disabled={props.busy}>
            {readOnly ? '取消' : '拒绝'}
          </Button>
          <Button
            variant={readOnly ? 'primary' : severe ? 'danger' : 'primary'}
            onClick={() => props.onConfirm(comment.trim())}
            loading={props.busy}
            disabled={!canConfirm}
            title={!canConfirm ? '请先勾选确认已理解风险与恢复策略' : undefined}
          >
            {readOnly ? '直接执行' : '批准并执行'}
          </Button>
        </>
      }
    >
      {readOnly ? (
        <Callout kind="info" title="只读查询">
          本次计划只包含只读语句，不需要单独授权；确认后直接执行。
        </Callout>
      ) : (
        <Callout
          kind={severe ? 'danger' : 'warn'}
          title={`写操作 · 需要你明确授权（风险：${riskLabel[plan.analysis.overallRisk]}）`}
        >
          执行前请核对目标表、影响范围与恢复策略。服务端会再次校验授权状态与计划哈希，界面无法绕过该流程。
        </Callout>
      )}

      <div className="mt-3" />

      <div className="plan-grid">
        <div className="stat-tile">
          <div className="stat-label">语句数</div>
          <div className="stat-value">{plan.impact.statementCount}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">风险等级</div>
          <div className="stat-value">
            <RiskBadge risk={plan.analysis.overallRisk} />
          </div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">预计影响行数</div>
          <div className="stat-value">{plan.impact.estimatedRows === null ? '未知' : `${plan.impact.estimatedRows} 行`}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">执行前需备份</div>
          <div className="stat-value">{plan.requiresBackup ? '是（备份失败则拒绝执行）' : '否'}</div>
        </div>
      </div>

      <div className="mt-3">
        <div className="ws-section-title">目标表</div>
        {plan.impact.affectedTables.length > 0 ? (
          <div className="chip-list">
            {plan.impact.affectedTables.map((table) => (
              <span key={table} className="chip">
                {table}
              </span>
            ))}
          </div>
        ) : (
          <div className="muted small">未能识别目标表（可能为动态 SQL 或语法解析回退）。</div>
        )}
      </div>

      <div className="mt-3">
        <div className="ws-section-title">恢复计划</div>
        <div className={`recovery-card ${recovery.strategy === 'none' || recovery.strategy === 'refuse_unsafe' ? 'unsafe' : ''}`}>
          <div className="row wrap">
            <span className="strong">{strategyLabel[recovery.strategy]}</span>
            {recovery.needsBackup ? <Badge className="badge danger">需要备份</Badge> : <Badge className="badge neutral">无需备份</Badge>}
            {recovery.beforeImageSupported && <Badge className="badge ok">支持前镜像</Badge>}
          </div>
          <div className="small mt-1">{strategyNote[recovery.strategy]}</div>
          <div className="small dim mt-1">
            服务端说明：<span className="pre-wrap">{recovery.reason || '—'}</span>
          </div>
          <div className="small muted mt-1">
            预计受影响行数：{recovery.estimatedAffectedRows === null ? '未知' : `${recovery.estimatedAffectedRows} 行`}
            {recovery.backupScope ? ` · 备份范围：${recovery.backupScope === 'database' ? '整库' : '指定表'}` : ''}
            {recovery.backupTables && recovery.backupTables.length > 0 ? `（${recovery.backupTables.join('、')}）` : ''}
          </div>
          {recovery.warnings.length > 0 && (
            <ul className="warn-list">
              {recovery.warnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-3">
        <div className="ws-section-title">逐条语句（{plan.analysis.statements.length}）</div>
        <div className="statement-list">
          {plan.analysis.statements.map((statement) => (
            <StatementItem key={statement.statementIndex} statement={statement} />
          ))}
        </div>
      </div>

      <div className="mt-3">
        <details>
          <summary className="small pointer" style={{ color: 'var(--text-dim)' }}>
            查看将执行的完整 SQL
          </summary>
          <div className="plan-sql mt-1">{plan.sql}</div>
        </details>
      </div>

      <div className="small muted mt-2">
        数据库：<span className="mono">{plan.database}</span> · 计划创建于 {formatDate(plan.createdAt)} · 有效期至{' '}
        {formatDate(plan.expiresAt)}（过期需重新预览）
      </div>

      {!readOnly && (
        <div className="approve-guard">
          <Checkbox
            checked={acknowledged}
            onChange={setAcknowledged}
            label="我已阅读并理解上述风险、影响范围和恢复策略，确认执行"
          />
          <div className="mt-1">
            <textarea
              className="textarea"
              rows={2}
              value={comment}
              placeholder="审批备注（可选，会写入审计记录）"
              onChange={(event) => setComment(event.target.value)}
            />
          </div>
        </div>
      )}
    </Modal>
  )
}
