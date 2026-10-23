/**
 * Chapter 8 tests #5 (before-image capture + restore for UPDATE/DELETE),
 * #8 (concurrent-modification conflict detection) and #9 (DDL failure with a
 * partially applied state).
 *
 * All operations run through the real execution service + time machine against
 * the portable MariaDB instance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connection } from 'mysql2/promise'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'
import { isServerAvailable, openTestConnection } from '../helpers/mariadb'

const available = await isServerAvailable()

const TABLE = 'qa_undo_items'

async function runApproved(
  app: TestApp,
  sql: string
): Promise<{ plan: Awaited<ReturnType<TestApp['services']['execution']['plan']>>; result: Awaited<ReturnType<TestApp['services']['execution']['execute']>> }> {
  const plan = await app.services.execution.plan(
    { connectionId: app.connectionId, database: app.database, sql },
    'user'
  )
  if (plan.requiresApproval) app.services.execution.approve(plan.planId, 'integration test')
  const result = await app.services.execution.execute({ planId: plan.planId, confirmed: true }, 'user')
  return { plan, result }
}

async function readRow(
  conn: Connection,
  id: number
): Promise<{ id: number; name: string; qty: number; status: string } | null> {
  const [rows] = await conn.query(`SELECT id, name, qty, status FROM \`${TABLE}\` WHERE id = ?`, [id])
  return (rows as Array<{ id: number; name: string; qty: number; status: string }>)[0] ?? null
}

describe.skipIf(!available)('integration: before-image undo, conflicts and DDL partial state', () => {
  let app: TestApp
  let conn: Connection

  beforeAll(async () => {
    app = await createTestApp('undo')
    conn = await openTestConnection(app.database)
    await conn.query(`
      CREATE TABLE \`${TABLE}\` (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(60) NOT NULL,
        qty INT NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'new',
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
  }, 240_000)

  afterAll(async () => {
    if (conn) {
      await conn.query(`DROP TABLE IF EXISTS \`${TABLE}\``).catch(() => {})
      await conn.query('DROP TABLE IF EXISTS qa_ddl_partial_ok').catch(() => {})
      await conn.end().catch(() => {})
    }
    await app?.dispose()
  }, 240_000)

  it('captures UPDATE before/after images and undoes the change', async () => {
    const [insert] = await conn.query(
      `INSERT INTO \`${TABLE}\` (name, qty, status) VALUES ('undo-me', 10, 'original')`
    )
    const id = (insert as { insertId: number }).insertId

    const { plan, result } = await runApproved(
      app,
      `UPDATE \`${TABLE}\` SET qty = 99, status = 'after' WHERE id = ${id}`
    )
    expect(plan.recoveryPlan.strategy).toBe('before_image')
    expect(result.ok).toBe(true)
    expect(result.recoveryPointId).toBeTruthy()
    expect((await readRow(conn, id))!.status).toBe('after')

    const point = app.services.recovery.get(result.recoveryPointId!)!
    expect(point.kind).toBe('dml_before_image')
    expect(point.status).toBe('ready')
    expect(point.captured.length).toBeGreaterThan(0)
    expect(point.beforeImagePath).toBeTruthy()

    const preview = await app.services.recovery.previewUndo(point.id)
    expect(preview.canUndo).toBe(true)
    expect(preview.changeSets.length).toBeGreaterThan(0)
    expect(preview.changeSets[0].operation).toBe('update')
    expect(preview.changeSets[0].rows.length).toBe(1)
    expect(preview.sqlPreview.length).toBeGreaterThan(0)

    const job = await app.services.recovery.undo(point.id, { confirmed: true })
    expect(job.status).toBe('completed')
    expect(job.verification?.passed).toBe(true)
    const restored = (await readRow(conn, id))!
    expect(restored.qty).toBe(10)
    expect(restored.status).toBe('original')
    expect(app.services.recovery.get(point.id)?.status).toBe('restored')
  })

  it('restores a deleted row from the before image', async () => {
    const [insert] = await conn.query(
      `INSERT INTO \`${TABLE}\` (name, qty, status) VALUES ('to-delete', 5, 'active')`
    )
    const id = (insert as { insertId: number }).insertId
    const { plan, result } = await runApproved(app, `DELETE FROM \`${TABLE}\` WHERE id = ${id}`)
    expect(plan.recoveryPlan.strategy).toBe('before_image')
    expect(result.ok).toBe(true)
    expect(await readRow(conn, id)).toBeNull()

    const preview = await app.services.recovery.previewUndo(result.recoveryPointId!)
    expect(preview.changeSets[0].operation).toBe('delete')
    const job = await app.services.recovery.undo(result.recoveryPointId!, { confirmed: true })
    expect(job.status).toBe('completed')
    const restored = (await readRow(conn, id))!
    expect(restored.name).toBe('to-delete')
    expect(restored.qty).toBe(5)
  })

  it('removes an inserted row on undo', async () => {
    const { result } = await runApproved(
      app,
      `INSERT INTO \`${TABLE}\` (name, qty, status) VALUES ('insert-undo', 1, 'new')`
    )
    expect(result.ok).toBe(true)
    expect(result.recoveryPointId).toBeTruthy()

    const preview = await app.services.recovery.previewUndo(result.recoveryPointId!)
    expect(preview.changeSets.length).toBeGreaterThan(0)
    expect(preview.changeSets[0].operation).toBe('insert')
    expect(preview.canUndo).toBe(true)

    const job = await app.services.recovery.undo(result.recoveryPointId!, { confirmed: true })
    expect(job.status).toBe('completed')
    const [rows] = await conn.query(`SELECT COUNT(*) AS n FROM \`${TABLE}\` WHERE name = 'insert-undo'`)
    expect(Number((rows as Array<{ n: number }>)[0].n)).toBe(0)
  })

  it('detects a concurrent modification and refuses to overwrite it', async () => {
    const [insert] = await conn.query(
      `INSERT INTO \`${TABLE}\` (name, qty, status) VALUES ('conflict', 1, 'before')`
    )
    const id = (insert as { insertId: number }).insertId

    const { result } = await runApproved(
      app,
      `UPDATE \`${TABLE}\` SET status = 'after' WHERE id = ${id}`
    )
    expect(result.ok).toBe(true)

    // Another session modifies the same row after the recovery point was taken.
    await conn.query(`UPDATE \`${TABLE}\` SET status = 'concurrent' WHERE id = ${id}`)

    const preview = await app.services.recovery.previewUndo(result.recoveryPointId!)
    expect(preview.canUndo).toBe(false)
    expect(preview.conflicts.length).toBeGreaterThan(0)
    expect(preview.conflicts[0].kind).toBe('row_changed_since_recovery')
    expect(preview.requiresApproval).toBe(true)

    const job = await app.services.recovery.undo(result.recoveryPointId!, { confirmed: true })
    expect(job.status).toBe('failed')
    expect(job.conflicts.length).toBeGreaterThan(0)
    expect(job.mayBePartial).toBe(false)

    // The newer value must survive: undo never silently overwrites new data.
    expect((await readRow(conn, id))!.status).toBe('concurrent')
    expect(app.services.recovery.get(result.recoveryPointId!)?.status).not.toBe('restored')
  })

  it('reports a partially applied multi-statement DDL instead of claiming success', async () => {
    const sql = [
      'CREATE TABLE qa_ddl_partial_ok (id INT NOT NULL PRIMARY KEY)',
      'CREATE TABLE qa_ddl_partial_ok (id INT NOT NULL PRIMARY KEY)'
    ].join('; ')
    const plan = await app.services.execution.plan(
      { connectionId: app.connectionId, database: app.database, sql },
      'user'
    )
    expect(plan.analysis.statements).toHaveLength(2)
    expect(plan.analysis.statements.every((s) => s.implicitCommit === true)).toBe(true)
    app.services.execution.approve(plan.planId, 'DDL partial test')
    const result = await app.services.execution.execute(
      { planId: plan.planId, confirmed: true },
      'user'
    )

    expect(result.ok).toBe(false)
    expect(result.error?.message).toBeTruthy()
    expect(result.statements.length).toBeGreaterThanOrEqual(1)
    expect(result.statements[0].ok).toBe(true)
    expect(result.statements.some((s) => !s.ok)).toBe(true)

    // The first DDL implicitly committed: it exists even though the batch failed.
    const [rows] = await conn.query(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'qa_ddl_partial_ok'"
    )
    expect(Number((rows as Array<{ n: number }>)[0].n)).toBe(1)

    // History must show the failure, not a fake success.
    const history = app.services.execution.listHistory({ limit: 1 }).items[0]
    expect(history.status).toBe('failed')
    expect(history.error).toBeTruthy()
  })

  it('leaves no partial state when the only DDL statement fails', async () => {
    const result = await app.services.execution
      .plan(
        {
          connectionId: app.connectionId,
          database: app.database,
          sql: 'ALTER TABLE qa_table_that_does_not_exist ADD COLUMN x INT'
        },
        'user'
      )
      .then((plan) => {
        app.services.execution.approve(plan.planId, 'ddl fail test')
        return app.services.execution.execute({ planId: plan.planId, confirmed: true }, 'user')
      })
    expect(result.ok).toBe(false)
    expect(result.statements).toHaveLength(1)
    expect(result.statements[0].ok).toBe(false)
    expect(result.error?.code).toBeTruthy()
    const [rows] = await conn.query(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'qa_table_that_does_not_exist'"
    )
    expect(Number((rows as Array<{ n: number }>)[0].n)).toBe(0)
  })
})
