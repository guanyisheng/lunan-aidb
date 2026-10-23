import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  BrainCircuit,
  CheckCircle2,
  Database,
  Pencil,
  Plus,
  Search,
  ShieldQuestion,
  Trash2,
  XCircle
} from 'lucide-react'
import type {
  MemoryInput,
  MemoryRecord,
  MemorySearchHit,
  MemorySource,
  MemoryStatus,
  MemoryTrust,
  MemoryType,
  MemoryRef
} from '@shared/types'
import { call } from '../lib/api'
import { useAppStore } from '../lib/store'
import {
  formatDate,
  formatRelative,
  memoryStatusLabel,
  memoryTypeLabel,
  trustBadgeClass,
  trustLabel
} from '../lib/format'
import {
  Button,
  Callout,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  Textarea
} from '../components/ui'
import type { Column } from '../components/ui'
import {
  ErrorLine,
  MetaGrid,
  RefreshButton,
  SectionTitle,
  StatCard,
  Tags,
  useAsync
} from '../components/intel/IntelCommon'

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

const SOURCE_LABEL: Record<MemorySource, string> = {
  user: '用户手动录入',
  agent: 'AI Agent 生成',
  schema_scan: 'Schema 扫描',
  execution: 'SQL 执行',
  import: '导入'
}

const TYPE_OPTIONS = (Object.keys(memoryTypeLabel) as MemoryType[]).map((value) => ({
  value,
  label: memoryTypeLabel[value]
}))
const TRUST_OPTIONS = (Object.keys(trustLabel) as MemoryTrust[]).map((value) => ({
  value,
  label: trustLabel[value]
}))
const STATUS_OPTIONS = (Object.keys(memoryStatusLabel) as MemoryStatus[]).map((value) => ({
  value,
  label: memoryStatusLabel[value]
}))

function refText(ref: MemoryRef): string {
  const parts: string[] = [ref.kind]
  if (ref.database) parts.push(ref.database)
  if (ref.table) parts.push(ref.table)
  if (ref.column) parts.push(ref.column)
  if (ref.id) parts.push(ref.id)
  return parts.join(':')
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

const BRIEF_TEMPLATE_HINT = `可一键「从当前库生成」自动填表名/主键/外键/多跳路径（不调用 AI）；也可把 templates/database-brief.md 交给外部 AI 润色后再粘贴。
Agent 会优先用这份说明理解「订单 / 余额 / 用户」等业务说法。`

export function MemoryPage(): ReactNode {
  const projects = useAppStore((s) => s.projects)
  const currentProjectId = useAppStore((s) => s.currentProjectId)
  const refreshProjects = useAppStore((s) => s.refreshProjects)
  const toastOk = useAppStore((s) => s.toastOk)
  const toastError = useAppStore((s) => s.toastError)

  const [projectId, setProjectId] = useState<string>(currentProjectId ?? projects[0]?.id ?? '')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [trustFilter, setTrustFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [keyword, setKeyword] = useState('')
  const [offset, setOffset] = useState(0)
  const limit = 50

  const selectedProject = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])
  const [briefDraft, setBriefDraft] = useState('')
  const [briefOpen, setBriefOpen] = useState(false)
  const [briefSaving, setBriefSaving] = useState(false)
  const [briefGenerating, setBriefGenerating] = useState(false)
  const activeConnectionId = useAppStore((s) => s.activeConnectionId)
  const activeDatabase = useAppStore((s) => s.activeDatabase)

  useEffect(() => {
    setBriefDraft(selectedProject?.databaseBriefMd ?? '')
  }, [selectedProject?.id, selectedProject?.databaseBriefMd])

  const saveBrief = useCallback(async () => {
    if (!projectId) return
    setBriefSaving(true)
    try {
      await call('project.update', {
        id: projectId,
        patch: { databaseBriefMd: briefDraft.trim() ? briefDraft : null }
      })
      await refreshProjects()
      toastOk('数据库说明已保存', 'Agent 下次任务会加载这份说明')
    } catch (e) {
      toastError(e)
    } finally {
      setBriefSaving(false)
    }
  }, [briefDraft, projectId, refreshProjects, toastError, toastOk])

  const generateBriefFromDb = useCallback(async () => {
    if (!projectId) return
    setBriefGenerating(true)
    try {
      const result = await call('project.generateBrief', {
        id: projectId,
        connectionId: activeConnectionId ?? undefined,
        database: activeDatabase || undefined,
        save: false
      })
      setBriefDraft(result.markdown)
      setBriefOpen(true)
      toastOk(
        '已根据库结构生成说明',
        `${result.tableCount} 张表 · 来源 ${result.source === 'snapshot' ? '结构快照' : '实时库'}（未调用 AI，请核对后保存）`
      )
    } catch (e) {
      toastError(e)
    } finally {
      setBriefGenerating(false)
    }
  }, [activeConnectionId, activeDatabase, projectId, toastError, toastOk])

  const importBriefFile = useCallback(async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,text/markdown,text/plain'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const text = typeof reader.result === 'string' ? reader.result : ''
        setBriefDraft(text.slice(0, 200_000))
        setBriefOpen(true)
        toastOk('已导入文件', file.name)
      }
      reader.readAsText(file)
    }
    input.click()
  }, [toastOk])

  const [searchHits, setSearchHits] = useState<MemorySearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<unknown>(null)

  useEffect(() => {
    if (!projectId && currentProjectId) setProjectId(currentProjectId)
  }, [currentProjectId, projectId])
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0].id)
  }, [projectId, projects])

  /* ------------------------------------------------------------ load */
  const statsState = useAsync(
    async () => (projectId ? call('memory.stats', { projectId }) : null),
    [projectId]
  )

  const listState = useAsync(
    async () =>
      projectId
        ? call('memory.list', {
            projectId,
            ...(typeFilter ? { types: [typeFilter as MemoryType] } : {}),
            ...(trustFilter ? { trust: [trustFilter as MemoryTrust] } : {}),
            ...(statusFilter ? { status: statusFilter as MemoryStatus } : {}),
            limit,
            offset
          })
        : null,
    [projectId, typeFilter, trustFilter, statusFilter, offset]
  )

  const reloadAll = useCallback(() => {
    statsState.reload()
    listState.reload()
  }, [listState, statsState])

  useEffect(() => {
    setOffset(0)
    setSearchHits(null)
  }, [projectId, typeFilter, trustFilter, statusFilter])

  /* ---------------------------------------------------------- search */
  const runSearch = useCallback(async () => {
    const query = keyword.trim()
    if (!projectId || !query) {
      setSearchHits(null)
      return
    }
    setSearching(true)
    setSearchError(null)
    try {
      const hits = await call('memory.search', {
        projectId,
        query,
        ...(typeFilter ? { types: [typeFilter as MemoryType] } : {}),
        limit: 50,
        includeStale: true
      })
      setSearchHits(hits)
    } catch (e) {
      setSearchError(e)
      setSearchHits(null)
    } finally {
      setSearching(false)
    }
  }, [keyword, projectId, typeFilter])

  const clearSearch = useCallback(() => {
    setKeyword('')
    setSearchHits(null)
    setSearchError(null)
  }, [])

  /* -------------------------------------------------------- selection */
  const [selected, setSelected] = useState<MemoryRecord | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [editType, setEditType] = useState<MemoryType>('business')
  const [editTags, setEditTags] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [invalidateOpen, setInvalidateOpen] = useState(false)
  const [invalidateReason, setInvalidateReason] = useState('')
  const [invalidateBusy, setInvalidateBusy] = useState(false)

  const [createOpen, setCreateOpen] = useState(false)
  const [createType, setCreateType] = useState<MemoryType>('business')
  const [createTrust, setCreateTrust] = useState<MemoryTrust>('user_confirmed')
  const [createTitle, setCreateTitle] = useState('')
  const [createContent, setCreateContent] = useState('')
  const [createTags, setCreateTags] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<unknown>(null)

  useEffect(() => {
    if (!selected) return
    setEditTitle(selected.title)
    setEditContent(selected.content)
    setEditType(selected.type)
    setEditTags(selected.tags.join(', '))
  }, [selected])

  const selectRecord = useCallback((record: MemoryRecord) => {
    setSelected(record)
    setActionError(null)
  }, [])

  const applyUpdated = useCallback(
    (record: MemoryRecord) => {
      setSelected(record)
      listState.reload()
      statsState.reload()
    },
    [listState, statsState]
  )

  /* ---------------------------------------------------------- actions */
  const saveEdit = useCallback(async () => {
    if (!selected) return
    const title = editTitle.trim()
    const content = editContent.trim()
    if (!title || !content) {
      setActionError(new Error('标题与内容不能为空'))
      return
    }
    setSaving(true)
    setActionError(null)
    try {
      const tags = editTags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 30)
      const updated = await call('memory.update', {
        id: selected.id,
        patch: { title, content, type: editType, tags }
      })
      applyUpdated(updated)
      toastOk('记忆已保存', updated.title)
    } catch (e) {
      setActionError(e)
      toastError(e)
    } finally {
      setSaving(false)
    }
  }, [applyUpdated, editContent, editTags, editTitle, editType, selected, toastError, toastOk])

  const confirmRecord = useCallback(async () => {
    if (!selected) return
    const content = editContent.trim()
    setConfirmBusy(true)
    setActionError(null)
    try {
      const updated = await call('memory.confirm', {
        id: selected.id,
        ...(content && content !== selected.content ? { content } : {})
      })
      applyUpdated(updated)
      toastOk('已标记为用户确认', '该记忆现在以用户确认的可信度展示')
    } catch (e) {
      setActionError(e)
      toastError(e)
    } finally {
      setConfirmBusy(false)
    }
  }, [applyUpdated, editContent, selected, toastError, toastOk])

  const markActive = useCallback(async () => {
    if (!selected) return
    setSaving(true)
    setActionError(null)
    try {
      const updated = await call('memory.update', { id: selected.id, patch: { status: 'active' } })
      applyUpdated(updated)
      toastOk('已恢复为有效状态')
    } catch (e) {
      setActionError(e)
      toastError(e)
    } finally {
      setSaving(false)
    }
  }, [applyUpdated, selected, toastError, toastOk])

  const doDelete = useCallback(async () => {
    if (!selected) return
    setDeleteBusy(true)
    try {
      await call('memory.delete', { id: selected.id })
      toastOk('记忆已删除', selected.title)
      setSelected(null)
      setDeleteOpen(false)
      reloadAll()
    } catch (e) {
      toastError(e)
    } finally {
      setDeleteBusy(false)
    }
  }, [reloadAll, selected, toastError, toastOk])

  const doInvalidate = useCallback(async () => {
    if (!selected) return
    const reason = invalidateReason.trim()
    if (!reason) return
    setInvalidateBusy(true)
    try {
      const updated = await call('memory.invalidate', { id: selected.id, reason })
      applyUpdated(updated)
      setInvalidateOpen(false)
      setInvalidateReason('')
      toastOk('已标记为失效', reason)
    } catch (e) {
      toastError(e)
    } finally {
      setInvalidateBusy(false)
    }
  }, [applyUpdated, invalidateReason, selected, toastError, toastOk])

  const createMemory = useCallback(async () => {
    const title = createTitle.trim()
    const content = createContent.trim()
    if (!projectId) {
      setCreateError(new Error('请先选择项目'))
      return
    }
    if (!title || !content) {
      setCreateError(new Error('标题与内容不能为空'))
      return
    }
    setCreateBusy(true)
    setCreateError(null)
    try {
      const tags = createTags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 30)
      const input: MemoryInput = {
        projectId,
        type: createType,
        title,
        content,
        trust: createTrust,
        source: 'user',
        tags
      }
      const record = await call('memory.create', input)
      setCreateOpen(false)
      setCreateTitle('')
      setCreateContent('')
      setCreateTags('')
      setSelected(record)
      reloadAll()
      toastOk('记忆已创建', record.title)
    } catch (e) {
      setCreateError(e)
    } finally {
      setCreateBusy(false)
    }
  }, [createContent, createTags, createTitle, createTrust, createType, projectId, reloadAll, toastOk])

  /* ----------------------------------------------------------- render */
  const stats = statsState.data
  const rows = useMemo<MemorySearchHit[] | MemoryRecord[]>(
    () => (searchHits !== null ? searchHits : listState.data?.items ?? []),
    [listState.data, searchHits]
  )
  const isSearchMode = searchHits !== null

  const columns = useMemo<Column<MemoryRecord | MemorySearchHit>[]>(() => {
    const base: Column<MemoryRecord | MemorySearchHit>[] = [
      {
        key: 'title',
        title: '标题 / 内容摘要',
        render: (row) => {
          const memory = 'memory' in row ? row.memory : row
          return (
            <div style={{ minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="strong truncate" style={{ maxWidth: 320 }}>
                  {memory.title}
                </span>
                {memory.status !== 'active' && (
                  <span className={memory.status === 'invalid' ? 'badge danger' : 'badge warn'}>
                    {memoryStatusLabel[memory.status]}
                  </span>
                )}
              </div>
              <div className="muted xs truncate" style={{ maxWidth: 420 }}>
                {memory.content}
              </div>
            </div>
          )
        }
      },
      {
        key: 'type',
        title: '类型',
        width: '110px',
        render: (row) => <span className="badge neutral">{memoryTypeLabel[('memory' in row ? row.memory : row).type]}</span>
      },
      {
        key: 'trust',
        title: '可信度',
        width: '100px',
        render: (row) => {
          const memory = 'memory' in row ? row.memory : row
          return <span className={trustBadgeClass[memory.trust]}>{trustLabel[memory.trust]}</span>
        }
      },
      {
        key: 'useCount',
        title: '使用次数',
        width: '72px',
        align: 'right',
        render: (row) => <span className="intel-num">{('memory' in row ? row.memory : row).useCount}</span>
      },
      {
        key: 'updatedAt',
        title: '更新时间',
        width: '120px',
        render: (row) => <span className="small muted">{formatRelative(('memory' in row ? row.memory : row).updatedAt)}</span>
      }
    ]
    if (isSearchMode) {
      base.push({
        key: 'score',
        title: '匹配得分 / 原因',
        width: '150px',
        render: (row) =>
          'score' in row ? (
            <div>
              <div className="intel-num strong">{row.score.toFixed(3)}</div>
              <div className="muted xs">{row.reason}</div>
            </div>
          ) : null
      })
    }
    return base
  }, [isSearchMode])

  const rowKey = (row: MemoryRecord | MemorySearchHit): string => ('memory' in row ? row.memory.id : row.id)

  const renderDetail = (): ReactNode => {
    if (!selected) {
      return (
        <Card>
          <EmptyState
            icon={<BrainCircuit size={24} />}
            title="选择一条记忆查看详情"
            body="左侧列表可以按类型、可信度和状态筛选，也可以输入关键词搜索（显示匹配得分与原因）。"
          />
        </Card>
      )
    }
    const aiInferred = selected.trust === 'ai_inferred' || selected.trust === 'unverified'
    return (
      <Card className="col intel-detail-card">
        <div className="row wrap">
          <span className={trustBadgeClass[selected.trust]}>{trustLabel[selected.trust]}</span>
          <span className="badge neutral">{memoryTypeLabel[selected.type]}</span>
          <span className={selected.status === 'active' ? 'badge ok' : selected.status === 'stale' ? 'badge warn' : 'badge danger'}>
            {memoryStatusLabel[selected.status]}
          </span>
          <div className="spacer" />
          <RefreshButton
            onClick={() => {
              void call('memory.get', { id: selected.id })
                .then((record) => {
                  if (record) setSelected(record)
                })
                .catch((e: unknown) => toastError(e))
            }}
          />
        </div>

        {aiInferred && (
          <Callout kind="warn" title="这是 AI 推断或未验证内容">
            未确认的推断不得作为确定的业务规则使用。请人工核对内容后点击「用户确认」，或标记为失效。
          </Callout>
        )}
        {selected.status === 'invalid' && (
          <Callout kind="danger" title="该记忆已失效">
            {selected.invalidatedReason ?? '没有记录失效原因。'}
          </Callout>
        )}
        {selected.status === 'stale' && (
          <Callout kind="warn" title="Schema 变化后需要复核">
            该记忆关联的数据库结构已发生变化，请重新核对内容后再确认。
          </Callout>
        )}

        <Field label="标题">
          <Input value={editTitle} onChange={setEditTitle} maxLength={300} />
        </Field>
        <Field label="内容">
          <Textarea value={editContent} onChange={setEditContent} rows={7} />
        </Field>
        <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <Field label="类型" className="grow">
            <Select value={editType} onChange={(value) => setEditType(value)} options={TYPE_OPTIONS} />
          </Field>
          <Field label="标签（逗号分隔）" className="grow">
            <Input value={editTags} onChange={setEditTags} placeholder="订单, 状态码" />
          </Field>
        </div>

        <div className="row wrap">
          <Button variant="primary" size="sm" loading={saving} onClick={() => void saveEdit()}>
            <Pencil size={12} /> 保存修改
          </Button>
          <Button size="sm" loading={confirmBusy} onClick={() => void confirmRecord()}>
            <CheckCircle2 size={12} /> 用户确认
          </Button>
          {selected.status !== 'active' && (
            <Button size="sm" onClick={() => void markActive()}>
              标记为有效
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={() => setInvalidateOpen(true)}>
            <XCircle size={12} /> 标记失效
          </Button>
          <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={12} /> 删除
          </Button>
        </div>

        {actionError !== null && <ErrorLine error={actionError} />}

        <div className="divider" />

        <SectionTitle icon={<ShieldQuestion size={13} />}>来源与可信信息</SectionTitle>
        <MetaGrid
          items={[
            { k: '来源', v: SOURCE_LABEL[selected.source] ?? selected.source },
            {
              k: '可信状态',
              v: (
                <span className={trustBadgeClass[selected.trust]}>
                  {trustLabel[selected.trust]}
                  {selected.verifiedBy
                    ? `（${selected.verifiedBy === 'user' ? '用户' : selected.verifiedBy === 'execution' ? '执行验证' : 'Agent'}）`
                    : ''}
                </span>
              )
            },
            { k: '置信度', v: `${Math.round(selected.confidence * 100)}%` },
            { k: '使用次数', v: String(selected.useCount) },
            { k: '创建时间', v: formatDate(selected.createdAt) },
            { k: '更新时间', v: formatDate(selected.updatedAt) },
            { k: '最近使用', v: formatDate(selected.lastUsedAt) },
            { k: '确认时间', v: formatDate(selected.verifiedAt) },
            { k: 'Schema 版本', v: selected.schemaSnapshotId ? <span className="mono">{selected.schemaSnapshotId}</span> : '—' },
            { k: 'Schema Hash', v: selected.schemaHash ? <span className="mono xs">{selected.schemaHash}</span> : '—' },
            { k: '被替代记录', v: selected.supersedesId ? <span className="mono">{selected.supersedesId}</span> : '—' }
          ]}
        />
        <div>
          <div className="intel-step-label mb-1">关联对象（refs）</div>
          {selected.refs.length === 0 ? (
            <div className="small muted">无关联引用。</div>
          ) : (
            <div>
              {selected.refs.map((ref, index) => (
                <span className="intel-tag mono" key={index}>
                  {refText(ref)}
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="intel-step-label mb-1">标签</div>
          <Tags items={selected.tags} />
        </div>
        <div className="muted xs mono intel-select-all">ID: {selected.id}</div>
      </Card>
    )
  }

  return (
    <div className="page">
      <PageHeader
        title="记忆中心"
        sub="项目记忆与「数据库说明」；说明用于让 Agent 听懂业务说法。Schema 变化会使相关记忆待复核或失效"
        actions={
          <>
            <RefreshButton onClick={reloadAll} loading={listState.loading || statsState.loading} />
            <Button variant="primary" onClick={() => setCreateOpen(true)} icon={<Plus size={13} />} disabled={!projectId}>
              新建记忆
            </Button>
          </>
        }
      />
      <div className="page-body">
        <div className="row wrap mb-2" style={{ gap: 8 }}>
          <Field label="项目" className="intel-project-select">
            <Select
              value={projectId}
              onChange={(value) => {
                setProjectId(value)
                setSelected(null)
              }}
              options={[
                { value: '', label: '选择项目…' },
                ...projects.map((project) => ({ value: project.id, label: project.name }))
              ]}
            />
          </Field>
          {projects.length === 0 && (
            <span className="small muted">还没有项目。请先在首页创建项目，记忆按项目独立管理。</span>
          )}
        </div>

        {projectId && (
          <div className="intel-row-card mb-2">
            <div className="row between wrap" style={{ gap: 8 }}>
              <div>
                <div className="strong small">数据库说明（项目绑定 MD）</div>
                <div className="muted xs mt-1" style={{ maxWidth: 640 }}>
                  {BRIEF_TEMPLATE_HINT}
                </div>
                <div className="muted xs mt-1">
                  当前：
                  {selectedProject?.databaseBriefMd?.trim()
                    ? `已配置 ${selectedProject.databaseBriefMd.length} 字符`
                    : '尚未配置（Agent 只能靠 Schema，难懂「订单/余额」口语）'}
                </div>
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                <Button
                  size="sm"
                  variant="primary"
                  loading={briefGenerating}
                  onClick={() => void generateBriefFromDb()}
                  title="读取当前项目关联库的表结构，自动填写 MD（不调用 AI）"
                >
                  从当前库生成
                </Button>
                <Button size="sm" onClick={() => setBriefOpen((v) => !v)}>
                  {briefOpen ? '收起编辑' : '编辑说明'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void importBriefFile()}>
                  导入 .md
                </Button>
              </div>
            </div>
            {briefOpen && (
              <div className="mt-2">
                <Textarea
                  value={briefDraft}
                  onChange={setBriefDraft}
                  rows={14}
                  placeholder="粘贴填好的 database-brief.md 内容…"
                />
                <div className="row wrap mt-2" style={{ gap: 8 }}>
                  <Button variant="primary" size="sm" loading={briefSaving} onClick={() => void saveBrief()}>
                    保存到项目
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setBriefDraft(selectedProject?.databaseBriefMd ?? '')}
                    disabled={briefSaving}
                  >
                    还原
                  </Button>
                  <span className="muted xs">{briefDraft.length.toLocaleString()} 字符（上限 200000）</span>
                </div>
              </div>
            )}
          </div>
        )}

        {statsState.error !== null && <ErrorLine error={statsState.error} title="记忆统计加载失败" />}

        {stats ? (
          <>
            <div className="intel-grid-stat mb-2">
              <StatCard
                label="记忆总数"
                value={stats.total}
                tone="accent"
                hint={stats.lastUpdatedAt ? `最近更新 ${formatRelative(stats.lastUpdatedAt)}` : undefined}
              />
              <StatCard label="待复核" value={stats.stale} tone={stats.stale > 0 ? 'warn' : 'none'} hint="Schema 变化后需要确认" />
              <StatCard label="已失效" value={stats.invalid} tone={stats.invalid > 0 ? 'danger' : 'none'} hint="不再作为规则使用" />
              <StatCard
                label="用户确认 / 已验证"
                value={(stats.byTrust.user_confirmed ?? 0) + (stats.byTrust.verified ?? 0)}
                tone="ok"
                hint="可信度最高的记忆"
              />
              <StatCard label="AI 推断" value={stats.byTrust.ai_inferred ?? 0} hint="需人工核对，不得直接作为规则" />
              <StatCard label="未验证" value={stats.byTrust.unverified ?? 0} hint="来源待确认" />
            </div>
            <div className="intel-row-card mb-2">
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="small muted">按类型：</span>
                {TYPE_OPTIONS.map((option) => (
                  <span className="badge neutral" key={option.value}>
                    {option.label} {stats.byType[option.value as MemoryType] ?? 0}
                  </span>
                ))}
              </div>
            </div>
          </>
        ) : statsState.loading ? (
          <LoadingBlock label="加载记忆统计…" />
        ) : null}

        <div className="intel-toolbar">
          <Field label="类型">
            <Select value={typeFilter} onChange={setTypeFilter} options={[{ value: '', label: '全部类型' }, ...TYPE_OPTIONS]} />
          </Field>
          <Field label="可信状态">
            <Select value={trustFilter} onChange={setTrustFilter} options={[{ value: '', label: '全部可信度' }, ...TRUST_OPTIONS]} />
          </Field>
          <Field label="状态">
            <Select value={statusFilter} onChange={setStatusFilter} options={[{ value: '', label: '全部状态' }, ...STATUS_OPTIONS]} />
          </Field>
          <Field label="关键词搜索" hint="搜索模式显示匹配得分与命中原因">
            <Input
              value={keyword}
              onChange={setKeyword}
              placeholder="例如：订单状态码 金额 关联规则"
              onEnter={() => void runSearch()}
            />
          </Field>
          <Button loading={searching} onClick={() => void runSearch()} disabled={!keyword.trim() || searching}>
            <Search size={13} /> 搜索
          </Button>
          {isSearchMode && (
            <Button variant="ghost" onClick={clearSearch}>
              清除搜索
            </Button>
          )}
        </div>

        {searchError !== null && <ErrorLine error={searchError} title="记忆搜索失败" />}

        {!projectId ? (
          <EmptyState title="请选择项目" body="记忆按项目独立管理，选择项目后会显示该项目的记忆、统计与搜索。" icon={<Database size={24} />} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 420px', gap: 12, alignItems: 'start' }}>
            <Card className="intel-list-card">
              <div className="row wrap" style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
                <span className="strong small">
                  {isSearchMode ? `搜索结果（${rows.length}）` : `记忆列表（${listState.data?.total ?? 0}）`}
                </span>
                {isSearchMode && <span className="muted xs">搜索模式：按相关度排序</span>}
                <div className="spacer" />
                {listState.loading && <span className="spinner" />}
              </div>
              {listState.error !== null ? (
                <div style={{ padding: 10 }}>
                  <ErrorLine error={listState.error} title="记忆列表加载失败" />
                </div>
              ) : listState.loading && rows.length === 0 ? (
                <LoadingBlock label="加载记忆列表…" />
              ) : (
                <>
                  <DataTable
                    columns={columns}
                    rows={rows}
                    rowKey={rowKey}
                    empty={
                      <div className="intel-empty-hint">
                        {isSearchMode ? '没有匹配的记忆。' : '暂无记忆。可以点击右上角「新建记忆」，或让 Agent 在任务中积累记忆。'}
                      </div>
                    }
                    onRowClick={(row) => selectRecord('memory' in row ? row.memory : row)}
                  />
                  {!isSearchMode && (listState.data?.total ?? 0) > limit && (
                    <div style={{ padding: '0 10px' }}>
                      <div className="intel-pagination">
                        <span>
                          第 {offset + 1}–{Math.min(offset + limit, listState.data?.total ?? 0)} 条，共 {listState.data?.total ?? 0} 条
                        </span>
                        <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
                          上一页
                        </button>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={offset + limit >= (listState.data?.total ?? 0)}
                          onClick={() => setOffset(offset + limit)}
                        >
                          下一页
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </Card>
            {renderDetail()}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ create */}
      <Modal
        open={createOpen}
        title="新建记忆"
        closeOnEscape={false}
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={createBusy}>
              取消
            </Button>
            <Button variant="primary" loading={createBusy} onClick={() => void createMemory()}>
              创建
            </Button>
          </>
        }
      >
        <Callout kind="info" title="手动创建的记忆以「用户确认」为默认可信度">
          如果保存的是 AI 推断或尚未验证的结论，请把可信度改为「AI 推断 / 未验证」；未确认的推断不会作为确定规则展示给 Agent。
        </Callout>
        <div className="mt-2">
          <Field label="类型">
            <Select value={createType} onChange={(value) => setCreateType(value)} options={TYPE_OPTIONS} />
          </Field>
          <Field label="可信度">
            <Select value={createTrust} onChange={(value) => setCreateTrust(value)} options={TRUST_OPTIONS} />
          </Field>
          <Field label="标题">
            <Input value={createTitle} onChange={setCreateTitle} placeholder="例如：订单状态码定义" maxLength={300} />
          </Field>
          <Field label="内容">
            <Textarea
              value={createContent}
              onChange={setCreateContent}
              rows={6}
              placeholder="记录业务规则、字段含义、关联关系或已验证的 SQL 用法。"
            />
          </Field>
          <Field label="标签（逗号分隔）">
            <Input value={createTags} onChange={setCreateTags} placeholder="订单, 状态码" />
          </Field>
          {createError !== null && <ErrorLine error={createError} />}
        </div>
      </Modal>

      {/* ---------------------------------------------------- invalidate */}
      <Modal
        open={invalidateOpen}
        title="标记记忆失效"
        onClose={() => setInvalidateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setInvalidateOpen(false)} disabled={invalidateBusy}>
              取消
            </Button>
            <Button variant="danger" loading={invalidateBusy} disabled={!invalidateReason.trim()} onClick={() => void doInvalidate()}>
              确认失效
            </Button>
          </>
        }
      >
        <Callout kind="warn" title="失效的记忆不会再被 Agent 当作有效规则使用">
          请填写失效原因（例如：Schema 已变更、业务规则被用户更正）。失效记录会被保留以便审计。
        </Callout>
        <div className="mt-2">
          <Field label="失效原因">
            <Textarea value={invalidateReason} onChange={setInvalidateReason} rows={4} placeholder="例如：order_status 字段已迁移到 order_state" />
          </Field>
        </div>
      </Modal>

      {/* -------------------------------------------------------- delete */}
      <ConfirmDialog
        open={deleteOpen}
        title="删除记忆"
        danger
        confirmLabel="确认删除"
        busy={deleteBusy}
        onConfirm={() => void doDelete()}
        onCancel={() => setDeleteOpen(false)}
      >
        <div>
          确定删除记忆「<span className="strong">{selected?.title}</span>」吗？删除后不可恢复；如需保留审计痕迹，建议改用「标记失效」。
        </div>
      </ConfirmDialog>
    </div>
  )
}
