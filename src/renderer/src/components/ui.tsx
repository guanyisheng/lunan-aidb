import {
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { X, AlertTriangle, Info, CheckCircle2, Loader2 } from 'lucide-react'
import { useAppStore } from '../lib/store'
import { riskBadgeClass, riskLabel } from '../lib/format'
import type { RiskLevel } from '@shared/types'

/* ------------------------------------------------------------ buttons */
type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'

export function Button(props: {
  children?: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  disabled?: boolean
  loading?: boolean
  title?: string
  type?: 'button' | 'submit'
  className?: string
  icon?: ReactNode
}): ReactNode {
  const cls = ['btn', props.variant && props.variant !== 'default' ? props.variant : '', props.size === 'sm' ? 'sm' : '', props.className ?? '']
    .filter(Boolean)
    .join(' ')
  return (
    <button
      type={props.type ?? 'button'}
      className={cls}
      onClick={props.onClick}
      disabled={props.disabled || props.loading}
      title={props.title}
    >
      {props.loading ? <span className="spinner" /> : props.icon}
      {props.children}
    </button>
  )
}

export function IconButton(props: { title: string; onClick?: () => void; children: ReactNode; className?: string }): ReactNode {
  return (
    <button type="button" className={`btn icon ghost ${props.className ?? ''}`} title={props.title} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

export function Badge(props: { children: ReactNode; className?: string }): ReactNode {
  return <span className={props.className ?? 'badge neutral'}>{props.children}</span>
}

export function RiskBadge(props: { risk: RiskLevel; withLabel?: boolean }): ReactNode {
  return (
    <span className={riskBadgeClass[props.risk]}>
      {props.withLabel === false ? props.risk : riskLabel[props.risk]}
    </span>
  )
}

/* ------------------------------------------------------------- layout */
export function Card(props: { children: ReactNode; className?: string; onClick?: () => void; title?: ReactNode; sub?: ReactNode }): ReactNode {
  return (
    <div className={`card ${props.className ?? ''}`} onClick={props.onClick}>
      {props.title !== undefined && <h3 className="card-title">{props.title}</h3>}
      {props.sub !== undefined && <p className="card-sub">{props.sub}</p>}
      {props.children}
    </div>
  )
}

export function PageHeader(props: {
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}): ReactNode {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-title">{props.title}</h1>
        {props.sub !== undefined && <div className="page-sub">{props.sub}</div>}
      </div>
      {props.children}
      {props.actions && <div className="page-actions">{props.actions}</div>}
    </header>
  )
}

export function EmptyState(props: { title: string; body?: ReactNode; icon?: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="empty">
      <div className="empty-icon">{props.icon ?? <Info size={24} />}</div>
      <div className="empty-title">{props.title}</div>
      {props.body && <div className="mt-1">{props.body}</div>}
      {props.action && <div className="mt-3">{props.action}</div>}
    </div>
  )
}

export function LoadingBlock(props: { label?: string }): ReactNode {
  return (
    <div className="empty">
      <Loader2 size={20} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
      <div className="muted small mt-2">{props.label ?? '加载中…'}</div>
    </div>
  )
}

export function Callout(props: { kind?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; title?: ReactNode }): ReactNode {
  const Icon = props.kind === 'danger' || props.kind === 'warn' ? AlertTriangle : props.kind === 'ok' ? CheckCircle2 : Info
  return (
    <div className={`callout ${props.kind ?? 'info'}`}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Icon size={15} style={{ marginTop: 2, flexShrink: 0 }} />
        <div className="grow">
          {props.title !== undefined && <div className="strong mb-1">{props.title}</div>}
          <div>{props.children}</div>
        </div>
      </div>
    </div>
  )
}

export function ProgressBar(props: { value: number; label?: string }): ReactNode {
  const pct = Math.max(0, Math.min(1, props.value)) * 100
  return (
    <div>
      {props.label && (
        <div className="row between small muted mb-1">
          <span>{props.label}</span>
          <span>{pct.toFixed(0)}%</span>
        </div>
      )}
      <div className="progress">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- forms */
export function Field(props: {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={`field ${props.className ?? ''}`}>
      {props.label !== undefined && <label>{props.label}</label>}
      {props.children}
      {props.error ? <div className="field-error">{props.error}</div> : props.hint ? <div className="field-hint">{props.hint}</div> : null}
    </div>
  )
}

export function Input(props: {
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
  onEnter?: () => void
  className?: string
  autoFocus?: boolean
  maxLength?: number
}): ReactNode {
  return (
    <input
      className={`input ${props.className ?? ''}`}
      value={props.value}
      type={props.type ?? 'text'}
      placeholder={props.placeholder}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      maxLength={props.maxLength}
      onChange={(e) => props.onChange?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && props.onEnter) props.onEnter()
      }}
    />
  )
}

export function Textarea(props: {
  value: string
  onChange?: (value: string) => void
  rows?: number
  placeholder?: string
  disabled?: boolean
  className?: string
  onKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void
}): ReactNode {
  return (
    <textarea
      className={`textarea ${props.className ?? ''}`}
      value={props.value}
      rows={props.rows ?? 5}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => props.onChange?.(e.target.value)}
      onKeyDown={props.onKeyDown}
    />
  )
}

export function Select<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}): ReactNode {
  return (
    <select className={`select ${props.className ?? ''}`} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as T)}>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Checkbox(props: { checked: boolean; onChange: (checked: boolean) => void; label: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  )
}

/* ------------------------------------------------------------- modal */
export function Modal(props: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /**
   * Clicking the dimmed backdrop closes the dialog.
   * Default false so form / config modals are not wiped by an accidental outside click.
   */
  closeOnBackdrop?: boolean
  /** Escape key closes. Default true. */
  closeOnEscape?: boolean
}): ReactNode {
  const id = useId()
  const closeOnBackdrop = props.closeOnBackdrop === true
  const closeOnEscape = props.closeOnEscape !== false
  useEffect(() => {
    if (!props.open || !closeOnEscape) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open, props.onClose, closeOnEscape])
  if (!props.open) return null
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) props.onClose()
      }}
    >
      <div
        className={`modal ${props.wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={id}>
            {props.title}
          </h2>
          <div className="spacer" />
          <IconButton title="关闭" onClick={props.onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmDialog(props: {
  open: boolean
  title: ReactNode
  children: ReactNode
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  return (
    <Modal
      open={props.open}
      title={props.title}
      onClose={props.onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={props.onCancel} disabled={props.busy}>
            取消
          </Button>
          <Button variant={props.danger ? 'danger' : 'primary'} onClick={props.onConfirm} loading={props.busy}>
            {props.confirmLabel ?? '确认'}
          </Button>
        </>
      }
    >
      {props.children}
    </Modal>
  )
}

/* ------------------------------------------------------------- table */
export interface Column<T> {
  key: string
  title: ReactNode
  width?: string
  align?: 'left' | 'right' | 'center'
  render?: (row: T) => ReactNode
}

export function DataTable<T>(props: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  empty?: ReactNode
  onRowClick?: (row: T) => void
  className?: string
}): ReactNode {
  const head = useMemo(
    () =>
      props.columns.map((c) => (
        <th key={c.key} style={{ width: c.width, textAlign: c.align ?? 'left' }}>
          {c.title}
        </th>
      )),
    [props.columns]
  )
  return (
    <div className={`table-wrap ${props.className ?? ''}`}>
      <table className="table">
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td colSpan={props.columns.length}>{props.empty ?? <div className="muted small" style={{ padding: 12 }}>暂无数据</div>}</td>
            </tr>
          ) : (
            props.rows.map((row) => (
              <tr
                key={props.rowKey(row)}
                onClick={() => props.onRowClick?.(row)}
                style={{ cursor: props.onRowClick ? 'pointer' : undefined }}
              >
                {props.columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export function KeyValue(props: { items: { label: ReactNode; value: ReactNode }[] }): ReactNode {
  return (
    <dl className="kv">
      {props.items.map((item, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function InlineError(props: { error: unknown }): ReactNode {
  const message = props.error instanceof Error ? props.error.message : String(props.error)
  return (
    <Callout kind="danger" title="出错了">
      {message}
    </Callout>
  )
}

export function Toasts(): ReactNode {
  const toasts = useAppStore((s) => s.toasts)
  const dismiss = useAppStore((s) => s.dismissToast)
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)} style={{ cursor: 'pointer' }}>
          <div className="toast-title">{t.title}</div>
          {t.body && <div className="toast-body">{t.body}</div>}
        </div>
      ))}
    </div>
  )
}

/** Simple local state helper for forms. */
export function useForm<T extends Record<string, string>>(initial: T): [T, (key: keyof T, value: string) => void, () => void] {
  const [state, setState] = useState<T>(initial)
  return [
    state,
    (key, value) => setState((prev) => ({ ...prev, [key]: value })),
    () => setState(initial)
  ]
}
