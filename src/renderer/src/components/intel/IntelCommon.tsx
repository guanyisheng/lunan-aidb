import './intel.css'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Copy, Info, RefreshCw, ShieldAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { RecoveryPoint } from '@shared/types'
import { errorMessage } from '../../lib/store'
import { safeJson } from '../../lib/format'

/* ------------------------------------------------------------------ */
/* async loading helper                                                */
/* ------------------------------------------------------------------ */

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: unknown
  reload: () => void
  setData: (value: T | null) => void
}

/** Loads data on mount / dependency change; exposes reload + soft setData. */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((value) => value + 1), [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    loader()
      .then((value) => {
        if (!alive) return
        setData(value)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setData(null)
        setError(e)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const softSet = useCallback((value: T | null) => setData(value), [])
  return { data, loading, error, reload, setData: softSet }
}

export function errText(e: unknown): string {
  return errorMessage(e)
}

/* ------------------------------------------------------------------ */
/* small building blocks                                               */
/* ------------------------------------------------------------------ */

export function SectionTitle(props: { children: ReactNode; icon?: ReactNode; extra?: ReactNode }): ReactNode {
  return (
    <div className="intel-section-title">
      {props.icon}
      <span>{props.children}</span>
      {props.extra && <div className="spacer" />}
      {props.extra}
    </div>
  )
}

export function StatCard(props: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: 'none' | 'ok' | 'warn' | 'danger' | 'accent'
}): ReactNode {
  return (
    <div className={`intel-stat ${props.tone && props.tone !== 'none' ? `tone-${props.tone}` : ''}`}>
      <div className="intel-stat-label">{props.label}</div>
      <div className="intel-stat-value">{props.value}</div>
      {props.hint !== undefined && <div className="intel-stat-hint">{props.hint}</div>}
    </div>
  )
}

export function MetaGrid(props: { items: { k: ReactNode; v: ReactNode }[] }): ReactNode {
  return (
    <div className="intel-meta-grid">
      {props.items.map((item, index) => (
        <div key={index} className="intel-meta-cell">
          <span className="k">{item.k}</span>
          <span className="v">{item.v}</span>
        </div>
      ))}
    </div>
  )
}

export function Tags(props: { items: string[] }): ReactNode {
  if (props.items.length === 0) return <span className="muted small">无标签</span>
  return (
    <div>
      {props.items.map((tag) => (
        <span className="intel-tag" key={tag}>
          {tag}
        </span>
      ))}
    </div>
  )
}

export function WarnBanner(props: { kind?: 'warn' | 'danger' | 'info'; children: ReactNode; icon?: ReactNode }): ReactNode {
  const Icon: LucideIcon = (props.icon ??
    (props.kind === 'danger' ? ShieldAlert : props.kind === 'info' ? Info : AlertTriangle)) as LucideIcon
  return (
    <div className={`intel-banner ${props.kind ?? 'warn'}`}>
      <Icon size={15} className="intel-banner-icon" />
      <div>{props.children}</div>
    </div>
  )
}

export function ErrorLine(props: { error: unknown; title?: string }): ReactNode {
  return (
    <div className="callout danger" style={{ marginTop: 8 }}>
      <div className="strong mb-1">{props.title ?? '操作失败'}</div>
      <div className="small pre-wrap">{errText(props.error)}</div>
    </div>
  )
}

export function InlineSpinner(props: { label?: string }): ReactNode {
  return (
    <span className="row small muted">
      <span className="spinner" /> {props.label ?? '加载中…'}
    </span>
  )
}

export function RefreshButton(props: { onClick: () => void; loading?: boolean; label?: string }): ReactNode {
  return (
    <button type="button" className="btn ghost sm" onClick={props.onClick} disabled={props.loading} title="刷新">
      <RefreshCw size={13} style={props.loading ? { animation: 'spin 0.8s linear infinite' } : undefined} />
      {props.label ?? '刷新'}
    </button>
  )
}

export function Pager(props: {
  total: number
  offset: number
  limit: number
  onChange: (offset: number) => void
  loading?: boolean
}): ReactNode {
  const from = props.total === 0 ? 0 : props.offset + 1
  const to = Math.min(props.total, props.offset + props.limit)
  const canPrev = props.offset > 0
  const canNext = props.offset + props.limit < props.total
  return (
    <div className="intel-pagination">
      <span>
        第 {from}–{to} 条，共 {props.total} 条
      </span>
      <button type="button" className="btn sm" disabled={!canPrev || props.loading} onClick={() => props.onChange(Math.max(0, props.offset - props.limit))}>
        上一页
      </button>
      <button type="button" className="btn sm" disabled={!canNext || props.loading} onClick={() => props.onChange(props.offset + props.limit)}>
        下一页
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* SQL / JSON inspectors                                               */
/* ------------------------------------------------------------------ */

const SQL_KEYWORDS = new Set(
  (
    'select insert update delete replace from where join left right inner outer on group by order limit offset ' +
    'values into set create alter drop table truncate index primary key foreign references not null default ' +
    'and or in like between exists case when then else end as distinct union all show describe explain call ' +
    'begin commit rollback transaction grant revoke procedure function trigger view database schema'
  ).split(' ')
)

function renderSql(sql: string): ReactNode[] {
  const out: ReactNode[] = []
  const parts = sql.split(/(\s+|,|\(|\)|;)/)
  parts.forEach((part, index) => {
    const trimmed = part.trim()
    if (SQL_KEYWORDS.has(trimmed.toLowerCase()) && /^[A-Za-z]+$/.test(trimmed)) {
      out.push(
        <span className="sql-kw" key={index}>
          {part}
        </span>
      )
    } else {
      out.push(part)
    }
  })
  return out
}

export function SqlBlock(props: { sql: string | null | undefined; title?: ReactNode; tall?: boolean; short?: boolean }): ReactNode {
  const sql = props.sql ?? ''
  return (
    <div>
      {props.title !== undefined && (
        <div className="intel-code-head">
          <span>{props.title}</span>
          <div className="spacer" />
          <CopyButton value={sql} />
        </div>
      )}
      <pre className={`intel-code ${props.tall ? 'tall' : ''} ${props.short ? 'short' : ''}`}>
        {sql ? renderSql(sql) : <span className="muted">（空）</span>}
      </pre>
    </div>
  )
}

export function JsonBlock(props: { value: unknown; title?: ReactNode; tall?: boolean }): ReactNode {
  const text = typeof props.value === 'string' ? props.value : safeJson(props.value, 20_000)
  return (
    <div>
      <div className="intel-code-head">
        {props.title !== undefined && <span>{props.title}</span>}
        <div className="spacer" />
        <CopyButton value={text} />
      </div>
      <pre className={`intel-code ${props.tall ? 'tall' : ''}`}>{text}</pre>
    </div>
  )
}

export function CopyButton(props: { value: string; label?: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn ghost sm"
      title="复制内容"
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(props.value)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          } catch {
            setCopied(false)
          }
        })()
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? '已复制' : (props.label ?? '复制')}
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* time-machine coverage: four DISTINCT states (never a vague "backed up") */
/* ------------------------------------------------------------------ */

export function CoverageBadges(props: { point: Pick<RecoveryPoint, 'coverage' | 'status' | 'verified'> }): ReactNode {
  const c = props.point.coverage
  const onlyOperationLog = !c.hasBeforeImage && !c.hasFullBackup && !c.backupVerified
  return (
    <div className="intel-coverage">
      <span className={`intel-cov cov-op ${c.hasOperationLog ? '' : 'off'}`} title="系统记录了这次操作的日志，可以查看历史；仅有日志不能回滚数据">
        <span className="intel-dot" style={{ background: 'var(--text-muted)' }} />
        仅操作日志
      </span>
      <span className={`intel-cov cov-before ${c.hasBeforeImage ? '' : 'off'}`} title="执行前已捕获受影响行的主键与前镜像，可尝试按主键反向恢复">
        <span className="intel-dot" style={{ background: 'var(--accent)' }} />
        已存变更前镜像
      </span>
      <span className={`intel-cov cov-backup ${c.hasFullBackup ? '' : 'off'}`} title="执行前已完成完整备份文件（尚未通过恢复验证）">
        <span className="intel-dot" style={{ background: 'var(--purple)' }} />
        已完成完整备份
      </span>
      <span className={`intel-cov cov-verified ${c.backupVerified ? '' : 'off'}`} title="备份文件已通过完整性校验，并在临时库完成恢复验证">
        <span className="intel-dot" style={{ background: 'var(--ok)' }} />
        已通过恢复验证
      </span>
      {onlyOperationLog && <span className="badge danger">仅有操作日志：不能回滚数据</span>}
      {props.point.status === 'unusable' && <span className="badge danger">不可用</span>}
      {props.point.status === 'expired' && <span className="badge neutral">已过期</span>}
      {props.point.verified && <span className="badge ok">恢复点已校验</span>}
    </div>
  )
}

export function CoverageLegend(): ReactNode {
  return (
    <div className="intel-legend">
      <span>
        <span className="intel-dot" style={{ background: 'var(--text-muted)' }} /> 仅操作日志：只能追溯，不能回滚
      </span>
      <span>
        <span className="intel-dot" style={{ background: 'var(--accent)' }} /> 已存变更前镜像：可按主键撤销 DML
      </span>
      <span>
        <span className="intel-dot" style={{ background: 'var(--purple)' }} /> 已完成完整备份：有备份文件
      </span>
      <span>
        <span className="intel-dot" style={{ background: 'var(--ok)' }} /> 已通过恢复验证：备份可用性已验证
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* misc                                                               */
/* ------------------------------------------------------------------ */

export function IdText(props: { value: string | null | undefined }): ReactNode {
  return (
    <span className="mono xs intel-select-all" title={props.value ?? ''}>
      {props.value ?? '—'}
    </span>
  )
}

export function RiskStrip(props: { children: ReactNode; danger?: boolean }): ReactNode {
  return <div className={`intel-risk-strip ${props.danger ? 'danger' : ''}`}>{props.children}</div>
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toLocaleString('zh-CN')
}
