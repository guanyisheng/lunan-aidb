import type { ReactNode } from 'react'
import type { SchemaChangeReport, SchemaDiffTableChange } from '@shared/types'
import { formatDate } from '../../lib/format'
import { Badge, Button, Callout, Modal } from '../ui'
import './workspace.css'

export interface SchemaDiffDialogProps {
  report: SchemaChangeReport | null
  open: boolean
  onClose: () => void
  /** Called after the user accepts the new snapshot; reloads the object tree. */
  onRefreshTree: () => void
}

function changeSummary(change: SchemaDiffTableChange): string {
  const parts: string[] = []
  if (change.addedColumns.length > 0) parts.push(`+${change.addedColumns.length} 列`)
  if (change.removedColumns.length > 0) parts.push(`-${change.removedColumns.length} 列`)
  if (change.changedColumns.length > 0) parts.push(`~${change.changedColumns.length} 列`)
  if (change.addedIndexes.length > 0) parts.push(`+${change.addedIndexes.length} 索引`)
  if (change.removedIndexes.length > 0) parts.push(`-${change.removedIndexes.length} 索引`)
  if (change.foreignKeysChanged) parts.push('外键变化')
  if (change.primaryKeyChanged) parts.push('主键变化')
  return parts.length > 0 ? parts.join('，') : '结构细节变化'
}

/**
 * Shows the real `schema.detectChanges` report. Explicitly separates
 * "no change" from "changed" and never claims memories were updated when the
 * service reports otherwise.
 */
export function SchemaDiffDialog(props: SchemaDiffDialogProps): ReactNode {
  const report = props.report
  if (!report) return null
  const diff = report.diff
  const changed = report.changed && diff !== null

  return (
    <Modal
      open={props.open}
      wide
      title="结构变化检测"
      onClose={props.onClose}
      footer={
        <>
          <span className="spacer" />
          <Button variant="ghost" onClick={props.onClose}>
            关闭
          </Button>
          {changed && (
            <Button variant="primary" onClick={props.onRefreshTree}>
              刷新对象树
            </Button>
          )}
        </>
      }
    >
      {!changed ? (
        <Callout kind="ok" title="未检测到结构变化">
          当前数据库结构与项目中保存的最新快照一致。
          {report.newSnapshot && (
            <div className="small muted mt-1">
              快照：<span className="mono">{report.newSnapshot.id}</span> · 对象数{' '}
              {report.newSnapshot.objectCount} · 采集于 {formatDate(report.newSnapshot.takenAt)}
            </div>
          )}
        </Callout>
      ) : (
        <>
          <Callout kind="warn" title="检测到数据库结构变化">
            <div className="row wrap">
              <span>
                新增表 <b>{diff.addedTables.length}</b>
              </span>
              <span>
                删除表 <b>{diff.removedTables.length}</b>
              </span>
              <span>
                变更表 <b>{diff.changedTables.length}</b>
              </span>
              {diff.takenAtA && diff.takenAtB && (
                <span className="small muted">
                  对比：{formatDate(diff.takenAtA)} → {formatDate(diff.takenAtB)}
                </span>
              )}
            </div>
          </Callout>

          <div className="mt-2">
            <Callout kind={report.invalidatedMemories > 0 ? 'danger' : 'info'} title="项目记忆影响">
              已失效记忆 <b>{report.invalidatedMemories}</b> 条，待复核记忆 <b>{report.staleMemories}</b> 条。
              {report.invalidatedMemories > 0
                ? '涉及这些对象的记忆已被标记失效，AI 不会再默认使用，请到记忆中心复核。'
                : '本次变化未使任何记忆失效；仍建议到记忆中心确认相关业务规则。'}
            </Callout>
          </div>

          {diff.addedTables.length > 0 && (
            <div className="mt-3">
              <div className="ws-section-title">新增表</div>
              <div className="chip-list">
                {diff.addedTables.map((table) => (
                  <span key={table} className="chip" style={{ borderColor: 'rgba(63,185,80,0.4)' }}>
                    + {table}
                  </span>
                ))}
              </div>
            </div>
          )}

          {diff.removedTables.length > 0 && (
            <div className="mt-3">
              <div className="ws-section-title">删除表</div>
              <div className="chip-list">
                {diff.removedTables.map((table) => (
                  <span key={table} className="chip" style={{ borderColor: 'rgba(255,93,93,0.45)' }}>
                    − {table}
                  </span>
                ))}
              </div>
            </div>
          )}

          {diff.changedTables.length > 0 && (
            <div className="mt-3">
              <div className="ws-section-title">变更表</div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>表</th>
                      <th>变化摘要</th>
                      <th>详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.changedTables.map((change) => (
                      <tr key={change.name}>
                        <td className="mono">{change.name}</td>
                        <td className="small">{changeSummary(change)}</td>
                        <td className="small muted">
                          {change.changedColumns.length > 0 && (
                            <div>变更列：{change.changedColumns.map((c) => c.name).join('、')}</div>
                          )}
                          {change.addedColumns.length > 0 && (
                            <div>新增列：{change.addedColumns.map((c) => c.name).join('、')}</div>
                          )}
                          {change.removedColumns.length > 0 && (
                            <div>删除列：{change.removedColumns.map((c) => c.name).join('、')}</div>
                          )}
                          {change.addedIndexes.length > 0 && (
                            <div>新增索引：{change.addedIndexes.map((i) => i.name).join('、')}</div>
                          )}
                          {change.removedIndexes.length > 0 && (
                            <div>删除索引：{change.removedIndexes.map((i) => i.name).join('、')}</div>
                          )}
                          {change.primaryKeyChanged && <Badge className="badge warn">主键变化</Badge>}
                          {change.foreignKeysChanged && <Badge className="badge warn">外键变化</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {report.newSnapshot && (
            <div className="small muted mt-3">
              已保存新快照：<span className="mono">{report.newSnapshot.id}</span> · 对象数{' '}
              {report.newSnapshot.objectCount} · 采集于 {formatDate(report.newSnapshot.takenAt)}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
