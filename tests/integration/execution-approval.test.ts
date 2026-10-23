/**
 * Chapter 8 tests #3/#4/#10 (approval + risk gating on the real DB) and the
 * read-only execution path.
 *
 * Key invariants:
 *  - a plan cannot be executed without an explicit confirmation and a matching
 *    approval;
 *  - a plan id is single-use (no replay / double submit);
 *  - the plan hash is deterministic and bound to connection/database/sql;
 *  - an expired approval is refused and no data is written;
 *  - when a required pre-flight backup fails, the dangerous statement is never
 *    executed (the target table survives).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connection } from 'mysql2/promise'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'
import { isServerAvailable, openTestConnection } from '../helpers/mariadb'
import { addDays } from '@main/util/time'

const available = await isServerAvailable()

const ITEMS = 'qa_exec_items'
const SCRATCH = 'qa_exec_scratch'

async function countItems(conn: Connection, where = ''): Promise<number> {
  const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${ITEMS}\` ${where}`)
  return Number((rows as Array<{ n: number }>)[0].n)
}

describe.skipIf(!available)('integration: SQL execution, approvals and safety gating', () => {
  let app: TestApp
  let conn: Connection

  beforeAll(async () => {
    app = await createTestApp('exec')
    conn = await openTestConnection(app.database)
    await conn.query(`
      CREATE TABLE \`${ITEMS}\` (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(60) NOT NULL,
        qty INT NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'new',
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    for (let i = 1; i <= 5; i += 1) {
      await conn.query(`INSERT INTO \`${ITEMS}\` (name, qty, status) VALUES (?, ?, 'new')`, [
        `item-${i}`,
        i * 10
      ])
    }
  }, 240_000)

  afterAll(async () => {
    if (conn) {
      await conn.query(`DROP TABLE IF EXISTS \`${ITEMS}\``).catch(() => {})
      await conn.query(`DROP TABLE IF EXISTS \`${SCRATCH}\``).catch(() => {})
      await conn.end().catch(() => {})
    }
    await app?.dispose()
  }, 240_000)

  it('classifies through the real execution service', async () => {
    const read = await app.services.execution.classify('SELECT * FROM qa_exec_items LIMIT 5')
    expect(read.readOnly).toBe(true)
    expect(read.requiresApproval).toBe(false)

    const write = await app.services.execution.classify(
      "UPDATE qa_exec_items SET status = 'done' WHERE id = 1"
    )
    expect(write.readOnly).toBe(false)
    expect(write.requiresApproval).toBe(true)
    expect(write.overallRisk).toBe('medium')
  })

  it('runs bounded read-only queries and records history/audit', async () => {
    const result = await app.services.execution.runReadonlyQuery(
      {
        connectionId: app.connectionId,
        database: app.database,
        sql: `SELECT id, name FROM \`${ITEMS}\` ORDER BY id LIMIT 2`
      },
      'user'
    )
    expect(result.ok).toBe(true)
    expect(result.result?.rowCount).toBe(2)
    expect(result.result?.truncated).toBe(false)
    expect(result.result?.columns.map((c) => c.name)).toEqual(['id', 'name'])
    expect(result.statements).toHaveLength(1)
    expect(result.auditEventId).toBeTruthy()

    const history = app.services.execution.getHistory(
      app.services.execution.listHistory({ limit: 1 }).items[0].id
    )
    expect(history?.status).toBe('success')
  })

  it('refuses writes through the read-only channel', async () => {
    await expect(
      app.services.execution.runReadonlyQuery(
        {
          connectionId: app.connectionId,
          database: app.database,
          sql: `UPDATE \`${ITEMS}\` SET qty = 0`
        },
        'agent'
      )
    ).rejects.toMatchObject({ code: 'UNSAFE_OPERATION' })
    expect(await countItems(conn)).toBe(5)
  })

  it('executes a read-only plan without approval but requires explicit confirmation', async () => {
    const plan = await app.services.execution.plan(
      {
        connectionId: app.connectionId,
        database: app.database,
        sql: `SELECT COUNT(*) AS n FROM \`${ITEMS}\``
      },
      'user'
    )
    expect(plan.requiresApproval).toBe(false)
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/)

    await expect(
      app.services.execution.execute({ planId: plan.planId, confirmed: false }, 'user')
    ).rejects.toMatchObject({ code: 'VALIDATION' })

    const result = await app.services.execution.execute(
      { planId: plan.planId, confirmed: true, maxRows: 10 },
      'user'
    )
    expect(result.ok).toBe(true)
    // mysql2 returns BIGINT/aggregate values as strings.
    expect(Number(result.result?.rows[0][0])).toBe(5)
  })

  it('requires an approval before executing a write plan', async () => {
    const plan = await app.services.execution.plan(
      {
        connectionId: app.connectionId,
        database: app.database,
        sql: `UPDATE \`${ITEMS}\` SET status = 'approved-write' WHERE id = 1`
      },
      'user'
    )
    expect(plan.requiresApproval).toBe(true)
    expect(plan.approvalToken === undefined || typeof plan.approvalToken === 'string').toBe(true)
    expect(plan.recoveryPlan.strategy).toBe('before_image')

    await expect(
      app.services.execution.execute({ planId: plan.planId, confirmed: true }, 'user')
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })

    const approval = app.services.execution.getApprovalForPlan(plan.planId)
    expect(approval?.status).toBe('pending')
    app.services.execution.approve(plan.planId, 'integration test approval')

    const result = await app.services.execution.execute(
      { planId: plan.planId, confirmed: true },
      'user'
    )
    expect(result.ok).toBe(true)
    expect(result.statements[0].affectedRows).toBe(1)
    expect(result.recoveryPointId).toBeTruthy()
    const row = await conn.query(`SELECT status FROM \`${ITEMS}\` WHERE id = 1`)
    expect((row[0] as Array<{ status: string }>)[0].status).toBe('approved-write')

    // Plan ids are single use: replaying must be refused.
    await expect(
      app.services.execution.execute({ planId: plan.planId, confirmed: true }, 'user')
    ).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
  })

  it('binds the plan hash to connection/database/sql/trigger', async () => {
    const sql = `UPDATE \`${ITEMS}\` SET status = 'hash' WHERE id = 2`
    const first = await app.services.execution.plan(
      { connectionId: app.connectionId, database: app.database, sql },
      'user'
    )
    const second = await app.services.execution.plan(
      { connectionId: app.connectionId, database: app.database, sql },
      'user'
    )
    expect(second.planHash).toBe(first.planHash)
    expect(second.planId).not.toBe(first.planId)

    const agentTrigger = await app.services.execution.plan(
      { connectionId: app.connectionId, database: app.database, sql },
      'agent'
    )
    expect(agentTrigger.planHash).not.toBe(first.planHash)

    const otherSql = await app.services.execution.plan(
      {
        connectionId: app.connectionId,
        database: app.database,
        sql: `UPDATE \`${ITEMS}\` SET status = 'other' WHERE id = 2`
      },
      'user'
    )
    expect(otherSql.planHash).not.toBe(first.planHash)

    // Clean up pending approvals so they cannot leak into other tests.
    for (const planId of [first.planId, second.planId, agentTrigger.planId, otherSql.planId]) {
      try {
        app.services.execution.deny(planId)
      } catch {
        /* pending approval may already be resolved */
      }
    }
  })

  it('refuses an expired approval and writes nothing', async () => {
    const before = await countItems(conn, "WHERE status = 'expired-write'")
    const plan = await app.services.execution.plan(
      {
        connectionId: app.connectionId,
        database: app.database,
        sql: `UPDATE \`${ITEMS}\` SET status = 'expired-write' WHERE id = 3`
      },
      'user'
    )
    // The store only expires *pending* approvals (an approved one is short-lived
    // by construction: approve() refreshes the plan TTL). Simulate the TTL pass.
    const expiredCount = app.store.expireStaleApprovals(addDays(1))
    expect(expiredCount).toBeGreaterThanOrEqual(1)

    await expect(
      app.services.execution.execute({ planId: plan.planId, confirmed: true }, 'user')
    ).rejects.toMatchObject({ code: expect.stringMatching(/^APPROVAL_/) })
    expect(await countItems(conn, "WHERE status = 'expired-write'")).toBe(before)

    // Approving a request whose TTL has passed must be refused. The store marks
    // it status='expired' first, so the service reports VALIDATION "...状态为 expired"
    // (the dedicated APPROVAL_EXPIRED branch fires when an approved record's
    // expiresAt has passed, which needs real wall-clock expiry).
    const second = await app.services.execution.plan(
      {
        connectionId: app.connectionId,
        database: app.database,
        sql: `UPDATE \`${ITEMS}\` SET status = 'expired-write-2' WHERE id = 3`
      },
      'user'
    )
    app.store.expireStaleApprovals(addDays(1))
    expect(() => app.services.execution.approve(second.planId)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^(VALIDATION|APPROVAL_EXPIRED)$/) })
    )
    expect(await countItems(conn, "WHERE status = 'expired-write-2'")).toBe(0)
  })

  it('creates a schema-snapshot recovery point for DDL', async () => {
    const tableName = 'qa_exec_ddl_created'
    const plan = await app.services.execution.plan(
      {
        connectionId: app.connectionId,
        database: app.database,
        sql: `CREATE TABLE \`${tableName}\` (id INT PRIMARY KEY, note VARCHAR(50))`
      },
      'user'
    )
    expect(plan.recoveryPlan.strategy).toBe('schema_snapshot')
    expect(plan.requiresBackup).toBe(false)
    app.services.execution.approve(plan.planId, 'DDL test')
    const result = await app.services.execution.execute(
      { planId: plan.planId, confirmed: true },
      'user'
    )
    expect(result.ok).toBe(true)
    const [exists] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
      [tableName]
    )
    expect(Number((exists as Array<{ n: number }>)[0].n)).toBe(1)
    if (result.recoveryPointId) {
      const point = app.services.recovery.get(result.recoveryPointId)
      expect(point?.kind).toBe('ddl_schema_snapshot')
    }
    await conn.query(`DROP TABLE \`${tableName}\``)
  })

  it('blocks a DROP TABLE when the required pre-flight backup fails', async () => {
    await conn.query(`CREATE TABLE \`${SCRATCH}\` (id INT PRIMARY KEY) ENGINE=InnoDB`)
    const blockedPath = join(app.userDataDir, 'blocked-backup-dir')
    await writeFile(blockedPath, 'not a directory', 'utf8')
    const original = app.services.settings.get().backupDir
    app.services.settings.update({ backupDir: blockedPath })
    try {
      const plan = await app.services.execution.plan(
        {
          connectionId: app.connectionId,
          database: app.database,
          sql: `DROP TABLE \`${SCRATCH}\``
        },
        'user'
      )
      expect(plan.requiresBackup).toBe(true)
      expect(plan.recoveryPlan.strategy).toBe('full_backup')
      app.services.execution.approve(plan.planId, 'attempt dangerous DDL without working backups')

      await expect(
        app.services.execution.execute({ planId: plan.planId, confirmed: true }, 'user')
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(BACKUP_FAILED|PROTECTION_FAILED)$/) })

      const [exists] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
        [SCRATCH]
      )
      expect(Number((exists as Array<{ n: number }>)[0].n)).toBe(1)
    } finally {
      app.services.settings.update({ backupDir: original })
      await conn.query(`DROP TABLE IF EXISTS \`${SCRATCH}\``)
    }
  })
})
