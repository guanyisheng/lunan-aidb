import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  KeyRound,
  Loader2,
  RefreshCw,
  Table2
} from 'lucide-react'
import type { ColumnInfo, SchemaObjectType } from '@shared/types'
import { call } from '../../lib/api'
import { errorMessage } from '../../lib/store'
import { Button, IconButton } from '../ui'
import './workspace.css'

interface TableLists {
  tables: string[]
  views: string[]
}

interface ColumnState {
  loading?: boolean
  error?: string
  columns?: ColumnInfo[]
}

export interface DatabaseTreeProps {
  connectionId: string | null
  database: string
  /** Bump to force reloading the table/view list. */
  refreshToken: number
  selectedTable: string | null
  onSelectTable: (name: string, type: SchemaObjectType) => void
  /** Double click on a table/view name inserts a SELECT into the editor. */
  onInsertTable: (name: string, type: SchemaObjectType) => void
}

/**
 * Left-hand object tree: database -> table/view sections -> lazy columns.
 *
 * Everything comes from the live schema IPC (`schema.listTables` /
 * `schema.getTable`). Nothing is cached beyond the current database and the
 * cache is cleared on connection/database switches, so a stale schema can
 * never be shown for a different database.
 */
export function DatabaseTree(props: DatabaseTreeProps): ReactNode {
  const { connectionId, database } = props
  const [lists, setLists] = useState<TableLists | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tablesOpen, setTablesOpen] = useState(true)
  const [viewsOpen, setViewsOpen] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [columns, setColumns] = useState<Record<string, ColumnState>>({})
  const [localRefresh, setLocalRefresh] = useState(0)
  const contextRef = useRef(`${connectionId ?? ''}|${database}`)
  contextRef.current = `${connectionId ?? ''}|${database}`
  // A single click selects (opens the details drawer) and a double click
  // inserts SQL. The drawer would cover the tree before the dblclick fires,
  // so the selection is delayed slightly and cancelled by a double click.
  const clickTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current)
    }
  }, [])

  const handleRowClick = (name: string, type: SchemaObjectType): void => {
    if (clickTimer.current !== null) window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      props.onSelectTable(name, type)
    }, 220)
  }

  const handleRowDoubleClick = (name: string, type: SchemaObjectType): void => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    props.onInsertTable(name, type)
  }

  useEffect(() => {
    setExpanded(new Set())
    setColumns({})
    setTablesOpen(true)
    setViewsOpen(true)
  }, [connectionId, database])

  useEffect(() => {
    if (!connectionId || !database) {
      setLists(null)
      setLoadError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    call('schema.listTables', { connectionId, database })
      .then((result) => {
        if (cancelled) return
        setLists({ tables: result.tables, views: result.views })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setLists(null)
        setLoadError(errorMessage(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [connectionId, database, props.refreshToken, localRefresh])

  const loadColumns = (name: string): void => {
    if (!connectionId || !database) return
    const context = contextRef.current
    setColumns((prev) => ({ ...prev, [name]: { loading: true } }))
    call('schema.getTable', { connectionId, database, table: name })
      .then((details) => {
        if (contextRef.current !== context) return
        setColumns((prev) => ({ ...prev, [name]: { columns: details.columns } }))
      })
      .catch((e: unknown) => {
        if (contextRef.current !== context) return
        setColumns((prev) => ({ ...prev, [name]: { error: errorMessage(e) } }))
      })
  }

  const toggleTable = (name: string): void => {
    const isExpanded = expanded.has(name)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (isExpanded) next.delete(name)
      else next.add(name)
      return next
    })
    if (isExpanded || columns[name]?.columns || columns[name]?.loading) return
    loadColumns(name)
  }

  const retryColumns = (name: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add(name)
      return next
    })
    loadColumns(name)
  }

  if (!connectionId || !database) {
    return <div className="ws-placeholder">请选择数据库连接与数据库后浏览对象。</div>
  }

  const renderObject = (name: string, type: SchemaObjectType): ReactNode => {
    const isExpanded = expanded.has(name)
    const state = columns[name]
    return (
      <div key={`${type}-${name}`}>
        <div
          className={`tree-node ${props.selectedTable === name ? 'active' : ''}`}
          title={`${name}（单击浏览数据，双击打开 SQL）`}
          onClick={() => handleRowClick(name, type)}
          onDoubleClick={() => handleRowDoubleClick(name, type)}
        >
          <button
            type="button"
            className="tree-caret"
            title={isExpanded ? '收起字段' : '展开字段'}
            onClick={(event) => {
              event.stopPropagation()
              toggleTable(name)
            }}
          >
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {type === 'view' ? <Eye size={13} /> : <Table2 size={13} />}
          <span className="tree-label">{name}</span>
        </div>
        {isExpanded && (
          <div className="tree-children">
            {state?.loading && (
              <div className="tree-msg row">
                <Loader2 size={12} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
                正在加载字段…
              </div>
            )}
            {state?.error && (
              <div className="tree-msg error">
                {state.error}
                <div className="mt-1">
                  <Button size="sm" variant="ghost" onClick={() => retryColumns(name)}>
                    重试
                  </Button>
                </div>
              </div>
            )}
            {state?.columns && state.columns.length === 0 && <div className="tree-msg">没有字段</div>}
            {state?.columns?.map((column) => (
              <div key={column.name} className="tree-node column" title={`${column.columnType}${column.comment ? ` · ${column.comment}` : ''}`}>
                {column.isPrimaryKey ? <KeyRound size={11} className="tree-pk" /> : <span style={{ width: 11, flexShrink: 0 }} />}
                <span className="tree-col-name">{column.name}</span>
                {!column.nullable && <span className="tree-nullable">NOT NULL</span>}
                <span className="tree-col-type">{column.columnType}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="tree">
      <div className="ws-side-head" style={{ borderBottom: 'none', padding: '4px 2px 6px' }}>
        <span className="ws-side-title" style={{ marginLeft: 2 }}>
          对象树
        </span>
        <span className="spacer" />
        <IconButton title="刷新表/视图列表" onClick={() => setLocalRefresh((n) => n + 1)}>
          <RefreshCw size={13} />
        </IconButton>
      </div>

      <div className="tree-node root">
        <Database size={14} />
        <span className="tree-label">{database}</span>
        {lists && <span className="tree-count">{lists.tables.length + lists.views.length}</span>}
      </div>

      {loading && (
        <div className="tree-msg row">
          <span className="spinner" /> 正在加载表…
        </div>
      )}

      {loadError && (
        <div className="tree-msg error">
          <div className="pre-wrap">{loadError}</div>
          <div className="mt-1">
            <Button size="sm" variant="ghost" onClick={() => setLocalRefresh((n) => n + 1)}>
              重新加载
            </Button>
          </div>
        </div>
      )}

      {lists && (
        <>
          <div className="tree-section" onClick={() => setTablesOpen((v) => !v)}>
            {tablesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>表</span>
            <span className="tree-count">{lists.tables.length}</span>
          </div>
          {tablesOpen && (
            <div>
              {lists.tables.length === 0 && <div className="tree-msg">没有表</div>}
              {lists.tables.map((name) => renderObject(name, 'table'))}
            </div>
          )}

          <div className="tree-section" onClick={() => setViewsOpen((v) => !v)}>
            {viewsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>视图</span>
            <span className="tree-count">{lists.views.length}</span>
          </div>
          {viewsOpen && (
            <div>
              {lists.views.length === 0 && <div className="tree-msg">没有视图</div>}
              {lists.views.map((name) => renderObject(name, 'view'))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
