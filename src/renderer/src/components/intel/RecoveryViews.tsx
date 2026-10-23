import { useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  FileWarning,
  FolderOpen,
  ShieldAlert,
  XCircle
} from 'lucide-react'
import type {
  BackupRecord,
  BackupStatus,
  RestoreConflict,
  RestoreJob,
  RestoreJobStatus,
  RestorePreview,
  RestoreStep,
  UndoChangeSet,
  UndoPreview
} from '@shared/types'
import { backupStatusLabel } from '../../lib/format'
import { Badge, Callout, ProgressBar } from '../ui'
import { formatBytes, formatDate, formatDuration } from '../../lib/format'
import { CoverageBadges, MetaGrid, SqlBlock, formatNumber, JsonBlock, RiskStrip } from './IntelCommon'

/* ------------------------------------------------------------------ */
/* badges / labels                                                     */
/* ------------------------------------------------------------------ */

export const restoreJobStatusLabel: Record<RestoreJobStatus, string> = {
  preparing: '准备中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  partial: '部分完成',
  cancelled: '已取消'
}

export const restoreJobStatusClass: Record<RestoreJobStatus, string> = {
  preparing: 'badge accent',
  running: 'badge accent',
  completed: 'badge ok',
  failed: 'badge danger',
  partial: 'badge warn',
  cancelled: 'badge neutral'
}

export const backupStatusClass: Record<BackupStatus, string> = {
  creating: 'badge accent',
  completed: 'badge neutral',
  verified: 'badge ok',
  restore_tested: 'badge ok',
  failed: 'badge danger',
  deleted: 'badge neutral'
}

export const restoreModeLabel: Record<RestoreJob['mode'], string> = {
  to_temp_database: '恢复到临时库（安全路径）',
  in_place: '原地恢复（高风险）',
  undo_last: '撤销最近变更'
}

export function BackupStatusBadge(props: { status: BackupStatus }): ReactNode {
  return <span className={backupStatusClass[props.status]}>{backupStatusLabel[props.status]}</span>
}

export function RestoreJobStatusBadge(props: { status: RestoreJobStatus }): ReactNode {
  return <span className={restoreJobStatusClass[props.status]}>{restoreJobStatusLabel[props.status]}</span>
}

const operationLabel: Record<UndoChangeSet['operation'], string> = {
  insert: '插入（撤销=删除）',
  update: '更新（撤销=还原前镜像）',
  delete: '删除（撤销=重新插入）'
}

export const conflictKindLabel: Record<RestoreConflict['kind'], string> = {
  row_changed_since_recovery: '记录在恢复点之后被修改',
  row_missing: '记录已不存在',
  row_added: '主键已被新记录占用',
  duplicate_key: '主键冲突'
}

/* ------------------------------------------------------------------ */
/* conflicts                                                           */
/* ------------------------------------------------------------------ */

export function ConflictTable(props: { conflicts: RestoreConflict[] }): ReactNode {
  if (props.conflicts.length === 0) {
    return <div className="small muted">未检测到冲突。</div>
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>表</th>
            <th>冲突类型</th>
            <th>主键</th>
            <th>说明 / 当前值</th>
          </tr>
        </thead>
        <tbody>
          {props.conflicts.map((conflict, index) => (
            <tr key={index}>
              <td className="mono">{conflict.table}</td>
              <td>
                <span className="badge danger">{conflictKindLabel[conflict.kind] ?? conflict.kind}</span>
              </td>
              <td className="mono xs">{JSON.stringify(conflict.primaryKey)}</td>
              <td className="xs">
                {conflict.message && <div>{conflict.message}</div>}
                {conflict.currentValue && <div className="muted mono">当前：{JSON.stringify(conflict.currentValue).slice(0, 240)}</div>}
                {conflict.recoveryValue && (
                  <div className="muted mono">恢复点：{JSON.stringify(conflict.recoveryValue).slice(0, 240)}</div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* restore job panel                                                   */
/* ------------------------------------------------------------------ */

function StepIcon(props: { status: RestoreStep['status'] }): ReactNode {
  if (props.status === 'ok') return <CheckCircle2 size={13} style={{ color: 'var(--ok)' }} />
  if (props.status === 'failed') return <XCircle size={13} style={{ color: 'var(--danger)' }} />
  if (props.status === 'running') return <CircleDashed size={13} style={{ color: 'var(--accent)', animation: 'spin 1.4s linear infinite' }} />
  if (props.status === 'skipped') return <span className="muted xs">—</span>
  return <CircleDashed size={13} style={{ color: 'var(--text-muted)' }} />
}

export function RestoreJobPanel(props: { job: RestoreJob; onShowPath?: (path: string) => void }): ReactNode {
  const { job } = props
  const [conflictsOpen, setConflictsOpen] = useState(job.conflicts.length > 0)

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row wrap">
        <span className="strong">恢复任务</span>
        <span className="mono small">{job.id}</span>
        <RestoreJobStatusBadge status={job.status} />
        {job.mayBePartial && (
          <span className="badge danger">
            <ShieldAlert size={10} /> 可能处于部分恢复状态
          </span>
        )}
        <div className="spacer" />
        {job.logPath && props.onShowPath && (
          <button type="button" className="btn ghost sm" onClick={() => props.onShowPath?.(job.logPath as string)} title={job.logPath}>
            <FolderOpen size={12} /> 打开日志位置
          </button>
        )}
      </div>

      <MetaGrid
        items={[
          { k: '模式', v: restoreModeLabel[job.mode] },
          { k: '源数据库', v: <span className="mono">{job.sourceDatabase || '—'}</span> },
          { k: '目标数据库', v: <span className="mono">{job.targetDatabase || '—'}</span> },
          { k: '临时库', v: job.tempDatabase ? <span className="mono">{job.tempDatabase}</span> : '—' },
          { k: '开始时间', v: formatDate(job.startedAt) },
          { k: '结束时间', v: formatDate(job.finishedAt) },
          { k: '进度', v: `${Math.round(Math.max(0, Math.min(1, job.progress)) * 100)}%` }
        ]}
      />

      {job.status === 'running' || job.status === 'preparing' ? (
        <ProgressBar value={job.progress} label="恢复进行中" />
      ) : null}

      {job.error && (
        <Callout kind="danger" title="恢复失败原因">
          {job.error}
          {job.mayBePartial && (
            <div className="mt-1 strong">
              警告：恢复在失败前可能已写入部分数据，当前数据库可能处于部分恢复状态。请在临时库验证或人工核对后再继续操作。
            </div>
          )}
        </Callout>
      )}

      {job.steps.length > 0 && (
        <div>
          <div className="intel-step-label mb-1">执行步骤</div>
          <div className="col" style={{ gap: 3 }}>
            {job.steps.map((step) => (
              <div key={step.index} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <StepIcon status={step.status} />
                <div className="grow">
                  <div className="small">
                    {step.index + 1}. {step.title}{' '}
                    <span className="muted xs">
                      {step.status === 'ok'
                        ? '完成'
                        : step.status === 'failed'
                          ? '失败'
                          : step.status === 'running'
                            ? '进行中'
                            : step.status === 'skipped'
                              ? '已跳过'
                              : '等待'}
                    </span>
                  </div>
                  {step.detail && <div className="muted xs pre-wrap">{step.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {job.verification && (
        <div>
          <div className="intel-step-label mb-1">恢复验证</div>
          <div className="small">
            <span className={job.verification.passed ? 'badge ok' : 'badge danger'}>
              {job.verification.passed ? '验证通过' : '验证未通过'}
            </span>{' '}
            表数量 {job.verification.tablesRestored}，行匹配{' '}
            {job.verification.rowsMatched === null ? '未知' : job.verification.rowsMatched ? '是' : '否'}
          </div>
          {job.verification.notes.length > 0 && (
            <ul className="small muted" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {job.verification.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <button type="button" className="btn ghost sm" onClick={() => setConflictsOpen((value) => !value)}>
          {conflictsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 冲突（{job.conflicts.length}）
        </button>
        {conflictsOpen && (
          <div className="mt-1">
            <ConflictTable conflicts={job.conflicts} />
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* undo preview                                                        */
/* ------------------------------------------------------------------ */

function ChangeSetRow(props: { changeSet: UndoChangeSet }): ReactNode {
  const [open, setOpen] = useState(false)
  const totalRows = props.changeSet.rows.length
  return (
    <div className="intel-row-card" style={{ marginTop: 0 }}>
      <div className="intel-row-head">
        <span className="mono small strong">{props.changeSet.table}</span>
        <span className="badge neutral">{operationLabel[props.changeSet.operation]}</span>
        <span className="small muted">
          影响 {formatNumber(totalRows)} 行 · 主键 {props.changeSet.primaryKeyColumns.join(', ') || '（无）'}
        </span>
        {props.changeSet.canApply ? <span className="badge ok">可撤销</span> : <span className="badge danger">已阻止</span>}
        <div className="spacer" />
        <button type="button" className="btn ghost sm" onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} 行明细
        </button>
      </div>
      {props.changeSet.blockedReason && <div className="small mt-1" style={{ color: '#ff9d9d' }}>{props.changeSet.blockedReason}</div>}
      {open && (
        <div className="mt-2 col" style={{ gap: 6 }}>
          {props.changeSet.rows.length === 0 && <div className="small muted">没有可展示的行。</div>}
          {props.changeSet.rows.map((row, index) => (
            <div key={index} className="col" style={{ gap: 3 }}>
              <div className="mono xs">主键 {JSON.stringify(row.primaryKey)}</div>
              {row.before && (
                <div className="xs">
                  <span className="muted">前镜像：</span>
                  <span className="mono">{JSON.stringify(row.before).slice(0, 400)}</span>
                </div>
              )}
              {row.after && (
                <div className="xs">
                  <span className="muted">后镜像：</span>
                  <span className="mono">{JSON.stringify(row.after).slice(0, 400)}</span>
                </div>
              )}
              {row.conflicts.length > 0 && (
                <div className="xs" style={{ color: '#ffc76b' }}>
                  行冲突：{row.conflicts.map((conflict) => conflictKindLabel[conflict.kind] ?? conflict.kind).join('；')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function UndoPreviewView(props: { preview: UndoPreview }): ReactNode {
  const { preview } = props
  return (
    <div className="col" style={{ gap: 10 }}>
      {preview.warnings.length > 0 && (
        <Callout kind="warn" title="撤销警告">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {preview.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Callout>
      )}

      <div>
        <div className="intel-step-label mb-1">恢复点覆盖状态</div>
        <CoverageBadges point={preview.recoveryPoint} />
        <div className="small muted mt-1">
          该恢复点是否可用于撤销，取决于是否保存了变更前镜像；仅有操作日志时无法反向恢复数据。
        </div>
      </div>

      <div className="row wrap">
        <span className={preview.canUndo ? 'badge ok' : 'badge danger'}>
          {preview.canUndo ? '可以撤销' : '存在阻塞项，无法撤销'}
        </span>
        {preview.requiresApproval && <span className="badge warn">撤销需要人工审批</span>}
        <span className="small muted">变更集 {preview.changeSets.length} 个 · 冲突 {preview.conflicts.length} 个</span>
      </div>

      <div>
        <div className="intel-step-label mb-1">变更集（表 / 操作 / 行数）</div>
        {preview.changeSets.length === 0 ? (
          <div className="small muted">该恢复点没有可撤销的变更集。</div>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            {preview.changeSets.map((changeSet, index) => (
              <ChangeSetRow key={index} changeSet={changeSet} />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="intel-step-label mb-1">冲突列表（存在冲突时不会自动覆盖新数据）</div>
        <ConflictTable conflicts={preview.conflicts} />
      </div>

      <SqlBlock sql={preview.sqlPreview} title="撤销 SQL 预览（由主进程生成，仅供参考）" tall />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* restore preview                                                     */
/* ------------------------------------------------------------------ */

export function RestorePreviewView(props: { preview: RestorePreview }): ReactNode {
  const { preview } = props
  return (
    <div className="col" style={{ gap: 10 }}>
      <MetaGrid
        items={[
          { k: '来源类型', v: preview.source.kind === 'backup' ? '备份文件' : '恢复点' },
          { k: '来源数据库', v: <span className="mono">{preview.source.database}</span> },
          { k: '来源时间', v: formatDate(preview.source.createdAt) },
          { k: '来源已验证', v: preview.source.verified ? '是' : '否' },
          { k: '恢复模式', v: preview.mode === 'to_temp_database' ? '恢复到临时库' : '原地恢复' },
          { k: '目标数据库', v: <span className="mono">{preview.targetDatabase}</span> },
          { k: '临时库名', v: preview.tempDatabase ? <span className="mono">{preview.tempDatabase}</span> : '—' },
          {
            k: 'Schema 兼容',
            v: preview.schemaCompatible ? <span className="badge ok">兼容</span> : <span className="badge danger">不兼容</span>
          }
        ]}
      />

      {preview.mode === 'in_place' && (
        <RiskStrip danger={preview.overwriteRisk === 'high'}>
          <ShieldAlert size={14} />
          <span>
            原地恢复会覆盖目标数据库
            {preview.targetDatabase ? `「${preview.targetDatabase}」` : ''}中的现有数据，可能丢失恢复点之后写入的新数据。默认请优先恢复到临时库验证。
          </span>
        </RiskStrip>
      )}

      {preview.schemaIssues.length > 0 && (
        <Callout kind="danger" title="Schema 问题">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {preview.schemaIssues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </Callout>
      )}

      {preview.objectConflicts.length > 0 && (
        <div>
          <div className="intel-step-label mb-1">对象冲突</div>
          <div className="small">
            {preview.objectConflicts.map((conflict, index) => (
              <span className="intel-tag" key={index}>
                {conflict}
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="intel-step-label mb-1">覆盖风险与数据丢失估算</div>
        <div className="row wrap mb-1">
          <span className="intel-kv-inline">
            <span>
              <span className="k">覆盖风险</span>{' '}
              <span
                className={`badge ${
                  preview.overwriteRisk === 'high' ? 'danger' : preview.overwriteRisk === 'low' ? 'warn' : 'neutral'
                }`}
              >
                {preview.overwriteRisk === 'high' ? '高' : preview.overwriteRisk === 'low' ? '低' : '无'}
              </span>
            </span>
          </span>
        </div>
        {preview.lossEstimate.length === 0 ? (
          <div className="small muted">未估算到新数据丢失。</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>表</th>
                  <th>可能丢失行数</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {preview.lossEstimate.map((loss, index) => (
                  <tr key={index}>
                    <td className="mono">{loss.table}</td>
                    <td className="intel-num">{loss.rowsAtRisk === null ? '未知' : formatNumber(loss.rowsAtRisk)}</td>
                    <td className="small">{loss.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {preview.warnings.length > 0 && (
        <Callout kind="warn" title="恢复警告">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {preview.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Callout>
      )}

      <div>
        <div className="intel-step-label mb-1">恢复步骤</div>
        <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {preview.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      </div>

      {preview.requiresApproval && (
        <div className="small" style={{ color: '#ffc76b' }}>
          <AlertTriangle size={12} style={{ verticalAlign: -1 }} /> 该恢复操作需要人工审批；批准后仍需用户显式确认才能执行。
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* backup helpers                                                      */
/* ------------------------------------------------------------------ */

export function BackupVerificationView(props: { record: BackupRecord; onShowPath?: (path: string) => void }): ReactNode {
  const v = props.record.verification
  const items = [
    { label: '文件存在', ok: v.fileExists },
    { label: '文件非空', ok: v.nonEmpty },
    { label: '校验和一致', ok: v.checksumOk },
    { label: '结构有效', ok: v.structureOk },
    { label: '包含行数据', ok: v.rowDataPresent }
  ]
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row wrap">
        {items.map((item) => (
          <span key={item.label} className={item.ok ? 'badge ok' : 'badge danger'}>
            {item.label}
          </span>
        ))}
        {v.tableCount !== null && <Badge className="badge neutral">表数量 {v.tableCount}</Badge>}
      </div>
      <MetaGrid
        items={[
          { k: '校验时间', v: formatDate(v.verifiedAt) },
          { k: '恢复测试时间', v: formatDate(v.restoreTestedAt) },
          { k: '恢复测试临时库', v: v.tempDatabase ? <span className="mono">{v.tempDatabase}</span> : '—' }
        ]}
      />
      {v.notes.length > 0 && (
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          {v.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
      <div className="row wrap small muted">
        <span>
          文件大小 {formatBytes(props.record.fileSize)} · 校验和{' '}
          <span className="mono xs">{props.record.checksumSha256.slice(0, 16)}…</span>
        </span>
        {props.onShowPath && (
          <button type="button" className="btn ghost sm" onClick={() => props.onShowPath?.(props.record.filePath)} title={props.record.filePath}>
            <FolderOpen size={12} /> 打开文件位置
          </button>
        )}
      </div>
      {props.record.error && (
        <Callout kind="danger" title="备份错误">
          {props.record.error}
        </Callout>
      )}
    </div>
  )
}

export function BackupMetaView(props: { record: BackupRecord }): ReactNode {
  const record = props.record
  return (
    <MetaGrid
      items={[
        { k: '数据库', v: <span className="mono">{record.database}</span> },
        { k: '范围', v: record.scope === 'database' ? '整库' : `指定表（${record.tables.length}）` },
        { k: '类型', v: record.type },
        { k: '工具', v: record.tool },
        { k: '文件大小', v: formatBytes(record.fileSize) },
        { k: '创建时间', v: formatDate(record.createdAt) },
        { k: '完成时间', v: formatDate(record.completedAt) },
        { k: '保留至', v: formatDate(record.retentionUntil) },
        { k: '被恢复点引用', v: record.referencedByRecoveryPoints > 0 ? `${record.referencedByRecoveryPoints} 次` : '无' }
      ]}
    />
  )
}

export function BackupFileView(props: { record: BackupRecord }): ReactNode {
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="mono xs intel-select-all" title={props.record.filePath}>
        {props.record.filePath}
      </div>
      <div className="small muted">
        校验和 SHA-256 <span className="mono xs">{props.record.checksumSha256}</span>
      </div>
    </div>
  )
}

export function stepsSummary(steps: RestoreStep[]): string {
  const done = steps.filter((step) => step.status === 'ok').length
  return `${done}/${steps.length}`
}

function JobCard(props: { job: RestoreJob; onClick: () => void; selected: boolean }): ReactNode {
  return (
    <button
      type="button"
      className={`intel-list-item ${props.selected ? 'active' : ''}`}
      style={{ textAlign: 'left', width: '100%' }}
      onClick={props.onClick}
    >
      <div className="row between">
        <span className="title truncate">{restoreModeLabel[props.job.mode]}</span>
        <RestoreJobStatusBadge status={props.job.status} />
      </div>
      <div className="meta">
        {formatDate(props.job.startedAt)} · {props.job.sourceDatabase} → {props.job.tempDatabase ?? props.job.targetDatabase} · 步骤{' '}
        {stepsSummary(props.job.steps)}
      </div>
      {props.job.mayBePartial && (
        <div className="meta" style={{ color: '#ff9d9d' }}>
          <FileWarning size={10} style={{ verticalAlign: -1 }} /> 可能处于部分恢复状态
        </div>
      )}
    </button>
  )
}

export function RestoreJobList(props: {
  jobs: RestoreJob[]
  selectedId: string | null
  onSelect: (job: RestoreJob) => void
}): ReactNode {
  if (props.jobs.length === 0) {
    return <div className="intel-empty-hint">暂无恢复任务记录。</div>
  }
  return (
    <div className="intel-list">
      {props.jobs.map((job) => (
        <JobCard key={job.id} job={job} selected={props.selectedId === job.id} onClick={() => props.onSelect(job)} />
      ))}
    </div>
  )
}

export function jobDuration(job: RestoreJob): string {
  if (!job.finishedAt) return '进行中'
  return formatDuration(Date.parse(job.finishedAt) - Date.parse(job.startedAt))
}

export function ConflictCount(props: { count: number }): ReactNode {
  if (props.count === 0) return <span className="muted small">无冲突</span>
  return <span className="badge danger">{props.count} 个冲突</span>
}

export function JsonPeek(props: { label: string; value: unknown }): ReactNode {
  return (
    <div>
      <div className="intel-step-label">{props.label}</div>
      <JsonBlock value={props.value} />
    </div>
  )
}
