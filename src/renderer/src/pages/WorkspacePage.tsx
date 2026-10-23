import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Bot,
  Database,
  FolderOpen,
  GitCompare,
  Inbox,
  Loader2,
  Play,
  RefreshCw,
  PanelLeftClose,
  PanelLeftOpen,
  ScanSearch,
  Square,
  Table2,
  X
} from 'lucide-react'
import type {
  DatabaseInfo,
  ExecutionResult,
  HistoryEntry,
  JobEvent,
  PageResult,
  Project,
  SchemaChangeReport,
  SchemaObjectType,
  SqlPlan
} from '@shared/types'
import { ApiError, call, onEvent } from '../lib/api'
import { errorMessage, useAppStore } from '../lib/store'
import { formatDate, formatDuration, kindLabel, riskBadgeClass, riskLabel } from '../lib/format'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  IconButton,
  LoadingBlock,
  Modal,
  PageHeader,
  ProgressBar,
  Select
} from '../components/ui'
import { SqlEditor, type SqlEditorHandle } from '../components/workspace/SqlEditor'
import { ResultGrid } from '../components/workspace/ResultGrid'
import { DatabaseTree } from '../components/workspace/DatabaseTree'
import { PlanPreviewDialog } from '../components/workspace/PlanPreviewDialog'
import { TableDetailsPanel } from '../components/workspace/TableDetailsPanel'
import { TableBrowsePanel } from '../components/workspace/TableBrowsePanel'
import { WorkspaceAiFloat } from '../components/workspace/WorkspaceAiFloat'
import { SchemaDiffDialog } from '../components/workspace/SchemaDiffDialog'
import '../components/workspace/workspace.css'

type BottomTab = 'result' | 'messages' | 'history'
type TableMainTab = 'browse' | 'structure' | 'sql'

interface SelectedTable {
  name: string
  type: SchemaObjectType
}

const historyStatusLabel: Record<HistoryEntry['status'], string> = {
  planned: '已计划',
  running: '执行中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  denied: '已拒绝'
}

const historyStatusClass: Record<HistoryEntry['status'], string> = {
  planned: 'badge neutral',
  running: 'badge accent',
  success: 'badge ok',
  failed: 'badge danger',
  cancelled: 'badge warn',
  denied: 'badge danger'
}

function apiDetail(e: unknown): string {
  if (e instanceof ApiError) {
    return e.hint ? `${e.code}：${e.message}（${e.hint}）` : `${e.code}：${e.message}`
  }
  return errorMessage(e)
}

function quoteIdent(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``
}

export function WorkspacePage(): ReactNode {
  const connections = useAppStore((s) => s.connections)
  const currentProject = useAppStore((s) => s.currentProject)
  const currentProjectId = useAppStore((s) => s.currentProjectId)
  const activeConnectionId = useAppStore((s) => s.activeConnectionId)
  const activeDatabase = useAppStore((s) => s.activeDatabase)
  const schema = useAppStore((s) => s.schema)
  const setActiveConnection = useAppStore((s) => s.setActiveConnection)
  const setActiveDatabase = useAppStore((s) => s.setActiveDatabase)
  const setSchema = useAppStore((s) => s.setSchema)
  const openProject = useAppStore((s) => s.openProject)
  const closeProject = useAppStore((s) => s.closeProject)
  const refreshConnections = useAppStore((s) => s.refreshConnections)
  const navigate = useAppStore((s) => s.navigate)
  const pushToast = useAppStore((s) => s.pushToast)
  const toastError = useAppStore((s) => s.toastError)
  const toastOk = useAppStore((s) => s.toastOk)
  const agentBusy = useAppStore((s) => s.agentBusy)
  const guardAgentBusy = useAppStore((s) => s.guardAgentBusy)

  const editorRef = useRef<SqlEditorHandle>(null)
  const [sql, setSql] = useState('')
  const sqlRef = useRef(sql)
  sqlRef.current = sql
  const [selectionLength, setSelectionLength] = useState(0)

  /* ------------------------------------------------- connection / db */
  const [connectionsError, setConnectionsError] = useState<string | null>(null)
  const [databases, setDatabases] = useState<DatabaseInfo[]>([])
  const [dbLoading, setDbLoading] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)
  const [dbRefreshToken, setDbRefreshToken] = useState(0)

  /* ------------------------------------------------------ object tree */
  const [treeRefreshToken, setTreeRefreshToken] = useState(0)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [selectedTable, setSelectedTable] = useState<SelectedTable | null>(null)
  const [tableTab, setTableTab] = useState<TableMainTab>('browse')
  const [aiOpen, setAiOpen] = useState(false)
  const [aiSeed, setAiSeed] = useState<{ message: string; autoSend?: boolean } | null>(null)

  const openWorkspaceAi = useCallback((message: string, options?: { autoSend?: boolean }) => {
    setAiSeed({ message, autoSend: options?.autoSend ?? true })
    setAiOpen(true)
  }, [])

  /* -------------------------------------------------------- planning */
  const [plan, setPlan] = useState<SqlPlan | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<unknown>(null)
  const [confirming, setConfirming] = useState(false)

  /* ------------------------------------------------------- execution */
  const [executing, setExecuting] = useState(false)
  const [runningPlanId, setRunningPlanId] = useState<string | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [result, setResult] = useState<ExecutionResult | null>(null)
  const [execError, setExecError] = useState<unknown>(null)
  const [bottomTab, setBottomTab] = useState<BottomTab>('result')

  /* -------------------------------------------------- schema commands */
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<JobEvent | null>(null)
  const [scanError, setScanError] = useState<unknown>(null)
  const [detectBusy, setDetectBusy] = useState(false)
  const [detectError, setDetectError] = useState<unknown>(null)
  const [changeReport, setChangeReport] = useState<SchemaChangeReport | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)

  /* --------------------------------------------------- project picker */
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerProjects, setPickerProjects] = useState<Project[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null)

  /* ---------------------------------------------------------- history */
  const [historyPage, setHistoryPage] = useState<PageResult<HistoryEntry> | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<unknown>(null)
  const [historyReloadKey, setHistoryReloadKey] = useState(0)

  const loadConnections = useCallback(async (): Promise<void> => {
    setConnectionsError(null)
    try {
      await refreshConnections()
    } catch (e) {
      setConnectionsError(apiDetail(e))
    }
  }, [refreshConnections])

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  const loadDatabases = useCallback(
    async (connectionId: string): Promise<void> => {
      setDbLoading(true)
      setDbError(null)
      try {
        const list = await call('schema.listDatabases', { connectionId })
        setDatabases(list)
        const state = useAppStore.getState()
        const stillValid = list.some((database) => database.name === state.activeDatabase)
        if (!stillValid) {
          const preferred = state.connections.find((c) => c.id === connectionId)?.database
          const picked =
            list.find((database) => database.name === preferred) ??
            list.find((database) => !database.isSystem) ??
            list[0]
          state.setActiveDatabase(picked?.name ?? '')
        }
      } catch (e) {
        setDatabases([])
        setDbError(apiDetail(e))
      } finally {
        setDbLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    if (!activeConnectionId) {
      setDatabases([])
      setDbError(null)
      return
    }
    void loadDatabases(activeConnectionId)
  }, [activeConnectionId, dbRefreshToken, loadDatabases])

  // Live schema scan progress + auto refresh of the tree when the main process
  // reports a schema change for the current project.
  useEffect(() => {
    const offJob = onEvent('job.event', (event) => {
      if (event.kind === 'schema_scan') setScanProgress(event)
    })
    const offSchema = onEvent('schema.changed', (payload) => {
      const state = useAppStore.getState()
      if (state.currentProjectId && payload.projectId === state.currentProjectId) {
        setTreeRefreshToken((token) => token + 1)
        if (payload.diff) {
          setChangeReport({
            changed: true,
            diff: payload.diff,
            invalidatedMemories: payload.invalidatedMemories,
            staleMemories: 0
          })
        }
      }
    })
    return () => {
      offJob()
      offSchema()
    }
  }, [])

  /* ------------------------------------------------------- planning */

  const requestPlan = async (): Promise<void> => {
    setPlanError(null)
    if (guardAgentBusy('预览/执行 SQL')) return
    if (!activeConnectionId) {
      setPlanError(new Error('请先选择数据库连接'))
      return
    }
    if (!activeDatabase) {
      setPlanError(new Error('请先选择数据库'))
      return
    }
    const selected = editorRef.current?.getSelection().trim() ?? ''
    const sqlToRun = selected || sqlRef.current.trim()
    if (!sqlToRun) {
      setPlanError(new Error('请输入要执行的 SQL'))
      return
    }
    if (selected) {
      pushToast({ kind: 'info', title: '将预览选中的 SQL', body: `选中 ${selected.length} 个字符` })
    }
    setPlanning(true)
    try {
      // Step 1: trusted layer builds the plan (risk/impact/recovery). The
      // renderer never guesses any of these values and never executes SQL here.
      const created = await call('sql.plan', {
        connectionId: activeConnectionId,
        sql: sqlToRun,
        database: activeDatabase,
        projectId: currentProjectId ?? undefined
      })
      setPlan(created)
      setPreviewOpen(true)
    } catch (e) {
      setPlanError(e)
      toastError(e)
    } finally {
      setPlanning(false)
    }
  }

  const closePreview = useCallback((): void => {
    const duePlan = plan
    setPreviewOpen(false)
    setPlan(null)
    if (!duePlan || !duePlan.requiresApproval) return
    // A dismissed approval preview is a denial: it is recorded in the audit
    // trail instead of silently leaving a pending approval behind.
    call('approval.deny', { planId: duePlan.planId }).catch((e: unknown) => toastError(e))
  }, [plan, toastError])

  const confirmPlan = async (comment: string): Promise<void> => {
    const duePlan = plan
    if (!duePlan) return
    setPlanError(null)
    setExecError(null)
    setConfirming(true)
    try {
      // Step 2: explicit user approval, ONLY for plans that require it.
      // The main process re-checks approval status + plan hash before executing.
      if (duePlan.requiresApproval) {
        await call('approval.approve', { planId: duePlan.planId, comment: comment || undefined })
      }
      setPreviewOpen(false)
      setPlan(null)
      setExecuting(true)
      setRunningPlanId(duePlan.planId)
      // Step 3: execute the exact plan id that was approved (single use).
      const execution = await call('sql.execute', { planId: duePlan.planId, confirmed: true })
      setResult(execution)
      setBottomTab('result')
      setHistoryReloadKey((key) => key + 1)
      setTreeRefreshToken((token) => token + 1)
      if (execution.ok) {
        toastOk(
          '执行完成',
          `耗时 ${formatDuration(execution.durationMs)}${execution.recoveryPointId ? ' · 已创建恢复点' : ''}`
        )
      } else {
        pushToast({
          kind: 'error',
          title: '执行失败',
          body: execution.error?.message ?? '服务端返回执行失败'
        })
      }
    } catch (e) {
      setPreviewOpen(false)
      setPlan(null)
      setExecError(e)
      toastError(e)
    } finally {
      setConfirming(false)
      setExecuting(false)
      setRunningPlanId(null)
    }
  }

  const cancelExecution = async (): Promise<void> => {
    if (!runningPlanId) return
    setCancelBusy(true)
    try {
      const response = await call('sql.cancel', { planId: runningPlanId })
      pushToast({
        kind: response.cancelled ? 'warn' : 'info',
        title: response.cancelled ? '已发送取消请求' : '没有可取消的执行',
        body: runningPlanId
      })
    } catch (e) {
      toastError(e)
    } finally {
      setCancelBusy(false)
    }
  }

  /* -------------------------------------------------- schema commands */

  const handleScan = async (): Promise<void> => {
    setScanError(null)
    if (guardAgentBusy('结构扫描')) return
    if (!activeConnectionId || !activeDatabase) {
      setScanError(new Error('请先选择数据库连接和数据库'))
      return
    }
    setScanning(true)
    setScanProgress(null)
    try {
      const snapshot = await call('schema.scan', {
        connectionId: activeConnectionId,
        database: activeDatabase,
        projectId: currentProjectId ?? undefined,
        includeRowCounts: true
      })
      setSchema(snapshot)
      setTreeRefreshToken((token) => token + 1)
      toastOk('结构扫描完成', `${snapshot.objectCount} 个对象 · ${snapshot.serverVersion}`)
    } catch (e) {
      setScanError(e)
      toastError(e)
    } finally {
      setScanning(false)
    }
  }

  const handleDetectChanges = async (): Promise<void> => {
    setDetectError(null)
    if (!currentProjectId) {
      setDetectError(new Error('请先打开项目后再检测结构变化'))
      return
    }
    setDetectBusy(true)
    try {
      const report = await call('schema.detectChanges', { projectId: currentProjectId })
      setChangeReport(report)
      setDiffOpen(true)
      if (report.newSnapshot) setSchema(report.newSnapshot)
      if (report.changed) setTreeRefreshToken((token) => token + 1)
    } catch (e) {
      setDetectError(e)
      toastError(e)
    } finally {
      setDetectBusy(false)
    }
  }

  /* ------------------------------------------------------ project UI */

  const openProjectPicker = async (): Promise<void> => {
    setPickerOpen(true)
    setPickerError(null)
    setPickerLoading(true)
    setPickerProjects(useAppStore.getState().projects)
    try {
      const list = await call('project.list', undefined)
      setPickerProjects(list)
    } catch (e) {
      setPickerError(apiDetail(e))
    } finally {
      setPickerLoading(false)
    }
  }

  const handleOpenProject = async (project: Project): Promise<void> => {
    setOpeningProjectId(project.id)
    try {
      await openProject(project.id)
      const state = useAppStore.getState()
      const connection = state.connections.find((c) => c.id === state.activeConnectionId)
      const database = state.schema?.database || connection?.database || ''
      if (database) state.setActiveDatabase(database)
      setPickerOpen(false)
      setTreeRefreshToken((token) => token + 1)
      toastOk('项目已打开', project.name)
    } catch (e) {
      toastError(e)
    } finally {
      setOpeningProjectId(null)
    }
  }

  const handleCloseProject = (): void => {
    closeProject()
    toastOk('已关闭项目', '当前编辑不会关联到项目')
  }

  /* --------------------------------------------------------- history */

  const loadHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const page = await call('sql.history.list', {
        projectId: currentProjectId ?? undefined,
        connectionId: activeConnectionId ?? undefined,
        limit: 20,
        offset: 0
      })
      setHistoryPage(page)
    } catch (e) {
      setHistoryError(e)
      setHistoryPage(null)
    } finally {
      setHistoryLoading(false)
    }
  }, [currentProjectId, activeConnectionId])

  useEffect(() => {
    if (bottomTab !== 'history') return
    void loadHistory()
  }, [bottomTab, historyReloadKey, loadHistory])

  /* ------------------------------------------------------- tree/editor */

  const insertSelectFor = (name: string, type: SchemaObjectType): void => {
    if (!activeDatabase) return
    const sqlText = `SELECT * FROM ${quoteIdent(activeDatabase)}.${quoteIdent(name)} LIMIT 100;`
    setSelectedTable({ name, type })
    setTableTab('sql')
    setSql(sqlText)
    // Focus editor after tab switch paints.
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }

  const openTableBrowse = (name: string, type: SchemaObjectType): void => {
    setSelectedTable({ name, type })
    setTableTab('browse')
  }

  const handleSqlChange = (value: string): void => {
    setSql(value)
    const selected = editorRef.current?.getSelection().length ?? 0
    setSelectionLength(selected)
  }

  // Keep the "执行范围" hint in sync with the editor selection.
  useEffect(() => {
    const update = (): void => setSelectionLength(editorRef.current?.getSelection().length ?? 0)
    const id = window.setInterval(update, 400)
    return () => window.clearInterval(id)
  }, [])

  /* ----------------------------------------------------------- render */

  const connectionOptions = useMemo(
    () => [
      { value: '', label: connections.length === 0 ? '暂无连接' : '选择连接' },
      ...connections.map((connection) => ({
        value: connection.id,
        label: `${connection.name}（${connection.host}:${connection.port}）`
      }))
    ],
    [connections]
  )

  const databaseOptions = useMemo(
    () => [
      { value: '', label: dbLoading ? '加载中…' : '选择数据库' },
      ...databases.map((database) => ({
        value: database.name,
        label: `${database.name}${database.isSystem ? '（系统）' : ''}`
      }))
    ],
    [databases, dbLoading]
  )

  const executionScope = selectionLength > 0 ? `选中文本（${selectionLength} 字符）` : '全部 SQL'
  const targetTableLabel = selectedTable ? `${selectedTable.name}` : '—'
  const projectConnectionMismatch =
    currentProject?.connectionId !== null &&
    currentProject?.connectionId !== undefined &&
    currentProject.connectionId !== activeConnectionId

  const renderMessages = (): ReactNode => {
    if (!result) return <div className="ws-placeholder">执行后在此查看逐条语句消息与警告。</div>
    return (
      <div>
        <div className="result-meta">
          <Badge className={result.ok ? 'badge ok' : 'badge danger'}>{result.ok ? '成功' : '失败'}</Badge>
          <span>耗时 {formatDuration(result.durationMs)}</span>
          <span>语句数 {result.statements.length}</span>
          <span className="mono xs">audit：{result.auditEventId}</span>
        </div>
        {result.error && (
          <div className="mb-2">
            <Callout kind="danger" title={`错误（${result.error.code}）`}>
              <div className="pre-wrap">{result.error.message}</div>
              {result.error.hint && <div className="small mt-1">建议：{result.error.hint}</div>}
            </Callout>
          </div>
        )}
        {result.warning && (
          <div className="mb-2">
            <Callout kind="warn" title="警告">
              {result.warning}
            </Callout>
          </div>
        )}
        <div className="statement-list">
          {result.statements.map((statement) => (
            <div key={statement.statementIndex} className="statement-item">
              <div className="row wrap">
                <Badge className="badge neutral">#{statement.statementIndex + 1}</Badge>
                <span className="strong">{kindLabel[statement.kind] ?? statement.kind}</span>
                <Badge className={statement.ok ? 'badge ok' : 'badge danger'}>{statement.ok ? '成功' : '失败'}</Badge>
                <span className="small muted">
                  影响 {statement.affectedRows} 行 · 返回 {statement.rowCount} 行 · {formatDuration(statement.durationMs)}
                </span>
                {statement.recoveryPointId && (
                  <span className="mono xs muted">恢复点：{statement.recoveryPointId}</span>
                )}
              </div>
              <div className="stmt-sql">{statement.sql}</div>
              {statement.error && (
                <div className="small mt-1" style={{ color: '#ff9d9d' }}>
                  {statement.error.code}：{statement.error.message}
                  {statement.error.hint ? `（${statement.error.hint}）` : ''}
                </div>
              )}
              {statement.warnings.length > 0 && (
                <ul className="warn-list">
                  {statement.warnings.map((warning, index) => (
                    <li key={`${warning}-${index}`}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderHistoryTab = (): ReactNode => {
    if (historyLoading) return <LoadingBlock label="正在加载操作历史…" />
    if (historyError) {
      return (
        <Callout kind="danger" title="操作历史加载失败">
          <div className="pre-wrap">{apiDetail(historyError)}</div>
          <div className="mt-2">
            <Button size="sm" onClick={() => void loadHistory()}>
              重试
            </Button>
          </div>
        </Callout>
      )
    }
    if (!historyPage || historyPage.items.length === 0) {
      return <div className="ws-placeholder">还没有操作历史。执行 SQL 后会自动记录到操作历史（含审计事件）。</div>
    }
    return (
      <div>
        <div className="row between mb-2">
          <span className="small muted">共 {historyPage.total} 条记录（最近 {historyPage.items.length} 条）</span>
          <Button size="sm" variant="ghost" onClick={() => navigate('history')}>
            打开操作历史页
          </Button>
        </div>
        <div className="table-wrap history-table">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 140 }}>时间</th>
                <th style={{ width: 76 }}>类型</th>
                <th style={{ width: 70 }}>风险</th>
                <th style={{ width: 82 }}>状态</th>
                <th style={{ width: 78, textAlign: 'right' }}>影响行数</th>
                <th style={{ width: 78, textAlign: 'right' }}>耗时</th>
                <th>SQL 摘要</th>
              </tr>
            </thead>
            <tbody>
              {historyPage.items.map((entry) => (
                <tr key={entry.id} onClick={() => navigate('history')} style={{ cursor: 'pointer' }}>
                  <td className="small mono">{formatDate(entry.executedAt)}</td>
                  <td>{kindLabel[entry.kind] ?? entry.kind}</td>
                  <td>
                    <span className={riskBadgeClass[entry.risk]}>{riskLabel[entry.risk]}</span>
                  </td>
                  <td>
                    <Badge className={historyStatusClass[entry.status]}>{historyStatusLabel[entry.status]}</Badge>
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {entry.affectedRows}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {formatDuration(entry.durationMs)}
                  </td>
                  <td className="sql-preview-cell" title={entry.sql}>
                    {entry.sql.replace(/\s+/g, ' ').slice(0, 120)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {historyPage.items.some((entry) => entry.recoveryPointId) && (
          <div className="small muted mt-2">
            部分记录包含恢复点，可在“操作历史”页查看详情并跳转时间机器。
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader
        title="数据库工作区"
        sub={
          currentProject
            ? `项目：${currentProject.name} · 点选左侧表浏览数据（类 phpMyAdmin）`
            : '未打开项目也可浏览；点选左侧表查看数据，表结构在「表结构」页签'
        }
        actions={
          <>
            {currentProject ? (
              <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={handleCloseProject}>
                关闭项目
              </Button>
            ) : (
              <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void openProjectPicker()}>
                打开项目
              </Button>
            )}
            <Button
              size="sm"
              icon={<ScanSearch size={13} />}
              loading={scanning}
              disabled={!activeConnectionId || !activeDatabase}
              onClick={() => void handleScan()}
              title="扫描数据库结构并生成快照（会写入项目）"
            >
              扫描结构
            </Button>
            <Button
              size="sm"
              icon={<GitCompare size={13} />}
              loading={detectBusy}
              disabled={!currentProjectId}
              onClick={() => void handleDetectChanges()}
              title={currentProjectId ? '对比当前结构与项目快照' : '请先打开项目'}
            >
              检测结构变化
            </Button>
          </>
        }
      />

      <div className="page-body flush">
        <div className={`ws-body ${treeCollapsed ? 'tree-collapsed' : ''}`}>
          <aside className={`ws-side ${treeCollapsed ? 'collapsed' : ''}`}>
            <button
              type="button"
              className="ws-tree-toggle"
              title={treeCollapsed ? '展开对象树' : '收起对象树'}
              onClick={() => setTreeCollapsed((v) => !v)}
            >
              {treeCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>
            {!treeCollapsed && (
              <>
                <div className="ws-side-body">
                  <DatabaseTree
                    connectionId={activeConnectionId}
                    database={activeDatabase}
                    refreshToken={treeRefreshToken}
                    selectedTable={selectedTable?.name ?? null}
                    onSelectTable={openTableBrowse}
                    onInsertTable={insertSelectFor}
                  />
                </div>
                <div className="ws-side-foot">
                  {schema ? (
                    <>
                      <div>
                        最近快照：{schema.objectCount} 个对象 · {formatDate(schema.takenAt)}
                      </div>
                      <div className="mono xs" title={schema.schemaHash}>
                        hash {schema.schemaHash.slice(0, 16)} · v{schema.version}
                      </div>
                    </>
                  ) : (
                    <div>尚未扫描结构。扫描后可检测结构变化并生成 Schema 记忆。</div>
                  )}
                  {projectConnectionMismatch && (
                    <div className="mt-1" style={{ color: 'var(--warn)' }}>
                      当前连接与项目关联连接不一致；扫描结果仍会写入该项目，请确认目标数据库。
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>

          <section className="ws-main">
            <div className="ws-toolbar">
              <span className="ws-toolbar-label">连接</span>
              <Select<string>
                value={activeConnectionId ?? ''}
                options={connectionOptions}
                onChange={(value) => setActiveConnection(value || null)}
                disabled={connections.length === 0}
              />
              <span className="ws-toolbar-label">数据库</span>
              <Select<string>
                value={activeDatabase}
                options={databaseOptions}
                onChange={(value) => setActiveDatabase(value)}
                disabled={!activeConnectionId || dbLoading}
              />
              <IconButton
                title="刷新数据库列表"
                onClick={() => setDbRefreshToken((token) => token + 1)}
              >
                <RefreshCw size={14} />
              </IconButton>
              <div className="ws-toolbar-sep" />
              <span className="small muted">
                执行范围：<span className="dim">{executionScope}</span>
              </span>
              <span className="small muted">
                当前表：<span className="dim mono">{targetTableLabel}</span>
              </span>
              <span className="spacer" />
              {dbError && <span className="small" style={{ color: '#ff9d9d' }}>数据库列表加载失败：{dbError}</span>}
              {connectionsError && (
                <span className="small" style={{ color: '#ff9d9d' }}>
                  连接列表加载失败：{connectionsError}
                  <button type="button" className="btn sm ghost" onClick={() => void loadConnections()}>
                    重试
                  </button>
                </span>
              )}
            </div>

            {agentBusy.busy && (
              <div className="ws-ai-busy-banner">
                <Bot size={14} />
                <span>
                  正在进行 AI 任务
                  {agentBusy.tasks[0]?.title ? `：${agentBusy.tasks[0].title.slice(0, 48)}` : ''}
                  。SQL / 扫描已暂缓；表浏览可继续使用本地缓存预览。
                </span>
              </div>
            )}

            {scanning && (
              <div className="ws-progress">
                {scanProgress ? (
                  <ProgressBar
                    value={scanProgress.progress}
                    label={`${scanProgress.phase} · ${scanProgress.message}`}
                  />
                ) : (
                  <div className="row small muted">
                    <Loader2 size={13} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
                    正在扫描结构…
                  </div>
                )}
              </div>
            )}

            {(scanError !== null || detectError !== null) && (
              <div className="ws-progress">
                {scanError !== null && (
                  <Callout kind="danger" title="结构扫描失败">
                    <div className="pre-wrap">{apiDetail(scanError)}</div>
                  </Callout>
                )}
                {detectError !== null && (
                  <div className={scanError !== null ? 'mt-2' : undefined}>
                    <Callout kind="danger" title="结构变化检测失败">
                      <div className="pre-wrap">{apiDetail(detectError)}</div>
                    </Callout>
                  </div>
                )}
              </div>
            )}

            {selectedTable && activeConnectionId && activeDatabase ? (
              <div className="ws-table-main">
                <div className="tabs ws-table-tabs">
                  <button
                    type="button"
                    className={`tab ${tableTab === 'browse' ? 'active' : ''}`}
                    onClick={() => setTableTab('browse')}
                  >
                    浏览数据
                  </button>
                  <button
                    type="button"
                    className={`tab ${tableTab === 'structure' ? 'active' : ''}`}
                    onClick={() => setTableTab('structure')}
                  >
                    表结构
                  </button>
                  <button
                    type="button"
                    className={`tab ${tableTab === 'sql' ? 'active' : ''}`}
                    onClick={() => setTableTab('sql')}
                  >
                    SQL
                  </button>
                  <span className="spacer" />
                  <span className="muted xs mono truncate" title={selectedTable.name}>
                    {selectedTable.name}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedTable(null)} title="关闭表视图">
                    <X size={12} /> 关闭
                  </Button>
                </div>
                <div className="ws-table-panel">
                  {tableTab === 'browse' && (
                    <TableBrowsePanel
                      connectionId={activeConnectionId}
                      database={activeDatabase}
                      table={selectedTable.name}
                      projectId={currentProjectId}
                      onAskAi={openWorkspaceAi}
                    />
                  )}
                  {tableTab === 'structure' && (
                    <TableDetailsPanel
                      variant="inline"
                      connectionId={activeConnectionId}
                      database={activeDatabase}
                      table={selectedTable.name}
                      type={selectedTable.type}
                      onInsertSelect={() => insertSelectFor(selectedTable.name, selectedTable.type)}
                    />
                  )}
                  {tableTab === 'sql' && (
                    <div className="ws-table-sql">
                      <div className="ws-editor-pane grow">
                        <div className="ws-editor-head">
                          <Table2 size={13} style={{ color: 'var(--text-muted)' }} />
                          <span className="small dim">SQL 编辑器</span>
                          <span className="spacer" />
                          <span className="xs muted">Ctrl/Cmd + Enter 预览执行计划</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setSql('')
                              editorRef.current?.focus()
                            }}
                            disabled={!sql}
                          >
                            清空
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            icon={<Play size={13} />}
                            loading={planning}
                            disabled={executing || !activeConnectionId}
                            onClick={() => void requestPlan()}
                          >
                            预览执行计划
                          </Button>
                        </div>
                        <div className="ws-editor-host">
                          <SqlEditor
                            ref={editorRef}
                            value={sql}
                            onChange={handleSqlChange}
                            onExecute={() => void requestPlan()}
                          />
                        </div>
                      </div>
                      <div className="ws-result-pane">
                        <div className="tabs" style={{ padding: '0 8px' }}>
                          <button
                            type="button"
                            className={`tab ${bottomTab === 'result' ? 'active' : ''}`}
                            onClick={() => setBottomTab('result')}
                          >
                            结果
                          </button>
                          <button
                            type="button"
                            className={`tab ${bottomTab === 'messages' ? 'active' : ''}`}
                            onClick={() => setBottomTab('messages')}
                          >
                            消息
                          </button>
                          <button
                            type="button"
                            className={`tab ${bottomTab === 'history' ? 'active' : ''}`}
                            onClick={() => setBottomTab('history')}
                          >
                            历史
                          </button>
                          <span className="spacer" />
                          {executing && (
                            <span className="row small" style={{ color: 'var(--accent)', paddingRight: 4 }}>
                              <Loader2 size={13} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
                              正在执行…
                              <Button
                                size="sm"
                                variant="danger"
                                icon={<Square size={11} />}
                                loading={cancelBusy}
                                onClick={() => void cancelExecution()}
                              >
                                取消
                              </Button>
                            </span>
                          )}
                        </div>
                        <div className="ws-results">
                          {bottomTab === 'result' &&
                            (result ? (
                              <ResultGrid result={result} />
                            ) : (
                              <div className="ws-placeholder">执行 SQL 后结果会显示在这里。</div>
                            ))}
                          {bottomTab === 'messages' && renderMessages()}
                          {bottomTab === 'history' && renderHistoryTab()}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="ws-editor-pane">
                  <div className="ws-editor-head">
                    <Table2 size={13} style={{ color: 'var(--text-muted)' }} />
                    <span className="small dim">SQL 编辑器</span>
                    <span className="spacer" />
                    <span className="xs muted">左侧点选表可浏览数据 · Ctrl/Cmd + Enter 预览计划</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSql('')
                        editorRef.current?.focus()
                      }}
                      disabled={!sql}
                    >
                      清空
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Play size={13} />}
                      loading={planning}
                      disabled={executing || !activeConnectionId}
                      onClick={() => void requestPlan()}
                    >
                      预览执行计划
                    </Button>
                  </div>
                  <div className="ws-editor-host">
                    <SqlEditor ref={editorRef} value={sql} onChange={handleSqlChange} onExecute={() => void requestPlan()} />
                  </div>
                </div>

                <div className="ws-result-pane">
                  <div className="tabs" style={{ padding: '0 8px' }}>
                    <button
                      type="button"
                      className={`tab ${bottomTab === 'result' ? 'active' : ''}`}
                      onClick={() => setBottomTab('result')}
                    >
                      结果
                    </button>
                    <button
                      type="button"
                      className={`tab ${bottomTab === 'messages' ? 'active' : ''}`}
                      onClick={() => setBottomTab('messages')}
                    >
                      消息
                      {result && result.statements.length > 0 ? ` (${result.statements.length})` : ''}
                    </button>
                    <button
                      type="button"
                      className={`tab ${bottomTab === 'history' ? 'active' : ''}`}
                      onClick={() => setBottomTab('history')}
                    >
                      历史
                    </button>
                    <span className="spacer" />
                    {executing && (
                      <span className="row small" style={{ color: 'var(--accent)', paddingRight: 4 }}>
                        <Loader2 size={13} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
                        正在执行…
                        <Button
                          size="sm"
                          variant="danger"
                          icon={<Square size={11} />}
                          loading={cancelBusy}
                          onClick={() => void cancelExecution()}
                        >
                          取消执行
                        </Button>
                      </span>
                    )}
                  </div>
                  <div className="ws-results">
                    {bottomTab === 'result' && (
                      <>
                        {planError !== null && (
                          <div className="mb-2">
                            <Callout kind="danger" title="无法生成执行计划">
                              <div className="pre-wrap">{apiDetail(planError)}</div>
                            </Callout>
                          </div>
                        )}
                        {execError !== null && (
                          <div className="mb-2">
                            <Callout kind="danger" title="执行请求失败">
                              <div className="pre-wrap">{apiDetail(execError)}</div>
                            </Callout>
                          </div>
                        )}
                        {executing && !result && (
                          <div className="ws-placeholder">
                            <span className="spinner" /> 正在执行…
                          </div>
                        )}
                        {result ? (
                          <ResultGrid result={result} />
                        ) : !executing && !planError && !execError ? (
                          !connections.length ? (
                            <EmptyState
                              icon={<Database size={22} />}
                              title="还没有数据库连接"
                              body="请先在首页添加 MySQL / MariaDB 连接，然后回到工作区浏览表数据。"
                              action={
                                <Button size="sm" onClick={() => navigate('home')}>
                                  去首页添加连接
                                </Button>
                              }
                            />
                          ) : !activeConnectionId || !activeDatabase ? (
                            <EmptyState
                              icon={<Database size={22} />}
                              title="请选择连接与数据库"
                              body="选择后会加载对象树。点击左侧表名即可像 phpMyAdmin 一样浏览数据。"
                            />
                          ) : (
                            <div className="ws-placeholder">
                              <Inbox size={20} style={{ opacity: 0.5 }} />
                              <div className="mt-1">
                                在左侧选择一张表以浏览数据；或在上方编写 SQL 后点击「预览执行计划」。
                              </div>
                            </div>
                          )
                        ) : null}
                      </>
                    )}
                    {bottomTab === 'messages' && renderMessages()}
                    {bottomTab === 'history' && renderHistoryTab()}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      <PlanPreviewDialog
        plan={plan}
        open={previewOpen}
        busy={confirming || executing}
        onCancel={closePreview}
        onConfirm={(comment) => void confirmPlan(comment)}
      />

      <SchemaDiffDialog
        report={changeReport}
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        onRefreshTree={() => {
          setDiffOpen(false)
          setTreeRefreshToken((token) => token + 1)
        }}
      />

      <Modal
        open={pickerOpen}
        title="打开项目"
        onClose={() => setPickerOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPickerOpen(false)}>
              取消
            </Button>
          </>
        }
      >
        {pickerError && (
          <div className="mb-2">
            <Callout kind="danger" title="项目列表加载失败">
              <div className="pre-wrap">{pickerError}</div>
              <div className="mt-2">
                <Button size="sm" onClick={() => void openProjectPicker()}>
                  重试
                </Button>
              </div>
            </Callout>
          </div>
        )}
        {pickerLoading ? (
          <LoadingBlock label="正在加载项目…" />
        ) : pickerProjects.length === 0 ? (
          <EmptyState
            icon={<FolderOpen size={22} />}
            title="还没有项目"
            body="请先到首页创建项目（关联连接与结构快照）。"
            action={
              <Button size="sm" onClick={() => navigate('home')}>
                去首页创建
              </Button>
            }
          />
        ) : (
          <div className="conn-list">
            {pickerProjects.map((project) => (
              <div key={project.id} className="conn-row">
                <div className="conn-main">
                  <div className="conn-name">
                    <FolderOpen size={14} style={{ color: 'var(--accent)' }} />
                    <span className="truncate">{project.name}</span>
                    {currentProjectId === project.id && <Badge className="badge accent">当前项目</Badge>}
                  </div>
                  <div className="conn-meta">
                    <span>{project.description || '暂无描述'}</span>
                    <span>更新 {formatDate(project.updatedAt)}</span>
                  </div>
                </div>
                <div className="conn-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={openingProjectId === project.id}
                    onClick={() => void handleOpenProject(project)}
                  >
                    打开
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <WorkspaceAiFloat
        open={aiOpen}
        onOpenChange={setAiOpen}
        seed={aiSeed}
        onSeedConsumed={() => setAiSeed(null)}
        connectionId={activeConnectionId}
        database={activeDatabase}
        projectId={currentProjectId}
        table={selectedTable?.name ?? null}
      />
    </div>
  )
}
