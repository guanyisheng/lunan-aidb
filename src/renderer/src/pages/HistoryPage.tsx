import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Clock4,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X
} from 'lucide-react'
import type { HistoryEntry, HistoryQuery, PageResult, RiskLevel } from '@shared/types'
import { ApiError, call } from '../lib/api'
import { errorMessage, useAppStore } from '../lib/store'
import { formatDate, formatDuration, formatRelative, kindLabel, riskLabel } from '../lib/format'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  IconButton,
  LoadingBlock,
  PageHeader,
  RiskBadge,
  Select
} from '../components/ui'
import '../components/workspace/workspace.css'

const statusLabel: Record<HistoryEntry['status'], string> = {
  planned: '已计划',
  running: '执行中',
  success: '成功',
  failed: '失败',
  cancelled: '已取消',
  denied: '已拒绝'
}

const statusClass: Record<HistoryEntry['status'], string> = {
  planned: 'badge neutral',
  running: 'badge accent',
  success: 'badge ok',
  failed: 'badge danger',
  cancelled: 'badge warn',
  denied: 'badge danger'
}

const triggerLabel: Record<HistoryEntry['trigger'], string> = {
  user: '用户',
  agent: 'AI Agent',
  system: '系统'
}

const riskLevels: RiskLevel[] = ['none', 'low', 'medium', 'high', 'critical']

function apiDetail(e: unknown): string {
  if (e instanceof ApiError) {
    return e.hint ? `${e.code}：${e.message}（${e.hint}）` : `${e.code}：${e.message}`
  }
  return errorMessage(e)
}

function PageButton(props: { onClick: () => void; disabled?: boolean; children: ReactNode; title?: string }): ReactNode {
  return (
    <Button size="sm" variant="ghost" onClick={props.onClick} disabled={props.disabled} title={props.title}>
      {props.children}
    </Button>
  )
}

/**
 * Operation history page. All data comes from `sql.history.list` /
 * `sql.history.get`; recovery/backup/audit ids are displayed exactly as
 * recorded so the user can verify protection states in the time machine.
 */
export function HistoryPage(): ReactNode {
  const projects = useAppStore((s) => s.projects)
  const connections = useAppStore((s) => s.connections)
  const refreshProjects = useAppStore((s) => s.refreshProjects)
  const refreshConnections = useAppStore((s) => s.refreshConnections)
  const navigate = useAppStore((s) => s.navigate)

  const [projectId, setProjectId] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [status, setStatus] = useState('')
  const [risk, setRisk] = useState('')
  const [limit, setLimit] = useState(20)
  const [offset, setOffset] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)

  const [page, setPage] = useState<PageResult<HistoryEntry> | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [filtersError, setFiltersError] = useState<string | null>(null)

  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<HistoryEntry | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<unknown>(null)

  const loadFilters = useCallback(async (): Promise<void> => {
    setFiltersError(null)
    try {
      await Promise.all([refreshProjects(), refreshConnections()])
    } catch (e) {
      setFiltersError(apiDetail(e))
    }
  }, [refreshProjects, refreshConnections])

  useEffect(() => {
    void loadFilters()
  }, [loadFilters])

  const loadPage = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const query: HistoryQuery = {
        limit,
        offset,
        projectId: projectId || undefined,
        connectionId: connectionId || undefined,
        status: (status || undefined) as HistoryEntry['status'] | undefined,
        risk: (risk || undefined) as RiskLevel | undefined
      }
      const result = await call('sql.history.list', query)
      setPage(result)
    } catch (e) {
      setLoadError(e)
    } finally {
      setLoading(false)
    }
  }, [projectId, connectionId, status, risk, limit, offset, reloadKey])

  useEffect(() => {
    void loadPage()
  }, [loadPage])

  const loadDetail = useCallback(async (id: string): Promise<void> => {
    setDetailLoading(true)
    setDetailError(null)
    setDetail(null)
    try {
      const entry = await call('sql.history.get', { id })
      if (entry === null) {
        setDetailError(new Error('该操作记录不存在或已被清理'))
      } else {
        setDetail(entry)
      }
    } catch (e) {
      setDetailError(e)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const openDetail = (entry: HistoryEntry): void => {
    setDetailId(entry.id)
    void loadDetail(entry.id)
  }

  const closeDetail = (): void => {
    setDetailId(null)
    setDetail(null)
    setDetailError(null)
  }

  const resetFilters = (): void => {
    setProjectId('')
    setConnectionId('')
    setStatus('')
    setRisk('')
    setOffset(0)
  }

  const applyFilter = (apply: () => void): void => {
    apply()
    setOffset(0)
  }

  const total = page?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const currentPage = Math.floor(offset / limit) + 1
  const hasFilters = Boolean(projectId || connectionId || status || risk)

  const connectionName = (id: string): string => {
    const connection = connections.find((c) => c.id === id)
    return connection ? connection.name : id
  }

  const projectName = (id: string | null): string => {
    if (!id) return '未关联项目'
    const project = projects.find((p) => p.id === id)
    return project ? project.name : id
  }

  return (
    <div className="page">
      <PageHeader
        title="操作历史"
        sub="SQL、执行状态、影响行数、恢复点与审计事件——全部来自可信服务层记录"
        actions={
          <Button
            icon={<RefreshCw size={14} />}
            loading={loading}
            onClick={() => {
              setReloadKey((key) => key + 1)
              void loadFilters()
            }}
          >
            刷新
          </Button>
        }
      />
      <div className="page-body">
        {filtersError && (
          <div className="mb-2">
            <Callout kind="warn" title="筛选选项加载失败">
              <div className="pre-wrap">{filtersError}</div>
              <div className="mt-2">
                <Button size="sm" onClick={() => void loadFilters()}>
                  重试
                </Button>
              </div>
            </Callout>
          </div>
        )}

        <div className="filter-bar">
          <Select<string>
            value={projectId}
            onChange={(value) => applyFilter(() => setProjectId(value))}
            options={[
              { value: '', label: '全部项目' },
              ...projects.map((project) => ({ value: project.id, label: project.name }))
            ]}
          />
          <Select<string>
            value={connectionId}
            onChange={(value) => applyFilter(() => setConnectionId(value))}
            options={[
              { value: '', label: '全部连接' },
              ...connections.map((connection) => ({
                value: connection.id,
                label: `${connection.name}（${connection.host}）`
              }))
            ]}
          />
          <Select<string>
            value={status}
            onChange={(value) => applyFilter(() => setStatus(value))}
            options={[
              { value: '', label: '全部状态' },
              { value: 'planned', label: '已计划' },
              { value: 'running', label: '执行中' },
              { value: 'success', label: '成功' },
              { value: 'failed', label: '失败' },
              { value: 'cancelled', label: '已取消' },
              { value: 'denied', label: '已拒绝' }
            ]}
          />
          <Select<string>
            value={risk}
            onChange={(value) => applyFilter(() => setRisk(value))}
            options={[
              { value: '', label: '全部风险' },
              ...riskLevels.map((level) => ({ value: level, label: `风险：${riskLabel[level]}` }))
            ]}
          />
          <Select<string>
            value={String(limit)}
            onChange={(value) => applyFilter(() => setLimit(Number(value)))}
            options={[
              { value: '20', label: '每页 20 条' },
              { value: '50', label: '每页 50 条' },
              { value: '100', label: '每页 100 条' }
            ]}
          />
          {hasFilters && (
            <Button size="sm" variant="ghost" onClick={resetFilters}>
              重置筛选
            </Button>
          )}
          <span className="spacer" />
          <span className="small muted">
            共 {total} 条 · 第 {currentPage} / {totalPages} 页
          </span>
        </div>

        {loadError ? (
          <Callout kind="danger" title="操作历史加载失败">
            <div className="pre-wrap">{apiDetail(loadError)}</div>
            <div className="mt-2">
              <Button size="sm" onClick={() => setReloadKey((key) => key + 1)}>
                重试
              </Button>
            </div>
          </Callout>
        ) : loading && !page ? (
          <LoadingBlock label="正在加载操作历史…" />
        ) : !page || page.items.length === 0 ? (
          hasFilters ? (
            <EmptyState
              icon={<History size={24} />}
              title="没有匹配的操作记录"
              body="尝试调整项目/连接/状态/风险筛选条件，或点击“重置筛选”。"
              action={
                <Button size="sm" onClick={resetFilters}>
                  重置筛选
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<History size={24} />}
              title="还没有操作历史"
              body="在工作区通过“预览 → 授权 → 执行”流程执行 SQL 后，这里会记录每次执行的状态、影响行数、耗时、恢复点与审计事件。"
              action={
                <Button size="sm" onClick={() => navigate('workspace')}>
                  去数据库工作区
                </Button>
              }
            />
          )
        ) : (
          <>
            <div className="table-wrap">
              <table className="table history-table">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>时间</th>
                    <th style={{ width: 84 }}>类型</th>
                    <th style={{ width: 70 }}>风险</th>
                    <th style={{ width: 84 }}>状态</th>
                    <th style={{ width: 82, textAlign: 'right' }}>影响行数</th>
                    <th style={{ width: 82, textAlign: 'right' }}>耗时</th>
                    <th style={{ width: 92 }}>触发者</th>
                    <th>SQL 摘要</th>
                    <th style={{ width: 100 }}>恢复点</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((entry) => (
                    <tr key={entry.id} onClick={() => openDetail(entry)} style={{ cursor: 'pointer' }}>
                      <td className="small mono" title={formatDate(entry.executedAt)}>
                        {formatRelative(entry.executedAt)}
                      </td>
                      <td>{kindLabel[entry.kind] ?? entry.kind}</td>
                      <td>
                        <RiskBadge risk={entry.risk} />
                      </td>
                      <td>
                        <Badge className={statusClass[entry.status]}>{statusLabel[entry.status]}</Badge>
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {entry.affectedRows}
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {formatDuration(entry.durationMs)}
                      </td>
                      <td className="small">{triggerLabel[entry.trigger]}</td>
                      <td className="sql-preview-cell" title={entry.sql}>
                        {entry.sql.replace(/\s+/g, ' ').slice(0, 140)}
                      </td>
                      <td className="mono xs">{entry.recoveryPointId ? entry.recoveryPointId.slice(0, 14) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pager">
              <span className="pager-info">
                {offset + 1}–{Math.min(offset + page.items.length, total)} / {total}
              </span>
              <PageButton
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset <= 0 || loading}
                title="上一页"
              >
                <ChevronLeft size={14} /> 上一页
              </PageButton>
              <PageButton
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total || loading}
                title="下一页"
              >
                下一页 <ChevronRight size={14} />
              </PageButton>
            </div>
          </>
        )}
      </div>

      {/* ------------------------------------------------------ 详情抽屉 */}
      {detailId !== null && (
        <div className="ws-drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeDetail()}>
          <aside className="ws-drawer">
            <div className="ws-drawer-head">
              <Clock4 size={16} />
              <h2 className="ws-drawer-title">操作详情</h2>
              <span className="mono xs muted truncate" title={detailId}>
                {detailId}
              </span>
              <span className="spacer" />
              <IconButton title="关闭" onClick={closeDetail}>
                <X size={16} />
              </IconButton>
            </div>
            <div className="ws-drawer-body">
              {detailLoading && (
                <div className="row muted small">
                  <Loader2 size={14} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />
                  正在读取详情…
                </div>
              )}
              {detailError !== null && (
                <Callout kind="danger" title="读取详情失败">
                  <div className="pre-wrap">{apiDetail(detailError)}</div>
                  <div className="mt-2">
                    <Button size="sm" onClick={() => void loadDetail(detailId)}>
                      重试
                    </Button>
                  </div>
                </Callout>
              )}
              {detail && (
                <>
                  <div className="grid-3">
                    <div className="stat-tile">
                      <div className="stat-label">状态</div>
                      <div className="stat-value">
                        <Badge className={statusClass[detail.status]}>{statusLabel[detail.status]}</Badge>
                      </div>
                    </div>
                    <div className="stat-tile">
                      <div className="stat-label">风险</div>
                      <div className="stat-value">
                        <RiskBadge risk={detail.risk} />
                      </div>
                    </div>
                    <div className="stat-tile">
                      <div className="stat-label">类型</div>
                      <div className="stat-value">{kindLabel[detail.kind] ?? detail.kind}</div>
                    </div>
                    <div className="stat-tile">
                      <div className="stat-label">影响行数</div>
                      <div className="stat-value">{detail.affectedRows}</div>
                    </div>
                    <div className="stat-tile">
                      <div className="stat-label">返回行数</div>
                      <div className="stat-value">{detail.rowCount}</div>
                    </div>
                    <div className="stat-tile">
                      <div className="stat-label">耗时</div>
                      <div className="stat-value">{formatDuration(detail.durationMs)}</div>
                    </div>
                  </div>

                  <div className="mt-2 small muted">
                    执行时间：{formatDate(detail.executedAt)} · 触发者：{triggerLabel[detail.trigger]}
                  </div>
                  <div className="small muted">
                    数据库：<span className="mono">{detail.database}</span> · 连接：{connectionName(detail.connectionId)} ·
                    项目：{projectName(detail.projectId)}
                  </div>

                  <div className="ws-divider" />

                  <div className="ws-section-title">完整 SQL</div>
                  <div className="sql-block">{detail.sql}</div>

                  {detail.error && (
                    <div className="mt-2">
                      <Callout kind="danger" title="错误">
                        <div className="pre-wrap">{detail.error}</div>
                      </Callout>
                    </div>
                  )}

                  <div className="ws-divider" />

                  <div className="ws-section-title">保护与审计</div>
                  <div className="kv">
                    <dt>恢复点 id</dt>
                    <dd className="mono">{detail.recoveryPointId ?? '—'}</dd>
                    <dt>备份 id</dt>
                    <dd className="mono">{detail.backupId ?? '—'}</dd>
                    <dt>审计事件 id</dt>
                    <dd className="mono">{detail.auditEventId ?? '—'}</dd>
                  </div>

                  {!detail.recoveryPointId && !detail.backupId && (
                    <div className="mt-2">
                      <Callout kind="warn" title="未关联恢复点/备份">
                        这条记录没有关联恢复点或备份 id。请勿默认认为该操作可回滚；具体保护状态以时间机器中的记录为准。
                      </Callout>
                    </div>
                  )}

                  <div className="row mt-3">
                    {detail.recoveryPointId && (
                      <Button
                        size="sm"
                        icon={<RotateCcw size={13} />}
                        onClick={() => navigate('timemachine')}
                      >
                        查看时间机器
                      </Button>
                    )}
                    {detail.backupId && (
                      <Button
                        size="sm"
                        icon={<ShieldCheck size={13} />}
                        onClick={() => navigate('timemachine')}
                      >
                        查看备份与恢复验证
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
