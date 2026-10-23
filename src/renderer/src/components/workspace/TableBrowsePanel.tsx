import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  Table2,
  X
} from 'lucide-react'
import type { QueryColumn, SqlPlan, TableBrowseResult, TableDetails } from '@shared/types'
import { call } from '../../lib/api'
import { errorMessage, useAppStore } from '../../lib/store'
import { formatDuration } from '../../lib/format'
import { Badge, Button, Callout, Field, IconButton, Input, Modal, Select, Textarea } from '../ui'
import { PlanPreviewDialog } from './PlanPreviewDialog'
import './workspace.css'

const PAGE_SIZES = [25, 50, 100, 200, 500] as const

function formatNumber(n: number): string {
  return n.toLocaleString('zh-CN')
}

function formatCell(value: unknown): { text: string; isNull: boolean; isNumber: boolean } {
  if (value === null || value === undefined) return { text: 'NULL', isNull: true, isNumber: false }
  if (typeof value === 'number') return { text: String(value), isNull: false, isNumber: true }
  if (typeof value === 'bigint') return { text: value.toString(), isNull: false, isNumber: true }
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', isNull: false, isNumber: false }
  if (value instanceof Date) return { text: value.toISOString(), isNull: false, isNumber: false }
  if (typeof value === 'object') {
    try {
      return { text: JSON.stringify(value), isNull: false, isNumber: false }
    } catch {
      return { text: String(value), isNull: false, isNumber: false }
    }
  }
  return { text: String(value), isNull: false, isNumber: false }
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  const text = value instanceof Date ? value.toISOString() : String(value)
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

function quoteIdent(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``
}

function displayCell(text: string): string {
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

function formatCacheTime(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function rowToObject(columns: QueryColumn[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  columns.forEach((column, index) => {
    out[column.name] = row[index]
  })
  return out
}

function rowSummary(columns: QueryColumn[], row: unknown[], max = 8): string {
  return columns
    .slice(0, max)
    .map((column, index) => `${column.name}=${formatCell(row[index]).text}`)
    .join(', ')
}

export interface TableBrowsePanelProps {
  connectionId: string
  database: string
  table: string
  projectId?: string | null
  /** Open workspace AI float with a prompt (does not leave the page). */
  onAskAi?: (message: string, options?: { autoSend?: boolean }) => void
}

/**
 * phpMyAdmin-style table browser: paginated rows, row select, edit via plan→approve,
 * and an AI action bar for the selected row.
 */
export function TableBrowsePanel(props: TableBrowsePanelProps): ReactNode {
  const toastOk = useAppStore((s) => s.toastOk)
  const toastError = useAppStore((s) => s.toastError)
  const agentBusy = useAppStore((s) => s.agentBusy)
  const guardAgentBusy = useAppStore((s) => s.guardAgentBusy)

  const [pageSize, setPageSize] = useState<number>(100)
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<TableBrowseResult | null>(null)
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)

  const [aiPrompt, setAiPrompt] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [plan, setPlan] = useState<SqlPlan | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    setOffset(0)
    setSelectedIndex(null)
  }, [props.connectionId, props.database, props.table])

  useEffect(() => {
    let cancelled = false
    call('schema.getTable', {
      connectionId: props.connectionId,
      database: props.database,
      table: props.table
    })
      .then((result) => {
        if (!cancelled) setDetails(result)
      })
      .catch(() => {
        if (!cancelled) setDetails(null)
      })
    return () => {
      cancelled = true
    }
  }, [props.connectionId, props.database, props.table, nonce])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const forceLive = nonce > 0 && !agentBusy.busy
    call('table.browse', {
      connectionId: props.connectionId,
      database: props.database,
      table: props.table,
      projectId: props.projectId ?? null,
      offset,
      limit: pageSize,
      ...(forceLive ? { forceLive: true } : {}),
      ...(agentBusy.busy ? { preferCache: true } : {})
    })
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setSelectedIndex(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setData(null)
          setError(errorMessage(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    props.connectionId,
    props.database,
    props.table,
    props.projectId,
    offset,
    pageSize,
    nonce,
    agentBusy.busy
  ])

  const columns = data?.execution.result?.columns ?? []
  const rows = data?.execution.result?.rows ?? []
  const rowCount = data?.execution.result?.rowCount ?? 0
  const estimatedTotal = data?.estimatedTotal ?? null
  const page = Math.floor(offset / pageSize) + 1
  const hasPrev = offset > 0
  const hasNext =
    rowCount >= pageSize || (estimatedTotal !== null && offset + rowCount < estimatedTotal)

  const primaryKeys = details?.primaryKey?.length ? details.primaryKey : []
  const selectedRow = selectedIndex !== null ? rows[selectedIndex] : null
  const selectedObject = useMemo(
    () => (selectedRow && columns.length ? rowToObject(columns, selectedRow) : null),
    [columns, selectedRow]
  )

  const goPrev = useCallback(() => setOffset((o) => Math.max(0, o - pageSize)), [pageSize])
  const goNext = useCallback(() => setOffset((o) => o + pageSize), [pageSize])

  const openEditForRow = useCallback(
    (row: unknown[] | null | undefined) => {
      if (!row || !columns.length) return
      if (primaryKeys.length === 0) {
        toastError(new Error('该表没有主键，无法安全编辑单行。请用 SQL 页签手动编写 UPDATE。'))
        return
      }
      const next: Record<string, string> = {}
      columns.forEach((column, index) => {
        const cell = formatCell(row[index])
        next[column.name] = cell.isNull ? '' : cell.text
      })
      setEditValues(next)
      setEditOpen(true)
    },
    [columns, primaryKeys.length, toastError]
  )

  const openEdit = useCallback(() => openEditForRow(selectedRow), [openEditForRow, selectedRow])

  const buildUpdateSql = useCallback((): string | null => {
    if (!selectedObject || !columns.length || primaryKeys.length === 0) return null
    const setParts: string[] = []
    for (const column of columns) {
      if (primaryKeys.includes(column.name)) continue
      const raw = editValues[column.name]
      const original = selectedObject[column.name]
      const originalText = formatCell(original).isNull ? '' : formatCell(original).text
      if (raw === originalText) continue
      if (raw === '' && formatCell(original).isNull) continue
      if (raw.trim() === '' && !formatCell(original).isNull) {
        setParts.push(`${quoteIdent(column.name)} = NULL`)
      } else if (/^-?\d+(\.\d+)?$/.test(raw.trim()) && typeof original === 'number') {
        setParts.push(`${quoteIdent(column.name)} = ${raw.trim()}`)
      } else {
        setParts.push(`${quoteIdent(column.name)} = ${sqlLiteral(raw)}`)
      }
    }
    if (setParts.length === 0) return null
    const where = primaryKeys
      .map((key) => `${quoteIdent(key)} = ${sqlLiteral(selectedObject[key])}`)
      .join(' AND ')
    return `UPDATE ${quoteIdent(props.database)}.${quoteIdent(props.table)}\nSET ${setParts.join(', ')}\nWHERE ${where}\nLIMIT 1;`
  }, [columns, editValues, primaryKeys, props.database, props.table, selectedObject])

  const submitEdit = useCallback(async () => {
    const sql = buildUpdateSql()
    if (!sql) {
      toastError(new Error('没有检测到字段变更'))
      return
    }
    setPlanning(true)
    try {
      const created = await call('sql.plan', {
        connectionId: props.connectionId,
        database: props.database,
        projectId: props.projectId ?? undefined,
        sql
      })
      setPlan(created)
      setPreviewOpen(true)
      setEditOpen(false)
    } catch (e) {
      toastError(e)
    } finally {
      setPlanning(false)
    }
  }, [buildUpdateSql, props.connectionId, props.database, props.projectId, toastError])

  const closePreview = useCallback(async () => {
    setPreviewOpen(false)
    if (plan?.requiresApproval) {
      try {
        await call('approval.deny', { planId: plan.planId, comment: '用户取消编辑' })
      } catch {
        /* ignore */
      }
    }
    setPlan(null)
  }, [plan])

  const confirmPlan = useCallback(async () => {
    if (!plan) return
    setConfirming(true)
    try {
      if (plan.requiresApproval) {
        await call('approval.approve', { planId: plan.planId, comment: '工作区行编辑' })
      }
      const execution = await call('sql.execute', { planId: plan.planId, confirmed: true })
      if (!execution.ok) {
        toastError(new Error(execution.error?.message ?? '执行失败'))
      } else {
        toastOk('已更新', `影响行数见执行结果 · ${formatDuration(execution.durationMs)}`)
        setNonce((n) => n + 1)
      }
      setPreviewOpen(false)
      setPlan(null)
    } catch (e) {
      toastError(e)
    } finally {
      setConfirming(false)
    }
  }, [plan, toastError, toastOk])

  const sendToAi = useCallback(
    (intent: string, autoSend = true) => {
      if (!selectedObject) return
      const pkHint =
        primaryKeys.length > 0
          ? primaryKeys.map((key) => `${key}=${JSON.stringify(selectedObject[key])}`).join(', ')
          : rowSummary(columns, selectedRow ?? [], 4)
      const payload = [
        `请针对数据库 \`${props.database}\` 表 \`${props.table}\` 的选中行处理。`,
        `行标识：${pkHint}`,
        `完整行数据（JSON）：`,
        '```json',
        JSON.stringify(selectedObject, null, 2),
        '```',
        '',
        `用户意图：${intent.trim()}`,
        '',
        '优先用只读 SQL 查询验证；如需修改请先给出计划并等待批准。'
      ].join('\n')
      if (props.onAskAi) {
        props.onAskAi(payload, { autoSend })
      } else {
        toastError(new Error('当前页面未挂载工作区 AI 浮窗'))
      }
    },
    [
      columns,
      primaryKeys,
      props,
      selectedObject,
      selectedRow,
      toastError
    ]
  )

  const runAi = useCallback(() => {
    const intent = aiPrompt.trim() || '请解释这一行数据的业务含义，并告诉我可以怎么安全地查询或修改它。'
    sendToAi(intent, true)
  }, [aiPrompt, sendToAi])

  return (
    <div className="ws-browse">
      <div className="ws-browse-bar">
        <Table2 size={14} />
        <span className="strong small mono">{props.table}</span>
        <span className="muted xs">数据浏览 · 可选中行编辑 / 问 AI</span>
        <span className="spacer" />
        {loading && (
          <span className="row muted xs">
            <Loader2 size={12} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
            加载中…
          </span>
        )}
        {data?.fromCache && (
          <span title={data.cacheReason ?? '本地缓存预览'}>
            <Badge className="badge warn">
              本地缓存
              {data.cachedAt ? ` · ${formatCacheTime(data.cachedAt)}` : ''}
            </Badge>
          </span>
        )}
        {data && !data.fromCache && data.cachedAt && !loading && (
          <span className="muted xs" title="已写入本机预览缓存">
            缓存时间 {formatCacheTime(data.cachedAt)}
          </span>
        )}
        {data && !loading && (
          <Badge className={data.execution.ok ? 'badge ok' : 'badge danger'}>
            {data.execution.ok ? 'OK' : '失败'} · {formatDuration(data.execution.durationMs)}
          </Badge>
        )}
        <span className="muted xs">每页</span>
        <Select
          value={String(pageSize)}
          onChange={(value) => {
            setPageSize(Number(value))
            setOffset(0)
          }}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
        />
        <Button size="sm" variant="ghost" disabled={!hasPrev || loading} onClick={goPrev} icon={<ChevronLeft size={13} />}>
          上一页
        </Button>
        <span className="mono xs muted">
          第 {page} 页 · 行 {formatNumber(offset + (rowCount > 0 ? 1 : 0))}–{formatNumber(offset + rowCount)}
          {estimatedTotal !== null ? ` / 约 ${formatNumber(estimatedTotal)}` : ''}
        </span>
        <Button size="sm" variant="ghost" disabled={!hasNext || loading} onClick={goNext} icon={<ChevronRight size={13} />}>
          下一页
        </Button>
        <IconButton
          title={agentBusy.busy ? 'AI 进行中：刷新将继续使用本地缓存' : '刷新（实时查询并更新本地缓存）'}
          onClick={() => {
            if (agentBusy.busy) {
              guardAgentBusy('实时刷新')
            }
            setNonce((n) => n + 1)
          }}
        >
          <RefreshCw size={14} />
        </IconButton>
      </div>

      {error && (
        <div className="ws-browse-body">
          <Callout kind="danger" title="读取表数据失败">
            <div className="pre-wrap">{error}</div>
            <div className="mt-2">
              <Button size="sm" onClick={() => setNonce((n) => n + 1)}>
                重试
              </Button>
            </div>
          </Callout>
        </div>
      )}

      {!error && data && (
        <div className="ws-browse-body">
          <div className="muted xs mono mb-1 truncate" title={data.sql}>
            {data.sql}
          </div>
          {columns.length === 0 ? (
            <div className="ws-placeholder">没有列信息。</div>
          ) : (
            <div className="table-wrap result-table browse-selectable">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>#</th>
                    {columns.map((column, index) => (
                      <th key={`${column.name}-${index}`} title={column.typeName}>
                        {column.name}
                        <span className="type-hint">{column.typeName}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length + 1}>
                        <div className="muted small" style={{ padding: 10 }}>
                          查询成功，但没有返回任何行。
                        </div>
                      </td>
                    </tr>
                  ) : (
                    rows.map((row, rowIndex) => (
                      <tr
                        key={rowIndex}
                        className={selectedIndex === rowIndex ? 'row-selected' : ''}
                        onClick={() => setSelectedIndex(rowIndex)}
                        onDoubleClick={() => {
                          setSelectedIndex(rowIndex)
                          openEditForRow(row)
                        }}
                      >
                        <td className="num muted">{offset + rowIndex + 1}</td>
                        {columns.map((column, columnIndex) => {
                          const cell = formatCell(row[columnIndex])
                          const className = [cell.isNull ? 'null' : '', cell.isNumber ? 'num' : '']
                            .filter(Boolean)
                            .join(' ')
                          return (
                            <td key={`${column.name}-${columnIndex}`} className={className} title={cell.text}>
                              {displayCell(cell.text)}
                            </td>
                          )
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!error && !data && loading && (
        <div className="ws-placeholder">
          <span className="spinner" /> 正在读取表数据…
        </div>
      )}

      {selectedObject && (
        <div className="ws-row-ai-bar">
          <div className="row wrap" style={{ gap: 8, flex: 1, minWidth: 0 }}>
            <Sparkles size={14} style={{ color: 'var(--accent)' }} />
            <span className="strong xs">已选中行</span>
            <span className="muted xs mono truncate" title={rowSummary(columns, selectedRow ?? [])}>
              {rowSummary(columns, selectedRow ?? [])}
            </span>
            <button type="button" className="btn sm ghost" onClick={() => setSelectedIndex(null)} title="取消选中">
              <X size={12} />
            </button>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            <Button size="sm" variant="ghost" icon={<Pencil size={12} />} onClick={openEdit}>
              编辑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                sendToAi('请用只读 SQL 查清这一行的关联数据（用户/订单/明细等），并总结业务含义。')
              }
            >
              查关联
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                sendToAi('请解释这一行各字段含义，并指出哪些字段适合修改、修改风险是什么。')
              }
            >
              解释
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const kw =
                  primaryKeys.length > 0 && selectedObject
                    ? String(selectedObject[primaryKeys[0]] ?? '')
                    : rowSummary(columns, selectedRow ?? [], 2)
                sendToAi(
                  `请在当前库中搜索与本行相关的数据（关键词线索：${kw}），列出相关表与样例行，只读。`
                )
              }}
            >
              搜库
            </Button>
            <Input
              value={aiPrompt}
              onChange={setAiPrompt}
              placeholder="例如：把状态改成已下架 / 搜这个业务的订单…"
              className="ws-row-ai-input"
              onEnter={runAi}
            />
            <Button size="sm" variant="primary" icon={<Bot size={13} />} onClick={runAi}>
              AI
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={editOpen}
        title={`编辑 ${props.table}`}
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)} disabled={planning}>
              取消
            </Button>
            <Button variant="primary" loading={planning} onClick={() => void submitEdit()}>
              预览更新计划
            </Button>
          </>
        }
      >
        <div className="small muted mb-2">
          写操作会走「计划 → 审批 → 执行」。主键字段不可改。
          {primaryKeys.length > 0 ? ` 主键：${primaryKeys.join(', ')}` : ''}
        </div>
        <div className="ws-edit-fields">
          {columns.map((column) => {
            const isPk = primaryKeys.includes(column.name)
            return (
              <Field key={column.name} label={`${column.name}${isPk ? '（主键）' : ''}`} hint={column.typeName}>
                <Input
                  value={editValues[column.name] ?? ''}
                  onChange={(value) => setEditValues((prev) => ({ ...prev, [column.name]: value }))}
                  disabled={isPk}
                  placeholder={isPk ? undefined : '空 = NULL'}
                />
              </Field>
            )
          })}
        </div>
      </Modal>

      <PlanPreviewDialog
        plan={plan}
        open={previewOpen}
        busy={confirming}
        onCancel={() => void closePreview()}
        onConfirm={() => void confirmPlan()}
      />
    </div>
  )
}
