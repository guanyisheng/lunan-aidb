import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock4,
  Database,
  FileSearch,
  FolderOpen,
  GitCompare,
  History,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Upload
} from 'lucide-react'
import type {
  ApprovalRequest,
  BackupCreateRequest,
  BackupRecord,
  BackupScope,
  BackupType,
  JobEvent,
  RecoveryPoint,
  RestoreJob,
  RestorePreview,
  SchemaDiff,
  SchemaSnapshot,
  UndoPreview
} from '@shared/types'
import { call, onEvent } from '../lib/api'
import { useAppStore } from '../lib/store'
import {
  formatBytes,
  formatDate,
  formatRelative,
  recoveryKindLabel,
  recoveryStatusLabel,
  riskLabel
} from '../lib/format'
import {
  Button,
  Callout,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  LoadingBlock,
  Modal,
  PageHeader,
  ProgressBar,
  RiskBadge,
  Select,
  Textarea
} from '../components/ui'
import {
  BackupMetaView,
  BackupStatusBadge,
  BackupVerificationView,
  BackupFileView,
  ConflictCount,
  RestoreJobList,
  RestoreJobPanel,
  RestoreJobStatusBadge,
  RestorePreviewView,
  UndoPreviewView,
  restoreModeLabel
} from '../components/intel/RecoveryViews'
import {
  CoverageBadges,
  CoverageLegend,
  ErrorLine,
  IdText,
  InlineSpinner,
  RefreshButton,
  SectionTitle,
  StatCard,
  formatNumber,
  useAsync
} from '../components/intel/IntelCommon'

/* ------------------------------------------------------------------ */

type Tab = 'recovery' | 'backups' | 'jobs' | 'diff'

const TABS: { key: Tab; label: string; icon: ReactNode }[] = [
  { key: 'recovery', label: '恢复点', icon: <RotateCcw size={13} /> },
  { key: 'backups', label: '备份', icon: <Archive size={13} /> },
  { key: 'jobs', label: '恢复任务', icon: <History size={13} /> },
  { key: 'diff', label: '结构差异', icon: <GitCompare size={13} /> }
]

interface RestoreTarget {
  backup: BackupRecord
  mode: 'to_temp_database' | 'in_place'
}

function capturedRows(point: RecoveryPoint): number {
  return point.captured.reduce((total, set) => total + set.rowCount, 0)
}

function openPath(path: string): void {
  void call('app.showItemInFolder', { path }).catch((e: unknown) => {
    useAppStore.getState().toastError(e)
  })
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export function TimeMachinePage(): ReactNode {
  const projects = useAppStore((s) => s.projects)
  const currentProjectId = useAppStore((s) => s.currentProjectId)
  const pushToast = useAppStore((s) => s.pushToast)
  const toastOk = useAppStore((s) => s.toastOk)
  const toastError = useAppStore((s) => s.toastError)

  const [tab, setTab] = useState<Tab>('recovery')
  const [projectId, setProjectId] = useState<string>(currentProjectId ?? '')
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (!projectId && currentProjectId) setProjectId(currentProjectId)
  }, [currentProjectId, projectId])

  const refresh = useCallback(() => setRefreshTick((value) => value + 1), [])

  /* ------------------------------------------------------------ loads */
  const recoveryState = useAsync(
    async () => call('recovery.list', { projectId: projectId || undefined, limit: 100 }),
    [projectId, refreshTick]
  )
  const backupsState = useAsync(
    async () => call('backup.list', { projectId: projectId || undefined, limit: 100 }),
    [projectId, refreshTick]
  )
  const backupStatsState = useAsync(
    async () => call('backup.stats', projectId ? { projectId } : {}),
    [projectId, refreshTick]
  )
  const jobsState = useAsync(
    async () => call('recovery.job.list', { projectId: projectId || undefined, limit: 100 }),
    [projectId, refreshTick]
  )
  const snapshotsState = useAsync(
    async () =>
      projectId ? call('schema.snapshots', { projectId, limit: 50 }) : Promise.resolve([] as SchemaSnapshot[]),
    [projectId, refreshTick]
  )

  /* -------------------------------------------------------- job events */
  const [jobEvent, setJobEvent] = useState<JobEvent | null>(null)
  useEffect(() => {
    const off = onEvent('job.event', (event) => {
      setJobEvent(event)
    })
    return () => off()
  }, [])

  /* ------------------------------------------------------ recovery tab */
  const [detailPoint, setDetailPoint] = useState<RecoveryPoint | null>(null)
  const [undoPoint, setUndoPoint] = useState<RecoveryPoint | null>(null)
  const [undoPreview, setUndoPreview] = useState<UndoPreview | null>(null)
  const [undoLoading, setUndoLoading] = useState(false)
  const [undoError, setUndoError] = useState<unknown>(null)
  const [undoApproval, setUndoApproval] = useState<ApprovalRequest | null>(null)
  const [undoApprovalError, setUndoApprovalError] = useState<unknown>(null)
  const [undoToken, setUndoToken] = useState<string | null>(null)
  const [undoApproving, setUndoApproving] = useState(false)
  const [undoConfirmed, setUndoConfirmed] = useState(false)
  const [undoExecuting, setUndoExecuting] = useState(false)
  const [undoJob, setUndoJob] = useState<RestoreJob | null>(null)

  const findUndoApproval = useCallback(
    async (point: RecoveryPoint) => {
      setUndoApprovalError(null)
      try {
        const pending = await call('approval.pending', { projectId: projectId || undefined })
        const byPlan = pending.find((item) => item.planId === point.planId)
        const byTarget =
          point.targetTables.length > 0
            ? pending.find((item) => item.targets.some((target) => point.targetTables.includes(target)))
            : undefined
        setUndoApproval(byPlan ?? byTarget ?? null)
      } catch (e) {
        setUndoApprovalError(e)
      }
    },
    [projectId]
  )

  const openUndo = useCallback(
    async (point: RecoveryPoint) => {
      setUndoPoint(point)
      setUndoPreview(null)
      setUndoError(null)
      setUndoApproval(null)
      setUndoApprovalError(null)
      setUndoToken(null)
      setUndoConfirmed(false)
      setUndoJob(null)
      setJobEvent(null)
      setUndoLoading(true)
      try {
        const preview = await call('recovery.previewUndo', { recoveryPointId: point.id })
        setUndoPreview(preview)
        if (preview.requiresApproval) void findUndoApproval(point)
      } catch (e) {
        setUndoError(e)
      } finally {
        setUndoLoading(false)
      }
    },
    [findUndoApproval]
  )

  const approveUndo = useCallback(async () => {
    if (!undoApproval) return
    setUndoApproving(true)
    setUndoError(null)
    try {
      const approved = await call('approval.approve', { planId: undoApproval.planId, comment: '时间机器撤销操作审批' })
      setUndoApproval(approved)
      setUndoToken(approved.id)
      toastOk('撤销审批已通过', `审批记录 ${approved.id}`)
    } catch (e) {
      setUndoError(e)
      setUndoApproving(false)
    } finally {
      setUndoApproving(false)
    }
  }, [toastOk, undoApproval])

  const executeUndo = useCallback(async () => {
    if (!undoPoint) return
    setUndoExecuting(true)
    setUndoError(null)
    setJobEvent(null)
    try {
      const job = await call('recovery.undo', {
        recoveryPointId: undoPoint.id,
        ...(undoToken ? { approvalToken: undoToken } : {}),
        confirmed: true
      })
      setUndoJob(job)
      refresh()
      if (job.status === 'completed') {
        toastOk('撤销完成', `恢复任务 ${job.id}`)
      } else {
        pushToast({
          kind: 'error',
          title: '撤销未成功完成',
          body: job.error ?? `状态：${job.status}${job.mayBePartial ? '，数据库可能处于部分恢复状态' : ''}`
        })
      }
    } catch (e) {
      setUndoError(e)
      toastError(e)
    } finally {
      setUndoExecuting(false)
    }
  }, [pushToast, refresh, toastError, toastOk, undoPoint, undoToken])

  /* ------------------------------------------------------- backup tab */
  const [createOpen, setCreateOpen] = useState(false)
  const [formConnectionId, setFormConnectionId] = useState('')
  const [formDatabase, setFormDatabase] = useState('')
  const [formScope, setFormScope] = useState<BackupScope>('database')
  const [formTables, setFormTables] = useState('')
  const [formType, setFormType] = useState<BackupType>('full')
  const [formVerify, setFormVerify] = useState(true)
  const [formRestoreTest, setFormRestoreTest] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<unknown>(null)
  const [createResult, setCreateResult] = useState<BackupRecord | null>(null)

  const connections = useAppStore((s) => s.connections)
  const activeDatabase = useAppStore((s) => s.activeDatabase)

  const openCreate = useCallback(() => {
    setCreateOpen(true)
    setCreateError(null)
    setCreateResult(null)
    setJobEvent(null)
    setFormConnectionId((value) => value || connections[0]?.id || '')
    setFormDatabase((value) => value || activeDatabase || connections[0]?.database || '')
    setFormScope((value) => value)
    setFormTables((value) => value)
    setFormType((value) => value)
    setFormVerify((value) => value)
    setFormRestoreTest((value) => value)
  }, [activeDatabase, connections])

  const submitCreate = useCallback(async () => {
    setCreateError(null)
    setCreateResult(null)
    const database = formDatabase.trim()
    const tables = formTables
      .split(/[,，\n]/)
      .map((table) => table.trim())
      .filter(Boolean)
    if (!formConnectionId) {
      setCreateError(new Error('请选择数据库连接'))
      return
    }
    if (!database) {
      setCreateError(new Error('请填写要备份的数据库名'))
      return
    }
    if (formScope === 'tables' && tables.length === 0) {
      setCreateError(new Error('备份范围为指定表时，请至少填写一个表名'))
      return
    }
    const request: BackupCreateRequest = {
      connectionId: formConnectionId,
      projectId: projectId || null,
      database,
      scope: formScope,
      ...(formScope === 'tables' ? { tables } : {}),
      type: formType,
      verify: formVerify,
      restoreTest: formRestoreTest
    }
    setCreateBusy(true)
    setJobEvent(null)
    try {
      const record = await call('backup.create', request)
      setCreateResult(record)
      refresh()
      if (record.status === 'failed') {
        pushToast({ kind: 'error', title: '备份失败', body: record.error ?? '主进程返回备份失败状态' })
      } else {
        toastOk('备份已创建', `${record.fileName}（${record.status === 'restore_tested' ? '已通过恢复验证' : record.status === 'verified' ? '已校验' : '未校验'}）`)
      }
    } catch (e) {
      setCreateError(e)
    } finally {
      setCreateBusy(false)
    }
  }, [
    formConnectionId,
    formDatabase,
    formRestoreTest,
    formScope,
    formTables,
    formType,
    formVerify,
    projectId,
    pushToast,
    refresh,
    toastOk
  ])

  const [backupDetail, setBackupDetail] = useState<BackupRecord | null>(null)
  const [verifyBusyId, setVerifyBusyId] = useState<string | null>(null)
  const [verifyError, setVerifyError] = useState<unknown>(null)
  const [deleteBackup, setDeleteBackup] = useState<BackupRecord | null>(null)
  const [deleteForce, setDeleteForce] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<unknown>(null)

  const verifyBackup = useCallback(
    async (record: BackupRecord, restoreTest: boolean) => {
      setVerifyError(null)
      setVerifyBusyId(record.id)
      setJobEvent(null)
      try {
        const updated = await call('backup.verify', { id: record.id, restoreTest })
        refresh()
        setBackupDetail(updated)
        if (updated.status === 'verified' || updated.status === 'restore_tested') {
          toastOk(
            '备份校验完成',
            updated.status === 'restore_tested' ? '已通过恢复测试（临时库）' : '文件完整性校验通过（未做恢复测试）'
          )
        } else {
          pushToast({
            kind: 'error',
            title: '备份校验未通过',
            body: updated.verification.notes.join('；') || updated.error || '请查看详情'
          })
        }
      } catch (e) {
        setVerifyError(e)
        toastError(e)
      } finally {
        setVerifyBusyId(null)
      }
    },
    [pushToast, refresh, toastError, toastOk]
  )

  const submitDelete = useCallback(async () => {
    if (!deleteBackup) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await call('backup.delete', { id: deleteBackup.id, force: deleteForce })
      toastOk('备份已删除', deleteBackup.fileName)
      setDeleteBackup(null)
      setDeleteForce(false)
      refresh()
    } catch (e) {
      setDeleteError(e)
    } finally {
      setDeleteBusy(false)
    }
  }, [deleteBackup, deleteForce, refresh, toastOk])

  /* ------------------------------------------------------ restore flow */
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null)
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null)
  const [restorePreviewLoading, setRestorePreviewLoading] = useState(false)
  const [restorePreviewError, setRestorePreviewError] = useState<unknown>(null)
  const [restoreApproval, setRestoreApproval] = useState<ApprovalRequest | null>(null)
  const [restoreApprovalError, setRestoreApprovalError] = useState<unknown>(null)
  const [restoreToken, setRestoreToken] = useState<string | null>(null)
  const [restoreApproving, setRestoreApproving] = useState(false)
  const [restoreConfirmText, setRestoreConfirmText] = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [restoreError, setRestoreError] = useState<unknown>(null)
  const [restoreJob, setRestoreJob] = useState<RestoreJob | null>(null)

  const findRestoreApproval = useCallback(
    async (preview: RestorePreview) => {
      setRestoreApprovalError(null)
      try {
        const pending = await call('approval.pending', { projectId: projectId || undefined })
        let match: ApprovalRequest | undefined
        if (preview.approvalToken) {
          match =
            pending.find((item) => item.id === preview.approvalToken) ??
            pending.find((item) => item.planId === preview.approvalToken)
        }
        if (!match) {
          match = pending.find(
            (item) => item.kind === 'restore' && item.targets.includes(preview.targetDatabase)
          )
        }
        if (!match) {
          match = pending
            .filter((item) => item.kind === 'restore')
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
        }
        setRestoreApproval(match ?? null)
        if (!match && preview.approvalToken) {
          setRestoreApprovalError(
            new Error('恢复预览返回了审批令牌，但待审批列表中找不到对应记录，无法确认其批准状态，因此暂时不能执行原地恢复。')
          )
        }
      } catch (e) {
        setRestoreApprovalError(e)
      }
    },
    [projectId]
  )

  const openRestore = useCallback(
    async (backup: BackupRecord, mode: 'to_temp_database' | 'in_place') => {
      setBackupDetail(null)
      setRestoreTarget({ backup, mode })
      setRestorePreview(null)
      setJobEvent(null)
      setRestorePreviewError(null)
      setRestoreApproval(null)
      setRestoreApprovalError(null)
      setRestoreToken(null)
      setRestoreConfirmText('')
      setRestoreJob(null)
      setRestoreError(null)
      setRestorePreviewLoading(true)
      try {
        const preview = await call('recovery.previewRestore', {
          backupId: backup.id,
          connectionId: backup.connectionId,
          mode,
          ...(mode === 'in_place' ? { targetDatabase: backup.database } : {})
        })
        setRestorePreview(preview)
        if (mode === 'in_place') {
          void findRestoreApproval(preview)
        }
      } catch (e) {
        setRestorePreviewError(e)
      } finally {
        setRestorePreviewLoading(false)
      }
    },
    [findRestoreApproval]
  )

  const approveRestore = useCallback(async () => {
    if (!restoreApproval) return
    setRestoreApproving(true)
    setRestoreError(null)
    try {
      const approved = await call('approval.approve', {
        planId: restoreApproval.planId,
        comment: '时间机器原地恢复审批'
      })
      setRestoreApproval(approved)
      setRestoreToken(approved.id)
      toastOk('恢复审批已通过', `审批记录 ${approved.id}`)
    } catch (e) {
      setRestoreError(e)
    } finally {
      setRestoreApproving(false)
    }
  }, [restoreApproval, toastOk])

  const executeRestore = useCallback(async () => {
    if (!restoreTarget || !restorePreview) return
    setRestoreError(null)
    if (restoreTarget.mode === 'in_place') {
      if (!restorePreview.requiresApproval && !restoreToken) {
        // The service still requires an approval token for in-place restore.
      }
      if (!restoreToken) {
        setRestoreError(new Error('原地恢复必须先获得人工审批'))
        return
      }
      if (restoreConfirmText.trim() !== restorePreview.targetDatabase) {
        setRestoreError(new Error('请输入完整的目标数据库名以确认覆盖操作'))
        return
      }
    }
    setRestoreBusy(true)
    setJobEvent(null)
    try {
      const job =
        restoreTarget.mode === 'to_temp_database'
          ? await call('recovery.restoreToTemp', {
              backupId: restoreTarget.backup.id,
              ...(projectId ? { projectId } : {})
            })
          : await call('recovery.restoreInPlace', {
              backupId: restoreTarget.backup.id,
              approvalToken: restoreToken as string,
              confirmed: true
            })
      setRestoreJob(job)
      refresh()
      if (job.status === 'completed') {
        toastOk(
          restoreTarget.mode === 'to_temp_database' ? '已恢复到临时库' : '原地恢复已完成',
          job.tempDatabase ? `临时库：${job.tempDatabase}` : `恢复任务 ${job.id}`
        )
      } else {
        pushToast({
          kind: 'error',
          title: '恢复未成功完成',
          body: job.error ?? `状态：${job.status}${job.mayBePartial ? '，数据库可能处于部分恢复状态' : ''}`
        })
      }
    } catch (e) {
      setRestoreError(e)
      toastError(e)
    } finally {
      setRestoreBusy(false)
    }
  }, [projectId, pushToast, refresh, restoreConfirmText, restorePreview, restoreTarget, restoreToken, toastError, toastOk])

  /* --------------------------------------------------------- jobs tab */
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [jobDetail, setJobDetail] = useState<RestoreJob | null>(null)
  const [jobDetailError, setJobDetailError] = useState<unknown>(null)

  const selectJob = useCallback(
    async (job: RestoreJob) => {
      setSelectedJobId(job.id)
      setJobDetail(job)
      setJobDetailError(null)
      try {
        const fresh = await call('recovery.job.get', { jobId: job.id })
        if (fresh) setJobDetail(fresh)
      } catch (e) {
        setJobDetailError(e)
      }
    },
    []
  )

  /* --------------------------------------------------------- diff tab */
  const [snapshotA, setSnapshotA] = useState('')
  const [snapshotB, setSnapshotB] = useState('')
  const [diff, setDiff] = useState<SchemaDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<unknown>(null)

  const snapshots = snapshotsState.data ?? []

  const runDiff = useCallback(async () => {
    if (!snapshotA || !snapshotB) return
    setDiffLoading(true)
    setDiffError(null)
    setDiff(null)
    try {
      const result = await call('schema.diff', { snapshotAId: snapshotA, snapshotBId: snapshotB })
      setDiff(result)
    } catch (e) {
      setDiffError(e)
    } finally {
      setDiffLoading(false)
    }
  }, [snapshotA, snapshotB])

  /* ----------------------------------------------------------- render */
  const recoveryPoints = recoveryState.data?.items ?? []
  const backups = backupsState.data?.items ?? []
  const jobs = jobsState.data?.items ?? []
  const stats = backupStatsState.data

  const projectSelect = (
    <Field label="项目" className="intel-project-select">
      <Select
        value={projectId}
        onChange={(value) => {
          setProjectId(value)
          setDiff(null)
          setSelectedJobId(null)
          setJobDetail(null)
        }}
        options={[
          { value: '', label: '全部项目 / 未过滤' },
          ...projects.map((project) => ({ value: project.id, label: project.name }))
        ]}
      />
    </Field>
  )

  const recoveryRow = (point: RecoveryPoint): ReactNode => (
    <div className="intel-row-card" key={point.id}>
      <div className="intel-row-head">
        <span className="strong small mono">{formatDate(point.createdAt)}</span>
        <span className="badge neutral">{recoveryKindLabel[point.kind]}</span>
        <RiskBadge risk={point.risk} />
        <span className={point.status === 'ready' ? 'badge ok' : point.status === 'partial' ? 'badge warn' : point.status === 'unusable' ? 'badge danger' : 'badge neutral'}>
          {recoveryStatusLabel[point.status]}
        </span>
        {point.verified && <span className="badge ok">已验证</span>}
        <div className="spacer" />
        <div className="intel-row-actions">
          <Button size="sm" onClick={() => setDetailPoint(point)}>
            <FileSearch size={12} /> 详情
          </Button>
          <Button size="sm" onClick={() => void openUndo(point)} disabled={point.status === 'unusable'}>
            <RotateCcw size={12} /> 撤销预览
          </Button>
        </div>
      </div>
      <div className="mt-2">
        <CoverageBadges point={point} />
      </div>
      <div className="mt-2">
        <div className="intel-meta-grid">
          <div>
            <span className="k">数据库</span>
            <span className="v mono">{point.database}</span>
          </div>
          <div>
            <span className="k">目标表</span>
            <span className="v mono">{point.targetTables.join(', ') || '—'}</span>
          </div>
          <div>
            <span className="k">已捕获行数</span>
            <span className="v intel-num">
              {formatNumber(capturedRows(point))}
              {point.captured.some((set) => set.truncated) && <span className="badge warn" style={{ marginLeft: 4 }}>截断</span>}
            </span>
          </div>
          <div>
            <span className="k">创建时间</span>
            <span className="v">{formatRelative(point.createdAt)}</span>
          </div>
          <div>
            <span className="k">校验时间</span>
            <span className="v">{formatDate(point.verifiedAt)}</span>
          </div>
          <div>
            <span className="k">操作 ID</span>
            <span className="v">
              <IdText value={point.executionId} />
            </span>
          </div>
        </div>
        {point.note && <div className="small muted mt-1">{point.note}</div>}
      </div>
    </div>
  )

  const backupRow = (record: BackupRecord): ReactNode => {
    const restoreTested = record.status === 'restore_tested' || Boolean(record.verification.restoreTestedAt)
    return (
      <div className="intel-row-card" key={record.id}>
        <div className="intel-row-head">
          <span className="strong small mono">{record.database}</span>
          <BackupStatusBadge status={record.status} />
          {restoreTested ? (
            <span className="badge ok">
              <CheckCircle2 size={10} /> 已通过恢复验证
            </span>
          ) : record.status === 'verified' ? (
            <span className="badge accent">文件已校验（未做恢复测试）</span>
          ) : (
            <span className="badge warn">未校验</span>
          )}
          {record.referencedByRecoveryPoints > 0 && (
            <span className="badge purple">被 {record.referencedByRecoveryPoints} 个恢复点引用</span>
          )}
          <div className="spacer" />
          <div className="intel-row-actions">
            <Button
              size="sm"
              loading={verifyBusyId === record.id}
              disabled={verifyBusyId !== null}
              onClick={() => void verifyBackup(record, false)}
              title="只校验文件存在、非空、校验和与结构"
            >
              校验
            </Button>
            <Button
              size="sm"
              loading={verifyBusyId === record.id}
              disabled={verifyBusyId !== null}
              onClick={() => void verifyBackup(record, true)}
              title="在临时数据库实际恢复并比对，会创建并随后删除临时库"
            >
              恢复测试
            </Button>
            <Button size="sm" onClick={() => setBackupDetail(record)}>
              <FileSearch size={12} /> 详情
            </Button>
            <Button size="sm" variant="primary" onClick={() => void openRestore(record, 'to_temp_database')}>
              <Upload size={12} /> 恢复到临时库
            </Button>
            <Button size="sm" variant="danger" onClick={() => void openRestore(record, 'in_place')}>
              <ShieldAlert size={12} /> 原地恢复
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDeleteBackup(record)
                setDeleteForce(false)
                setDeleteError(null)
              }}
            >
              <Trash2 size={12} /> 删除
            </Button>
          </div>
        </div>
        <div className="mt-2">
          <div className="intel-meta-grid">
            <div>
              <span className="k">文件</span>
              <span className="v mono truncate" title={record.filePath}>
                {record.fileName}
              </span>
            </div>
            <div>
              <span className="k">范围 / 类型</span>
              <span className="v">
                {record.scope === 'database' ? '整库' : `指定表（${record.tables.length}）`} · {record.type}
              </span>
            </div>
            <div>
              <span className="k">文件大小</span>
              <span className="v intel-num">{formatBytes(record.fileSize)}</span>
            </div>
            <div>
              <span className="k">创建时间</span>
              <span className="v">{formatRelative(record.createdAt)}</span>
            </div>
            <div>
              <span className="k">校验和</span>
              <span className="v mono xs">{record.checksumSha256.slice(0, 16)}…</span>
            </div>
            <div>
              <span className="k">保留至</span>
              <span className="v">{formatDate(record.retentionUntil)}</span>
            </div>
          </div>
          {record.error && <div className="small mt-1" style={{ color: '#ff9d9d' }}>错误：{record.error}</div>}
        </div>
      </div>
    )
  }

  const renderDiff = (): ReactNode => {
    if (!projectId) {
      return <Callout kind="info" title="请选择项目">结构快照按项目保存，选择项目后才能对比两个快照。</Callout>
    }
    if (snapshotsState.loading) return <LoadingBlock label="加载结构快照…" />
    if (snapshotsState.error !== null) return <ErrorLine error={snapshotsState.error} title="结构快照加载失败" />
    if (snapshots.length < 2) {
      return (
        <EmptyState
          icon={<GitCompare size={24} />}
          title="至少需要两个结构快照"
          body="在工作区执行 Schema 扫描以生成快照，然后回到这里选择两个快照进行差异对比。"
        />
      )
    }
    const optionList = snapshots.map((snapshot) => ({
      value: snapshot.id,
      label: `${formatDate(snapshot.takenAt)} · ${snapshot.database} · ${snapshot.objectCount} 个对象 · v${snapshot.version}`
    }))
    return (
      <>
        <div className="intel-toolbar">
          <Field label="基准快照（A）" className="grow">
            <Select value={snapshotA} onChange={setSnapshotA} options={[{ value: '', label: '选择快照 A…' }, ...optionList]} />
          </Field>
          <Field label="对比快照（B）" className="grow">
            <Select value={snapshotB} onChange={setSnapshotB} options={[{ value: '', label: '选择快照 B…' }, ...optionList]} />
          </Field>
          <Button variant="primary" loading={diffLoading} disabled={!snapshotA || !snapshotB || snapshotA === snapshotB} onClick={() => void runDiff()}>
            <GitCompare size={13} /> 对比
          </Button>
        </div>
        {snapshotA && snapshotA === snapshotB && <div className="small muted mb-2">请选择两个不同的快照。</div>}
        {diffError !== null && <ErrorLine error={diffError} title="结构差异计算失败" />}
        {diff && (
          <div className="col" style={{ gap: 10 }}>
            <div className="row wrap">
              <span className="small muted">A：{formatDate(diff.takenAtA)}</span>
              <span className="small muted">B：{formatDate(diff.takenAtB)}</span>
              {diff.identical && (
                <span className="badge ok">
                  <CheckCircle2 size={10} /> 两个快照结构完全一致
                </span>
              )}
            </div>

            <div className="intel-grid-2">
              <Card title="新增表" sub={diff.addedTables.length === 0 ? '无' : undefined}>
                {diff.addedTables.length === 0 ? (
                  <div className="small muted">无新增表</div>
                ) : (
                  <div>
                    {diff.addedTables.map((table) => (
                      <span className="intel-tag mono" key={table}>
                        + {table}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
              <Card title="删除表" sub={diff.removedTables.length === 0 ? '无' : undefined}>
                {diff.removedTables.length === 0 ? (
                  <div className="small muted">无删除表</div>
                ) : (
                  <div>
                    {diff.removedTables.map((table) => (
                      <span className="badge danger" key={table} style={{ marginRight: 4, marginBottom: 4 }}>
                        − {table}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <SectionTitle icon={<GitCompare size={13} />}>变更表（{diff.changedTables.length}）</SectionTitle>
            {diff.changedTables.length === 0 ? (
              <div className="small muted">没有表结构变更。</div>
            ) : (
              diff.changedTables.map((change) => (
                <div className="intel-row-card" key={change.name}>
                  <div className="intel-row-head">
                    <span className="strong mono">{change.name}</span>
                    {change.addedColumns.length > 0 && <span className="badge ok">+{change.addedColumns.length} 列</span>}
                    {change.removedColumns.length > 0 && <span className="badge danger">−{change.removedColumns.length} 列</span>}
                    {change.changedColumns.length > 0 && <span className="badge warn">{change.changedColumns.length} 列变更</span>}
                    {change.primaryKeyChanged && <span className="badge warn">主键变化</span>}
                    {change.foreignKeysChanged && <span className="badge warn">外键变化</span>}
                  </div>
                  <div className="mt-2 col" style={{ gap: 6 }}>
                    {change.addedColumns.length > 0 && (
                      <div>
                        <div className="intel-step-label">新增列</div>
                        {change.addedColumns.map((column) => (
                          <span className="intel-tag mono" key={column.name}>
                            + {column.name} {column.columnType}
                            {column.nullable ? '' : ' NOT NULL'}
                          </span>
                        ))}
                      </div>
                    )}
                    {change.removedColumns.length > 0 && (
                      <div>
                        <div className="intel-step-label">删除列</div>
                        {change.removedColumns.map((column) => (
                          <span className="intel-tag mono" key={column.name}>
                            − {column.name} {column.columnType}
                          </span>
                        ))}
                      </div>
                    )}
                    {change.changedColumns.length > 0 && (
                      <div>
                        <div className="intel-step-label">列定义变更</div>
                        <div className="table-wrap">
                          <table className="table">
                            <thead>
                              <tr>
                                <th>列</th>
                                <th>变更前</th>
                                <th>变更后</th>
                              </tr>
                            </thead>
                            <tbody>
                              {change.changedColumns.map((column) => (
                                <tr key={column.name}>
                                  <td className="mono">{column.name}</td>
                                  <td className="xs">
                                    {column.before
                                      ? `${column.before.columnType}${column.before.nullable ? ' NULL' : ' NOT NULL'} default=${
                                          column.before.defaultValue ?? '—'
                                        }${column.before.isPrimaryKey ? ' PK' : ''}`
                                      : '（不存在）'}
                                  </td>
                                  <td className="xs">
                                    {column.after
                                      ? `${column.after.columnType}${column.after.nullable ? ' NULL' : ' NOT NULL'} default=${
                                          column.after.defaultValue ?? '—'
                                        }${column.after.isPrimaryKey ? ' PK' : ''}`
                                      : '（已删除）'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    {change.addedIndexes.length > 0 && (
                      <div>
                        <div className="intel-step-label">新增索引</div>
                        {change.addedIndexes.map((index) => (
                          <span className="intel-tag mono" key={index.name}>
                            + {index.name} ({index.columns.join(', ')}){index.unique ? ' UNIQUE' : ''}
                          </span>
                        ))}
                      </div>
                    )}
                    {change.removedIndexes.length > 0 && (
                      <div>
                        <div className="intel-step-label">删除索引</div>
                        {change.removedIndexes.map((index) => (
                          <span className="intel-tag mono" key={index.name}>
                            − {index.name} ({index.columns.join(', ')})
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </>
    )
  }

  /* ------------------------------------------------------------ page */
  return (
    <div className="page">
      <PageHeader
        title="时间机器"
        sub="恢复点覆盖状态、备份、恢复任务与结构差异；恢复状态严格区分，不会把「仅操作日志」显示为「已备份」"
        actions={
          <>
            {projectSelect}
            <RefreshButton onClick={refresh} loading={recoveryState.loading || backupsState.loading || jobsState.loading} />
          </>
        }
      />

      <div className="intel-tabs">
        {TABS.map((item) => (
          <button key={item.key} type="button" className={`tab ${tab === item.key ? 'active' : ''}`} onClick={() => setTab(item.key)}>
            <span className="row" style={{ gap: 6 }}>
              {item.icon}
              {item.label}
              {item.key === 'recovery' && <span className="badge neutral">{recoveryState.data?.total ?? 0}</span>}
              {item.key === 'backups' && <span className="badge neutral">{backupsState.data?.total ?? 0}</span>}
              {item.key === 'jobs' && <span className="badge neutral">{jobsState.data?.total ?? 0}</span>}
            </span>
          </button>
        ))}
      </div>

      <div className="page-body">
        {/* ------------------------------------------------- recovery tab */}
        {tab === 'recovery' && (
          <>
            <div className="grid-2 mb-2">
              <Callout kind="warn" title="请区分四种真实状态">
                仅操作日志 ≠ 已保存变更前镜像 ≠ 已完成完整备份 ≠ 已通过恢复验证。只有保存了变更前镜像的恢复点才能尝试按主键撤销；DDL
                可能隐式提交，不能依赖事务回滚。
              </Callout>
              <CoverageLegend />
            </div>
            {recoveryState.error !== null && <ErrorLine error={recoveryState.error} title="恢复点加载失败" />}
            {recoveryState.loading && recoveryPoints.length === 0 ? (
              <LoadingBlock label="加载恢复点…" />
            ) : recoveryPoints.length === 0 ? (
              <EmptyState
                icon={<Clock4 size={24} />}
                title="暂无恢复点"
                body="执行受保护的写操作后，主进程会记录变更前镜像、结构快照或完整备份。这里会如实展示实际捕获到的恢复能力。"
              />
            ) : (
              <div className="col" style={{ gap: 8 }}>
                {recoveryPoints.map(recoveryRow)}
              </div>
            )}
          </>
        )}

        {/* -------------------------------------------------- backups tab */}
        {tab === 'backups' && (
          <>
            {stats ? (
              <div className="intel-grid-stat mb-2">
                <StatCard label="备份数量" value={stats.count} tone="accent" />
                <StatCard label="总大小" value={formatBytes(stats.totalBytes)} />
                <StatCard label="剩余磁盘" value={formatBytes(stats.freeBytes)} tone={stats.maxBackupBytes > 0 && stats.freeBytes < stats.maxBackupBytes ? 'warn' : 'none'} />
                <StatCard label="保留期限" value={`${stats.retentionDays} 天`} />
                <StatCard
                  label="mysqldump"
                  value={stats.dumperAvailable ? '可用' : '不可用'}
                  tone={stats.dumperAvailable ? 'ok' : 'warn'}
                  hint={stats.dumperAvailable ? '外部工具可用（仍会校验退出码与文件）' : '将使用内置备份引擎或报错'}
                />
                <StatCard label="备份目录" value={<span className="small mono">{stats.backupDir}</span>} />
              </div>
            ) : backupStatsState.error !== null ? (
              <ErrorLine error={backupStatsState.error} title="备份统计加载失败" />
            ) : (
              <LoadingBlock label="加载备份统计…" />
            )}

            {stats && (
              <div className="row wrap mb-2" style={{ gap: 8 }}>
                <Button variant="primary" onClick={openCreate}>
                  <Archive size={13} /> 创建备份
                </Button>
                <Button onClick={() => openPath(stats.backupDir)}>
                  <FolderOpen size={13} /> 打开备份目录
                </Button>
                <span className="small muted">
                  备份容量上限 {formatBytes(stats.maxBackupBytes)} · 清理前会检查恢复点引用
                </span>
              </div>
            )}

            {verifyError !== null && <ErrorLine error={verifyError} title="备份校验失败" />}
            {backupsState.error !== null && <ErrorLine error={backupsState.error} title="备份列表加载失败" />}
            {backupsState.loading && backups.length === 0 ? (
              <LoadingBlock label="加载备份列表…" />
            ) : backups.length === 0 ? (
              <EmptyState
                icon={<Archive size={24} />}
                title="暂无备份"
                body="创建备份时会记录文件路径、大小、SHA-256、Schema 版本与验证状态。请用「校验」确认真实可用性，不要只看创建时间。"
              />
            ) : (
              <div className="col" style={{ gap: 8 }}>
                {backups.map(backupRow)}
              </div>
            )}
          </>
        )}

        {/* ----------------------------------------------------- jobs tab */}
        {tab === 'jobs' && (
          <>
            <div className="row between mb-2">
              <span className="small muted">
                恢复任务记录包含步骤、冲突、可能的部分恢复状态与日志路径。失败的任务不会显示为成功。
              </span>
              <RefreshButton onClick={refresh} loading={jobsState.loading} />
            </div>
            {jobsState.error !== null && <ErrorLine error={jobsState.error} title="恢复任务加载失败" />}
            {jobsState.loading && jobs.length === 0 ? (
              <LoadingBlock label="加载恢复任务…" />
            ) : (
              <div className="intel-split" style={{ gridTemplateColumns: '340px minmax(0, 1fr)', minHeight: 400 }}>
                <div className="intel-pane" style={{ borderRight: '1px solid var(--border)' }}>
                  <div className="intel-pane-head">
                    <span className="intel-pane-title">恢复任务（{jobs.length}）</span>
                  </div>
                  <div className="intel-pane-body">
                    <RestoreJobList jobs={jobs} selectedId={selectedJobId} onSelect={(job) => void selectJob(job)} />
                  </div>
                </div>
                <div className="intel-pane">
                  <div className="intel-pane-head">
                    <span className="intel-pane-title">{jobDetail ? `任务 ${jobDetail.id}` : '任务详情'}</span>
                  </div>
                  <div className="intel-pane-body">
                    {jobDetailError !== null && <ErrorLine error={jobDetailError} title="任务详情加载失败（显示列表快照）" />}
                    {jobDetail ? (
                      <RestoreJobPanel key={jobDetail.id} job={jobDetail} onShowPath={openPath} />
                    ) : (
                      <div className="intel-empty-hint">选择左侧的恢复任务查看步骤、冲突与日志路径。</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ----------------------------------------------------- diff tab */}
        {tab === 'diff' && renderDiff()}
      </div>

      {/* ------------------------------------------------- recovery detail */}
      <Modal
        open={detailPoint !== null}
        title="恢复点详情"
        wide
        onClose={() => setDetailPoint(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDetailPoint(null)}>
              关闭
            </Button>
            {detailPoint && (
              <Button
                variant="primary"
                onClick={() => {
                  const point = detailPoint
                  setDetailPoint(null)
                  void openUndo(point)
                }}
              >
                <RotateCcw size={13} /> 打开撤销预览
              </Button>
            )}
          </>
        }
      >
        {detailPoint && (
          <div className="col" style={{ gap: 10 }}>
            <CoverageBadges point={detailPoint} />
            <div className="intel-meta-grid">
              <div>
                <span className="k">恢复点 ID</span>
                <span className="v">
                  <IdText value={detailPoint.id} />
                </span>
              </div>
              <div>
                <span className="k">类型</span>
                <span className="v">{recoveryKindLabel[detailPoint.kind]}</span>
              </div>
              <div>
                <span className="k">策略</span>
                <span className="v">{detailPoint.strategy}</span>
              </div>
              <div>
                <span className="k">风险</span>
                <span className="v">{riskLabel[detailPoint.risk]}</span>
              </div>
              <div>
                <span className="k">状态</span>
                <span className="v">{recoveryStatusLabel[detailPoint.status]}</span>
              </div>
              <div>
                <span className="k">数据库</span>
                <span className="v mono">{detailPoint.database}</span>
              </div>
              <div>
                <span className="k">目标表</span>
                <span className="v mono">{detailPoint.targetTables.join(', ') || '—'}</span>
              </div>
              <div>
                <span className="k">创建时间</span>
                <span className="v">{formatDate(detailPoint.createdAt)}</span>
              </div>
              <div>
                <span className="k">校验时间</span>
                <span className="v">{formatDate(detailPoint.verifiedAt)}</span>
              </div>
              <div>
                <span className="k">数据大小</span>
                <span className="v">{formatBytes(detailPoint.sizeBytes)}</span>
              </div>
              <div>
                <span className="k">执行 ID</span>
                <span className="v">
                  <IdText value={detailPoint.executionId} />
                </span>
              </div>
              <div>
                <span className="k">计划 ID</span>
                <span className="v">
                  <IdText value={detailPoint.planId} />
                </span>
              </div>
              <div>
                <span className="k">备份 ID</span>
                <span className="v">
                  <IdText value={detailPoint.backupId ?? null} />
                </span>
              </div>
              <div>
                <span className="k">结构快照 ID</span>
                <span className="v">
                  <IdText value={detailPoint.schemaSnapshotId ?? null} />
                </span>
              </div>
              <div>
                <span className="k">校验和</span>
                <span className="v mono xs">{detailPoint.checksum ?? '—'}</span>
              </div>
            </div>
            {detailPoint.beforeImagePath && (
              <div className="row wrap">
                <span className="small muted">变更前镜像文件</span>
                <span className="mono xs">{detailPoint.beforeImagePath}</span>
                <Button size="sm" variant="ghost" onClick={() => openPath(detailPoint.beforeImagePath as string)}>
                  <FolderOpen size={12} /> 打开位置
                </Button>
              </div>
            )}
            <div>
              <div className="intel-step-label mb-1">捕获的行集</div>
              {detailPoint.captured.length === 0 ? (
                <div className="small muted">未捕获任何行集（可能只记录了操作日志或结构快照）。</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>表</th>
                        <th>主键列</th>
                        <th>行数</th>
                        <th>是否截断</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailPoint.captured.map((set, index) => (
                        <tr key={index}>
                          <td className="mono">{set.table}</td>
                          <td className="mono xs">{set.primaryKeyColumns.join(', ') || '（无主键）'}</td>
                          <td className="intel-num">{formatNumber(set.rowCount)}</td>
                          <td>{set.truncated ? <span className="badge warn">已截断</span> : '否'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {detailPoint.note && <Callout kind="info" title="备注">{detailPoint.note}</Callout>}
          </div>
        )}
      </Modal>

      {/* ------------------------------------------------------ undo dialog */}
      <Modal
        open={undoPoint !== null}
        title="撤销预览"
        wide
        onClose={() => setUndoPoint(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUndoPoint(null)} disabled={undoExecuting}>
              关闭
            </Button>
            <Button
              variant="danger"
              loading={undoExecuting}
              disabled={
                !undoPreview ||
                !undoPreview.canUndo ||
                !undoConfirmed ||
                (undoPreview.requiresApproval && !undoToken) ||
                undoExecuting
              }
              onClick={() => void executeUndo()}
            >
              <RotateCcw size={13} /> 执行撤销
            </Button>
          </>
        }
      >
        {undoPoint && (
          <div className="col" style={{ gap: 10 }}>
            <Callout kind="warn" title="撤销是通过主键与前/后镜像反向恢复，不是完整备份还原">
              冲突检测失败或存在并发修改时，主进程会停止自动覆盖并展示差异。DDL 可能隐式提交，不能承诺事务回滚。
            </Callout>
            {undoError !== null && <ErrorLine error={undoError} />}
            {undoLoading && <LoadingBlock label="生成撤销预览…" />}

            {undoPreview && <UndoPreviewView preview={undoPreview} />}

            {undoPreview?.requiresApproval && (
              <div className="intel-danger-zone">
                <div className="strong mb-1">该撤销需要人工审批</div>
                {undoApprovalError !== null && <ErrorLine error={undoApprovalError} />}
                {undoToken ? (
                  <div className="small">
                    <span className="badge ok">审批已通过</span> 审批记录 <span className="mono">{undoToken}</span>
                  </div>
                ) : undoApproval ? (
                  <div className="col" style={{ gap: 8 }}>
                    <div className="small">
                      <span className="badge warn">待批准</span> 审批 <span className="mono">{undoApproval.id}</span> ·{' '}
                      {undoApproval.summary}
                    </div>
                    <div className="row wrap">
                      <Button variant="primary" size="sm" loading={undoApproving} onClick={() => void approveUndo()}>
                        批准此撤销
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => undoPoint && void findUndoApproval(undoPoint)}>
                        刷新待审批
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="small">
                    撤销预览要求审批，但当前待审批列表中未找到与该恢复点（planId{' '}
                    <span className="mono">{undoPoint.planId}</span>）匹配的审批记录。
                    <div className="row wrap mt-2">
                      <Button size="sm" onClick={() => void findUndoApproval(undoPoint)}>
                        刷新待审批列表
                      </Button>
                    </div>
                    <div className="muted mt-1">
                      如果主进程尚未创建审批记录，请先在 SQL 工作区对该计划发起审批，或联系主进程实现方补齐撤销审批创建。
                    </div>
                  </div>
                )}
              </div>
            )}

            {undoPreview && !undoJob && (
              <div className="intel-danger-zone">
                <Checkbox
                  checked={undoConfirmed}
                  onChange={setUndoConfirmed}
                  label="我已检查变更集、冲突与 SQL 预览，确认执行撤销。"
                />
                {undoPreview.conflicts.length > 0 && (
                  <div className="small mt-1" style={{ color: '#ff9d9d' }}>
                    <AlertTriangle size={12} style={{ verticalAlign: -1 }} /> 存在 {undoPreview.conflicts.length} 个冲突；冲突记录不会被自动覆盖。
                  </div>
                )}
              </div>
            )}

            {undoJob && (
              <div className="intel-modal-section">
                <div className="title">
                  <CheckCircle2 size={13} /> 撤销执行结果（来自主进程的真实返回）
                </div>
                <RestoreJobPanel job={undoJob} onShowPath={openPath} />
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ---------------------------------------------------- create backup */}
      <Modal
        open={createOpen}
        title="创建完整备份"
        wide
        closeOnEscape={false}
        onClose={() => !createBusy && setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" disabled={createBusy} onClick={() => setCreateOpen(false)}>
              关闭
            </Button>
            <Button variant="primary" loading={createBusy} onClick={() => void submitCreate()} disabled={createBusy}>
              <Archive size={13} /> 开始创建
            </Button>
          </>
        }
      >
        <div className="col" style={{ gap: 10 }}>
          <Callout kind="info" title="备份文件与应用数据分离存储">
            备份会记录 ID、来源连接/数据库、类型、Schema 哈希、文件路径、大小、校验和、状态与恢复验证状态。
            「恢复测试」会在临时数据库中实际恢复并比对，验证后删除临时库。
          </Callout>
          {createError !== null && <ErrorLine error={createError} title="创建备份失败" />}

          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Field label="数据库连接" className="grow">
              <Select
                value={formConnectionId}
                onChange={(value) => {
                  setFormConnectionId(value)
                  const connection = connections.find((item) => item.id === value)
                  if (connection?.database && !formDatabase.trim()) setFormDatabase(connection.database)
                }}
                options={[
                  { value: '', label: connections.length === 0 ? '无可用连接' : '选择连接…' },
                  ...connections.map((connection) => ({
                    value: connection.id,
                    label: `${connection.name}（${connection.host}:${connection.port}）`
                  }))
                ]}
              />
            </Field>
            <Field label="数据库名" className="grow">
              <Input value={formDatabase} onChange={setFormDatabase} placeholder="要备份的数据库" />
            </Field>
          </div>

          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Field label="备份范围" className="grow">
              <Select
                value={formScope}
                onChange={(value) => setFormScope(value)}
                options={[
                  { value: 'database', label: '整个数据库' },
                  { value: 'tables', label: '指定表' }
                ]}
              />
            </Field>
            <Field label="备份类型" className="grow">
              <Select
                value={formType}
                onChange={(value) => setFormType(value)}
                options={[
                  { value: 'full', label: '完整（结构 + 数据）' },
                  { value: 'schema_only', label: '仅结构' },
                  { value: 'data_only', label: '仅数据' }
                ]}
              />
            </Field>
          </div>

          {formScope === 'tables' && (
            <Field label="表名（逗号或换行分隔）">
              <Textarea value={formTables} onChange={setFormTables} rows={3} placeholder="orders, order_items" />
            </Field>
          )}

          <div className="col" style={{ gap: 6 }}>
            <Checkbox checked={formVerify} onChange={setFormVerify} label="创建后立即校验文件完整性（文件存在、非空、校验和、结构）" />
            <Checkbox
              checked={formRestoreTest}
              onChange={setFormRestoreTest}
              label="执行恢复测试：在临时数据库实际恢复并比对（会创建并随后删除临时库）"
            />
            {formRestoreTest && (
              <Callout kind="warn" title="恢复测试会创建临时数据库">
                该操作需要数据库账号有创建/删除数据库的权限，并会占用磁盘与时间。测试完成后临时库会被删除；若失败，请查看返回的验证备注。
              </Callout>
            )}
          </div>

          {createBusy && (
            <div className="intel-progress-wrap">
              {jobEvent && jobEvent.kind === 'backup' ? (
                <ProgressBar value={jobEvent.progress} label={`${jobEvent.phase}：${jobEvent.message}`} />
              ) : (
                <InlineSpinner label="正在创建备份，请等待主进程返回真实结果…" />
              )}
            </div>
          )}

          {createResult && (
            <div className="intel-modal-section">
              <div className="title">
                <CheckCircle2 size={13} /> 创建结果
              </div>
              <div className="row wrap mb-2">
                <BackupStatusBadge status={createResult.status} />
                <span className="small muted">{createResult.fileName}</span>
              </div>
              <BackupMetaView record={createResult} />
              <div className="mt-2">
                <BackupVerificationView record={createResult} onShowPath={openPath} />
              </div>
              {createResult.error && (
                <Callout kind="danger" title="备份失败">
                  {createResult.error}
                </Callout>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* --------------------------------------------------- backup detail */}
      <Modal
        open={backupDetail !== null}
        title="备份详情"
        wide
        onClose={() => setBackupDetail(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBackupDetail(null)}>
              关闭
            </Button>
            {backupDetail && (
              <>
                <Button loading={verifyBusyId === backupDetail.id} onClick={() => void verifyBackup(backupDetail, false)}>
                  仅文件校验
                </Button>
                <Button loading={verifyBusyId === backupDetail.id} onClick={() => void verifyBackup(backupDetail, true)}>
                  校验 + 恢复测试
                </Button>
                <Button variant="primary" onClick={() => void openRestore(backupDetail, 'to_temp_database')}>
                  <Upload size={13} /> 恢复到临时库
                </Button>
                <Button variant="danger" onClick={() => void openRestore(backupDetail, 'in_place')}>
                  <ShieldAlert size={13} /> 原地恢复
                </Button>
              </>
            )}
          </>
        }
      >
        {backupDetail && (
          <div className="col" style={{ gap: 10 }}>
            <div className="row wrap">
              <BackupStatusBadge status={backupDetail.status} />
              {backupDetail.verification.restoreTestedAt ? (
                <span className="badge ok">已通过恢复验证</span>
              ) : backupDetail.status === 'verified' ? (
                <span className="badge accent">文件已校验（未做恢复测试）</span>
              ) : (
                <span className="badge warn">未校验</span>
              )}
            </div>
            <BackupMetaView record={backupDetail} />
            <BackupFileView record={backupDetail} />
            <SectionTitle icon={<FileSearch size={13} />}>验证结果</SectionTitle>
            <BackupVerificationView record={backupDetail} onShowPath={openPath} />
            {backupDetail.tables.length > 0 && (
              <div>
                <div className="intel-step-label mb-1">备份表清单</div>
                {backupDetail.tables.map((table) => (
                  <span className="intel-tag mono" key={table}>
                    {table}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ---------------------------------------------------- delete backup */}
      <Modal
        open={deleteBackup !== null}
        title="删除备份"
        onClose={() => !deleteBusy && setDeleteBackup(null)}
        footer={
          <>
            <Button variant="ghost" disabled={deleteBusy} onClick={() => setDeleteBackup(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={deleteBusy}
              disabled={deleteBusy || (Boolean(deleteBackup && deleteBackup.referencedByRecoveryPoints > 0) && !deleteForce)}
              onClick={() => void submitDelete()}
            >
              确认删除
            </Button>
          </>
        }
      >
        {deleteBackup && (
          <div className="col" style={{ gap: 10 }}>
            {deleteBackup.referencedByRecoveryPoints > 0 ? (
              <Callout kind="danger" title="该备份仍被恢复点引用">
                该备份被 {deleteBackup.referencedByRecoveryPoints} 个恢复点引用。删除后这些恢复点可能无法再用于恢复。普通删除会被主进程拒绝。
                <div className="mt-2">
                  <Checkbox
                    checked={deleteForce}
                    onChange={setDeleteForce}
                    label="我理解风险，强制删除该备份（引用检查将被跳过）"
                  />
                </div>
              </Callout>
            ) : (
              <Callout kind="warn" title="删除前检查引用">
                主进程会再次检查是否仍被恢复点引用。删除备份文件后不可恢复。
              </Callout>
            )}
            <div className="small">
              文件：<span className="mono">{deleteBackup.fileName}</span>
              <br />
              大小：{formatBytes(deleteBackup.fileSize)} · 校验和 <span className="mono xs">{deleteBackup.checksumSha256.slice(0, 16)}…</span>
            </div>
            {deleteError !== null && <ErrorLine error={deleteError} title="删除备份失败" />}
          </div>
        )}
      </Modal>

      {/* ----------------------------------------------------- restore flow */}
      <Modal
        open={restoreTarget !== null}
        title={restoreTarget?.mode === 'in_place' ? '原地恢复（高风险）' : '恢复到临时数据库'}
        wide
        closeOnEscape={false}
        onClose={() => !restoreBusy && setRestoreTarget(null)}
        footer={
          <>
            <Button variant="ghost" disabled={restoreBusy} onClick={() => setRestoreTarget(null)}>
              关闭
            </Button>
            {restoreTarget && restorePreview && (
              <Button
                variant={restoreTarget.mode === 'in_place' ? 'danger' : 'primary'}
                loading={restoreBusy}
                disabled={
                  restoreBusy ||
                  (restoreTarget.mode === 'in_place' &&
                    (!restoreToken || restoreConfirmText.trim() !== restorePreview.targetDatabase))
                }
                onClick={() => void executeRestore()}
              >
                {restoreTarget.mode === 'in_place' ? (
                  <>
                    <ShieldAlert size={13} /> 执行原地恢复
                  </>
                ) : (
                  <>
                    <Upload size={13} /> 恢复到临时库
                  </>
                )}
              </Button>
            )}
          </>
        }
      >
        {restoreTarget && (
          <div className="col" style={{ gap: 10 }}>
            {restoreTarget.mode === 'in_place' ? (
              <Callout kind="danger" title="原地恢复可能覆盖新数据">
                该操作会用备份覆盖目标数据库「{restorePreview?.targetDatabase ?? restoreTarget.backup.database}」中的现有对象与数据，
                备份时间点之后写入的新数据可能丢失。默认请使用「恢复到临时库」先验证。执行前需要人工审批并输入目标数据库名二次确认。
              </Callout>
            ) : (
              <Callout kind="info" title="默认安全路径：恢复到临时库">
                临时库不会影响现有数据库。恢复完成后请在临时库中验证数据，再决定是否进行原地恢复。
              </Callout>
            )}

            {restorePreviewLoading && <LoadingBlock label="生成恢复预览…" />}
            {restorePreviewError !== null && <ErrorLine error={restorePreviewError} title="恢复预览失败" />}
            {restorePreviewError !== null && restoreTarget.mode === 'in_place' && (
              <div className="small muted">无法获取恢复预览时，禁止执行原地恢复。</div>
            )}
            {restorePreview && <RestorePreviewView preview={restorePreview} />}

            {restoreTarget.mode === 'in_place' && restorePreview && (
              <div className="intel-danger-zone">
                <div className="strong mb-1">原地恢复需要人工审批并二次确认</div>
                {restoreApprovalError !== null && <ErrorLine error={restoreApprovalError} />}
                {restoreToken ? (
                  <div className="small">
                    <span className="badge ok">审批已通过</span> 审批记录 <span className="mono">{restoreToken}</span>
                  </div>
                ) : restoreApproval ? (
                  <div className="col" style={{ gap: 8 }}>
                    <div className="small">
                      <span className="badge warn">待批准</span> 审批 <span className="mono">{restoreApproval.id}</span> ·{' '}
                      {restoreApproval.summary}
                    </div>
                    <div className="row wrap">
                      <Button variant="primary" size="sm" loading={restoreApproving} onClick={() => void approveRestore()}>
                        批准原地恢复
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void findRestoreApproval(restorePreview)}>
                        刷新待审批
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="small">
                    恢复预览要求审批，但当前待审批列表中未找到匹配的恢复审批记录。
                    <div className="row wrap mt-2">
                      <Button size="sm" onClick={() => void findRestoreApproval(restorePreview)}>
                        刷新待审批列表
                      </Button>
                    </div>
                    <div className="muted mt-1">在获得有效审批之前，原地恢复按钮保持禁用。</div>
                  </div>
                )}

                <div className="mt-2">
                  <Field label={`输入目标数据库名「${restorePreview.targetDatabase}」以确认覆盖`}>
                    <Input value={restoreConfirmText} onChange={setRestoreConfirmText} placeholder={restorePreview.targetDatabase} />
                  </Field>
                </div>
              </div>
            )}

            {restoreError !== null && <ErrorLine error={restoreError} title="恢复执行失败" />}

            {restoreBusy && (
              <div className="intel-progress-wrap">
                {jobEvent && jobEvent.kind === 'restore' ? (
                  <ProgressBar value={jobEvent.progress} label={`${jobEvent.phase}：${jobEvent.message}`} />
                ) : (
                  <InlineSpinner label="正在恢复，请等待主进程返回真实结果…" />
                )}
              </div>
            )}

            {restoreJob && (
              <div className="intel-modal-section">
                <div className="title">
                  <CheckCircle2 size={13} /> 恢复结果（来自主进程的真实返回）
                </div>
                <RestoreJobPanel job={restoreJob} onShowPath={openPath} />
                {restoreJob.tempDatabase && (
                  <Callout kind="ok" title="临时数据库已创建">
                    临时库：<span className="mono">{restoreJob.tempDatabase}</span>。请在临时库中验证数据后再决定是否原地恢复；
                    验证结束后可手动删除临时库。
                  </Callout>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
