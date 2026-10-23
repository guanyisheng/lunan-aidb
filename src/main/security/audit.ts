import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import type { AuditEvent, AuditQuery, PageResult } from '@shared/types'
import type { AppStore, AuditService, EventBus } from '@main/service-contracts'
import { newId } from '@main/util/id'
import { nowIso } from '@main/util/time'
import { redactText, redactValue, sqlPreview } from './redact'
import type { Logger } from '@main/service-contracts'

/**
 * Audit trail for every meaningful database action. Records are append-only
 * from the service layer's perspective: there is no update API on purpose.
 */
export class StoreAuditService implements AuditService {
  constructor(
    private readonly store: AppStore,
    private readonly events: EventBus,
    private readonly logsDir: string,
    private readonly logger: Logger
  ) {}

  record(input: Omit<AuditEvent, 'id' | 'ts'> & { ts?: string }): AuditEvent {
    const event: AuditEvent = {
      id: newId('aud'),
      ts: input.ts ?? nowIso(),
      actor: input.actor,
      action: input.action,
      projectId: input.projectId ?? null,
      connectionId: input.connectionId ?? null,
      target: input.target ? redactText(input.target) : null,
      risk: input.risk ?? null,
      sqlPreview: input.sqlPreview ? sqlPreview(input.sqlPreview) : null,
      outcome: input.outcome,
      detail: input.detail ? redactText(input.detail) : null,
      metadata: input.metadata ? (redactValue(input.metadata) as Record<string, unknown>) : undefined
    }
    try {
      const saved = this.store.insertAudit(event)
      this.events.emit('audit.event', saved)
      return saved
    } catch (e) {
      // Auditing must never break the user's operation; report the failure loudly.
      this.logger.error('failed to persist audit event', {
        action: event.action,
        error: e instanceof Error ? e.message : String(e)
      })
      return event
    }
  }

  list(q: AuditQuery): PageResult<AuditEvent> {
    return this.store.listAudit(q)
  }

  export(q: AuditQuery & { format: 'json' | 'csv' }): { path: string; count: number } {
    const page = this.store.listAudit({ ...q, limit: 10_000, offset: 0 })
    const stamp = nowIso().replace(/[:.]/g, '-')
    const file = join(this.logsDir, `audit-${stamp}.${q.format}`)
    const stream = createWriteStream(file, { encoding: 'utf8' })
    if (q.format === 'json') {
      stream.write(JSON.stringify(page.items, null, 2))
    } else {
      stream.write('ts,actor,action,projectId,connectionId,target,risk,outcome,sqlPreview,detail\n')
      for (const e of page.items) {
        stream.write(
          [
            e.ts,
            e.actor,
            e.action,
            e.projectId ?? '',
            e.connectionId ?? '',
            e.target ?? '',
            e.risk ?? '',
            e.outcome,
            e.sqlPreview ?? '',
            e.detail ?? ''
          ]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`)
            .join(',') + '\n'
        )
      }
    }
    stream.end()
    return { path: file, count: page.items.length }
  }

  redact(text: string): string {
    return redactText(text)
  }
}
