import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { KeyRound, Loader2, RefreshCw, Table2, Eye, X } from 'lucide-react'
import type { SchemaObjectType, TableDetails } from '@shared/types'
import { call } from '../../lib/api'
import { errorMessage } from '../../lib/store'
import { formatBytes } from '../../lib/format'
import { Badge, Button, Callout, IconButton } from '../ui'
import './workspace.css'

export interface TableDetailsPanelProps {
  connectionId: string
  database: string
  table: string
  type: SchemaObjectType
  /** drawer = modal side panel; inline = embedded in workspace tabs */
  variant?: 'drawer' | 'inline'
  onClose?: () => void
  onInsertSelect?: () => void
}

/**
 * Table structure (columns/indexes/FKs…) from `schema.getTable`.
 * Default is a drawer; use variant="inline" inside Browse | Structure | SQL tabs.
 */
export function TableDetailsPanel(props: TableDetailsPanelProps): ReactNode {
  const variant = props.variant ?? 'drawer'
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setDetails(null)
    call('schema.getTable', {
      connectionId: props.connectionId,
      database: props.database,
      table: props.table
    })
      .then((result) => {
        if (!cancelled) setDetails(result)
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [props.connectionId, props.database, props.table, nonce])

  const body = (
    <>
      {loading && (
        <div className="row muted small">
          <Loader2 size={14} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
          正在读取表结构…
        </div>
      )}
      {loadError && (
        <Callout kind="danger" title="读取表结构失败">
          <div className="pre-wrap">{loadError}</div>
          <div className="mt-2">
            <Button size="sm" onClick={() => setNonce((n) => n + 1)}>
              重试
            </Button>
          </div>
        </Callout>
      )}

      {details && (
        <>
          <div className="grid-3">
            <div className="stat-tile">
              <div className="stat-label">存储引擎</div>
              <div className="stat-value">{details.engine ?? '—'}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">估算行数</div>
              <div className="stat-value">
                {details.rowCount !== null && details.rowCount !== undefined
                  ? details.rowCount
                  : (details.rowEstimate ?? '未知')}
              </div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">数据 / 索引大小</div>
              <div className="stat-value small">
                {formatBytes(details.dataLength)} / {formatBytes(details.indexLength)}
              </div>
            </div>
          </div>

          <div className="mt-2 small muted pre-wrap">
            字符集：{details.charset ?? '—'} · 排序规则：{details.collation ?? '—'}
            {details.comment ? ` · 注释：${details.comment}` : ''}
          </div>
          <div className="small muted mono mt-1" title={details.schemaHash}>
            schemaHash：{details.schemaHash}
          </div>

          <div className="ws-divider" />

          <div className="row between mb-1">
            <div className="ws-section-title" style={{ margin: 0 }}>
              主键
            </div>
          </div>
          {details.primaryKey.length > 0 ? (
            <div className="chip-list">
              {details.primaryKey.map((column) => (
                <span key={column} className="chip">
                  <KeyRound size={10} className="tree-pk" />
                  {column}
                </span>
              ))}
            </div>
          ) : (
            <div className="muted small">无主键（部分恢复能力会因此受限）</div>
          )}

          <div className="mt-3">
            <div className="ws-section-title">字段（{details.columns.length}）</div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>#</th>
                    <th>字段</th>
                    <th>类型</th>
                    <th style={{ width: 70 }}>可空</th>
                    <th>默认值</th>
                    <th style={{ width: 54 }}>主键</th>
                    <th>注释</th>
                  </tr>
                </thead>
                <tbody>
                  {details.columns.map((column) => (
                    <tr key={column.name}>
                      <td className="muted">{column.ordinal}</td>
                      <td className="mono">{column.name}</td>
                      <td className="mono">{column.columnType}</td>
                      <td>{column.nullable ? 'YES' : 'NO'}</td>
                      <td className="mono">{column.defaultValue === null ? 'NULL' : column.defaultValue}</td>
                      <td>{column.isPrimaryKey ? <KeyRound size={12} className="tree-pk" /> : '—'}</td>
                      <td className="small muted">
                        {column.comment || '—'}
                        {column.isAutoIncrement ? ' · 自增' : ''}
                        {column.isGenerated ? ' · 生成列' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3">
            <div className="ws-section-title">索引（{details.indexes.length}）</div>
            {details.indexes.length === 0 ? (
              <div className="muted small">无索引</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th style={{ width: 60 }}>唯一</th>
                      <th style={{ width: 100 }}>类型</th>
                      <th>列</th>
                      <th style={{ width: 80, textAlign: 'right' }}>基数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.indexes.map((index) => (
                      <tr key={index.name}>
                        <td className="mono">{index.name}</td>
                        <td>{index.unique ? 'YES' : 'NO'}</td>
                        <td className="mono small">{index.type}</td>
                        <td className="mono small">{index.columns.join(', ')}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {index.cardinality ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="mt-3">
            <div className="ws-section-title">外键（{details.foreignKeys.length}）</div>
            {details.foreignKeys.length === 0 ? (
              <div className="muted small">无外键</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>列</th>
                      <th>引用</th>
                      <th style={{ width: 80 }}>ON UPDATE</th>
                      <th style={{ width: 80 }}>ON DELETE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.foreignKeys.map((fk) => (
                      <tr key={fk.name}>
                        <td className="mono small">{fk.name}</td>
                        <td className="mono small">{fk.columns.join(', ')}</td>
                        <td className="mono small">
                          {fk.referencedTable}({fk.referencedColumns.join(', ')})
                        </td>
                        <td className="small">{fk.onUpdate}</td>
                        <td className="small">{fk.onDelete}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {details.checkConstraints.length > 0 && (
            <div className="mt-3">
              <div className="ws-section-title">检查约束（{details.checkConstraints.length}）</div>
              {details.checkConstraints.map((check) => (
                <div key={check.name} className="small mono pre-wrap mb-1">
                  {check.name}：{check.expression}
                </div>
              ))}
            </div>
          )}

          {details.triggers.length > 0 && (
            <div className="mt-3">
              <div className="ws-section-title">触发器（{details.triggers.length}）</div>
              {details.triggers.map((trigger) => (
                <div key={trigger.name} className="statement-item mb-1">
                  <div className="row wrap">
                    <Badge className="badge purple">{trigger.name}</Badge>
                    <span className="small muted">
                      {trigger.timing} {trigger.event}
                    </span>
                  </div>
                  <div className="stmt-sql">{trigger.statement}</div>
                </div>
              ))}
            </div>
          )}

          {details.createSql && (
            <div className="mt-3">
              <div className="ws-section-title">建表 SQL</div>
              <details>
                <summary className="small pointer muted">展开查看 CREATE 语句</summary>
                <div className="plan-sql mt-1">{details.createSql}</div>
              </details>
            </div>
          )}
        </>
      )}
    </>
  )

  if (variant === 'inline') {
    return (
      <div className="ws-structure-inline">
        <div className="ws-browse-bar">
          {props.type === 'view' ? <Eye size={14} /> : <Table2 size={14} />}
          <span className="strong small mono">{props.table}</span>
          <Badge className="badge neutral">{props.type === 'view' ? '视图' : '表'}</Badge>
          <span className="muted xs truncate">{props.database}</span>
          <span className="spacer" />
          {props.onInsertSelect && (
            <Button size="sm" variant="ghost" onClick={props.onInsertSelect}>
              插入 SELECT
            </Button>
          )}
          <IconButton title="重新加载表结构" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
        <div className="ws-browse-body">{body}</div>
      </div>
    )
  }

  return (
    <div
      className="ws-drawer-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose?.()}
    >
      <aside className="ws-drawer wide">
        <div className="ws-drawer-head">
          {props.type === 'view' ? <Eye size={16} /> : <Table2 size={16} />}
          <h2 className="ws-drawer-title">{props.table}</h2>
          <Badge className="badge neutral">{props.type === 'view' ? '视图' : '表'}</Badge>
          <span className="muted small truncate">{props.database}</span>
          <span className="spacer" />
          {props.onInsertSelect && (
            <Button size="sm" variant="ghost" onClick={props.onInsertSelect} title="在编辑器插入 SELECT 查询">
              插入 SELECT
            </Button>
          )}
          <IconButton title="重新加载表结构" onClick={() => setNonce((n) => n + 1)}>
            <RefreshCw size={15} />
          </IconButton>
          {props.onClose && (
            <IconButton title="关闭" onClick={props.onClose}>
              <X size={16} />
            </IconButton>
          )}
        </div>
        <div className="ws-drawer-body">{body}</div>
      </aside>
    </div>
  )
}
