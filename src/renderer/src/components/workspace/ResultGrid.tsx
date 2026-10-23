import type { ReactNode } from 'react'
import type { ExecutionResult, QueryColumn, StatementExecution } from '@shared/types'
import { formatDuration, kindLabel } from '../../lib/format'
import { useAppStore } from '../../lib/store'
import { Badge, Button, Callout } from '../ui'
import './workspace.css'

interface CellValue {
  text: string
  isNull: boolean
  isNumber: boolean
}

function formatCell(value: unknown): CellValue {
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

function titleFor(text: string): string {
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text
}

/** Keeps huge JSON/binary cells from flooding the DOM; the full value is in the title. */
function displayCell(text: string): string {
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

function columnTitle(column: QueryColumn): string {
  const parts = [column.typeName]
  if (column.database) parts.push(`库：${column.database}`)
  if (column.table) parts.push(`表：${column.table}`)
  if (column.nullable !== undefined) parts.push(column.nullable ? '可空' : '非空')
  return parts.join(' · ')
}

function statusBadge(statement: StatementExecution): ReactNode {
  if (statement.ok) return <Badge className="badge ok">成功</Badge>
  const code = statement.error?.code
  if (code === 'CANCELLED') return <Badge className="badge warn">已取消</Badge>
  return <Badge className="badge danger">失败</Badge>
}

function errorText(statement: StatementExecution): string {
  if (!statement.error) return ''
  return statement.error.hint ? `${statement.error.message}（${statement.error.hint}）` : statement.error.message
}

export interface ResultGridProps {
  result: ExecutionResult
  /** Called by the "查看时间机器" entry; defaults to the app router. */
  onViewTimeMachine?: () => void
}

/**
 * Renders the real `ExecutionResult` returned by `sql.execute`.
 * Nothing is inferred or fabricated: recovery ids, row counts, warnings and
 * per-statement outcomes are displayed exactly as the trusted layer reported
 * them (unknown row estimates are shown as "未知" in the plan preview instead).
 */
export function ResultGrid(props: ResultGridProps): ReactNode {
  const navigate = useAppStore((s) => s.navigate)
  const result = props.result
  const viewTimeMachine = props.onViewTimeMachine ?? (() => navigate('timemachine'))

  const rows = result.result?.rows ?? []
  const columns = result.result?.columns ?? []
  const isWrite = result.statements.some((s) =>
    ['insert', 'update', 'delete', 'replace', 'create', 'alter', 'drop', 'truncate', 'rename', 'load'].includes(s.kind)
  )

  return (
    <div>
      <div className="result-meta">
        {result.ok ? <Badge className="badge ok">执行成功</Badge> : <Badge className="badge danger">执行失败</Badge>}
        <span>
          耗时 <span className="meta-strong">{formatDuration(result.durationMs)}</span>
        </span>
        <span>
          语句数 <span className="meta-strong">{result.statements.length}</span>
        </span>
        {result.result && (
          <span>
            返回行数 <span className="meta-strong">{result.result.rowCount}</span>
          </span>
        )}
        <span className="truncate mono xs" title={result.executionId}>
          executionId：{result.executionId}
        </span>
        <span className="truncate mono xs" title={result.auditEventId}>
          audit：{result.auditEventId}
        </span>
      </div>

      {result.error && (
        <Callout kind="danger" title={`执行失败（${result.error.code}）`}>
          <div className="pre-wrap">{result.error.message}</div>
          {result.error.hint && <div className="small mt-1">建议：{result.error.hint}</div>}
        </Callout>
      )}

      {result.warning && (
        <div className="mb-2">
          <Callout kind="warn" title="执行警告">
            <div className="pre-wrap">{result.warning}</div>
          </Callout>
        </div>
      )}

      {(result.recoveryPointId || result.backupId) && (
        <div className="mb-2">
          <Callout kind="ok" title="已创建保护点">
            <div className="row wrap">
              {result.recoveryPointId && (
                <span className="small">
                  恢复点：<span className="mono">{result.recoveryPointId}</span>
                </span>
              )}
              {result.backupId && (
                <span className="small">
                  备份：<span className="mono">{result.backupId}</span>
                </span>
              )}
              <Button size="sm" onClick={viewTimeMachine}>
                查看时间机器
              </Button>
            </div>
          </Callout>
        </div>
      )}

      {result.ok && isWrite && !result.recoveryPointId && (
        <div className="mb-2">
          <Callout kind="warn" title="未返回恢复点">
            本次写操作执行成功，但可信服务层未返回恢复点 id。请到时间机器/操作历史核对保护状态，不要默认认为已可回滚。
          </Callout>
        </div>
      )}

      {result.result && result.result.truncated && (
        <div className="mb-2">
          <Callout kind="warn" title="结果已截断">
            为避免界面卡死，本次最多显示 {result.result.maxRows} 行（服务端返回 {result.result.rowCount} 行）。如需完整结果请加上 LIMIT 后分批查询。
          </Callout>
        </div>
      )}

      {columns.length > 0 && (
        <div className="table-wrap result-table">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 44 }}>#</th>
                {columns.map((column, index) => (
                  <th key={`${column.name}-${index}`} title={columnTitle(column)}>
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
                  <tr key={rowIndex}>
                    <td className="num muted">{rowIndex + 1}</td>
                    {columns.map((column, columnIndex) => {
                      const cell = formatCell(row[columnIndex])
                      const className = [cell.isNull ? 'null' : '', cell.isNumber ? 'num' : ''].filter(Boolean).join(' ')
                      return (
                        <td key={`${column.name}-${columnIndex}`} className={className} title={titleFor(cell.text)}>
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

      {result.statements.length > 0 && (
        <div className="stmt-summary">
          <div className="ws-section-title">逐语句执行结果</div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 42 }}>#</th>
                  <th style={{ width: 90 }}>类型</th>
                  <th style={{ width: 78 }}>状态</th>
                  <th style={{ width: 80, textAlign: 'right' }}>影响行数</th>
                  <th style={{ width: 80, textAlign: 'right' }}>返回行数</th>
                  <th style={{ width: 84, textAlign: 'right' }}>耗时</th>
                  <th style={{ width: 120 }}>恢复点</th>
                  <th>警告 / 错误</th>
                </tr>
              </thead>
              <tbody>
                {result.statements.map((statement) => (
                  <tr key={statement.statementIndex}>
                    <td className="muted">{statement.statementIndex + 1}</td>
                    <td>{kindLabel[statement.kind] ?? statement.kind}</td>
                    <td>{statusBadge(statement)}</td>
                    <td style={{ textAlign: 'right' }} className="mono">
                      {statement.affectedRows}
                    </td>
                    <td style={{ textAlign: 'right' }} className="mono">
                      {statement.rowCount}
                    </td>
                    <td style={{ textAlign: 'right' }} className="mono">
                      {formatDuration(statement.durationMs)}
                    </td>
                    <td className="mono xs">{statement.recoveryPointId ?? '—'}</td>
                    <td>
                      {statement.error ? (
                        <span style={{ color: '#ff9d9d' }}>{errorText(statement)}</span>
                      ) : statement.warnings.length > 0 ? (
                        <span className="muted">{statement.warnings.join('；')}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!result.result && result.statements.length === 0 && (
        <div className="ws-placeholder">本次执行没有返回结果集。</div>
      )}
    </div>
  )
}
