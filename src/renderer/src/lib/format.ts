import type {
  BackupStatus,
  MemoryStatus,
  MemoryTrust,
  MemoryType,
  RecoveryPointKind,
  RecoveryPointStatus,
  RestoreJobStatus,
  RiskLevel,
  SqlStatementKind
} from '@shared/types'

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—'
  if (bytes < 0) return '未知'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  const abs = Math.abs(diff)
  const unit = (v: number, u: string): string => `${v} ${u}前`
  if (abs < 60_000) return '刚刚'
  if (abs < 3_600_000) return unit(Math.floor(abs / 60_000), '分钟')
  if (abs < 86_400_000) return unit(Math.floor(abs / 3_600_000), '小时')
  if (abs < 2_592_000_000) return unit(Math.floor(abs / 86_400_000), '天')
  return formatDate(iso)
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

export const riskLabel: Record<RiskLevel, string> = {
  none: '无风险',
  low: '低',
  medium: '中',
  high: '高',
  critical: '极高'
}

export const riskBadgeClass: Record<RiskLevel, string> = {
  none: 'badge neutral',
  low: 'badge risk-low',
  medium: 'badge risk-medium',
  high: 'badge risk-high',
  critical: 'badge risk-critical'
}

export const kindLabel: Record<SqlStatementKind, string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  replace: 'REPLACE',
  create: 'CREATE',
  alter: 'ALTER',
  drop: 'DROP',
  truncate: 'TRUNCATE',
  rename: 'RENAME',
  procedure: 'CALL/过程',
  transaction: '事务',
  set: 'SET',
  show: 'SHOW',
  explain: 'EXPLAIN',
  load: 'LOAD',
  grant: '权限',
  unknown: '未知'
}

export const memoryTypeLabel: Record<MemoryType, string> = {
  schema: 'Schema 记忆',
  business: '业务记忆',
  user_confirmed: '用户确认',
  task: '任务记忆',
  sql: 'SQL 记忆',
  operation: '操作记忆'
}

export const trustLabel: Record<MemoryTrust, string> = {
  user_confirmed: '用户确认',
  verified: '已验证',
  ai_inferred: 'AI 推断',
  unverified: '未验证'
}

export const trustBadgeClass: Record<MemoryTrust, string> = {
  user_confirmed: 'badge ok',
  verified: 'badge ok',
  ai_inferred: 'badge warn',
  unverified: 'badge neutral'
}

export const memoryStatusLabel: Record<MemoryStatus, string> = {
  active: '有效',
  stale: '待复核',
  invalid: '已失效'
}

export const backupStatusLabel: Record<BackupStatus, string> = {
  creating: '创建中',
  completed: '已完成（未校验）',
  verified: '已校验',
  restore_tested: '已通过恢复验证',
  failed: '失败',
  deleted: '已删除'
}

export const recoveryKindLabel: Record<RecoveryPointKind, string> = {
  dml_before_image: '变更前镜像',
  ddl_schema_snapshot: '结构快照',
  full_backup: '完整备份',
  partial: '部分捕获',
  none: '无恢复点'
}

export const recoveryStatusLabel: Record<RecoveryPointStatus, string> = {
  ready: '可用',
  partial: '部分可用',
  unusable: '不可用',
  restored: '已恢复',
  expired: '已过期'
}

export const restoreJobStatusLabel: Record<RestoreJobStatus, string> = {
  preparing: '准备中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  partial: '部分完成',
  cancelled: '已取消'
}

export function safeJson(value: unknown, maxLength = 4000): string {
  try {
    const text = JSON.stringify(value, null, 2)
    if (!text) return String(value)
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
  } catch {
    return String(value)
  }
}
