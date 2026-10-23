/**
 * Chapter 8 tests #6 (backup file integrity), #7 (restore a full backup into a
 * temporary database) and #11 (retention sweep / cleanup safety).
 */
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connection } from 'mysql2/promise'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'
import {
  dropTestDatabase,
  isServerAvailable,
  openTestConnection
} from '../helpers/mariadb'

const available = await isServerAvailable()

describe.skipIf(!available)('integration: backup integrity, temp restore and retention', () => {
  let app: TestApp
  let conn: Connection
  let tempDatabases: string[] = []

  beforeAll(async () => {
    app = await createTestApp('backup')
    conn = await openTestConnection(app.database)
    await conn.query(`
      CREATE TABLE qa_bk_users (
        id INT NOT NULL AUTO_INCREMENT,
        email VARCHAR(120) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query(`
      CREATE TABLE qa_bk_orders (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT fk_bk_user FOREIGN KEY (user_id) REFERENCES qa_bk_users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
    await conn.query('CREATE VIEW qa_bk_view AS SELECT u.id, COUNT(o.id) AS n FROM qa_bk_users u LEFT JOIN qa_bk_orders o ON o.user_id = u.id GROUP BY u.id')
    for (let i = 1; i <= 4; i += 1) {
      await conn.query('INSERT INTO qa_bk_users (email) VALUES (?)', [`u${i}@example.test`])
    }
    for (let i = 1; i <= 6; i += 1) {
      await conn.query('INSERT INTO qa_bk_orders (user_id, amount) VALUES (?, ?)', [
        ((i - 1) % 4) + 1,
        i * 1.5
      ])
    }
  }, 240_000)

  afterAll(async () => {
    if (conn) {
      await conn.query('DROP VIEW IF EXISTS qa_bk_view').catch(() => {})
      await conn.query('DROP TABLE IF EXISTS qa_bk_orders').catch(() => {})
      await conn.query('DROP TABLE IF EXISTS qa_bk_users').catch(() => {})
      await conn.end().catch(() => {})
    }
    for (const db of tempDatabases) await dropTestDatabase(db)
    await app?.dispose()
  }, 240_000)

  it('creates a verified full backup whose file integrity is re-checked', async () => {
    const record = await app.services.backups.create(
      {
        connectionId: app.connectionId,
        database: app.database,
        scope: 'database',
        type: 'full',
        verify: true
      },
      {}
    )
    expect(record.database).toBe(app.database)
    expect(record.status).toBe('verified')
    expect(record.checksumSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(record.fileSize).toBeGreaterThan(0)
    expect(existsSync(record.filePath)).toBe(true)
    expect(record.fileName).toMatch(/\.sql$/)
    expect(record.verification.fileExists).toBe(true)
    expect(record.verification.nonEmpty).toBe(true)
    expect(record.verification.checksumOk).toBe(true)
    expect(record.verification.structureOk).toBe(true)
    expect(record.verification.tableCount).toBe(2)

    const verified = await app.services.backups.verify(record.id, { restoreTest: false })
    expect(verified.status).toBe('verified')
    expect(verified.verification.checksumOk).toBe(true)

    const listed = app.services.backups.list({ connectionId: app.connectionId, limit: 20 })
    expect(listed.items.some((b) => b.id === record.id)).toBe(true)
    const stats = await app.services.backups.stats()
    expect(stats.count).toBeGreaterThanOrEqual(1)
    expect(stats.backupDir.length).toBeGreaterThan(0)
    expect(stats.freeBytes).toBeGreaterThan(0)
  })

  it('records a failed backup truthfully for a missing database', async () => {
    await expect(
      app.services.backups.create(
        {
          connectionId: app.connectionId,
          database: 'qa_database_that_does_not_exist',
          scope: 'database',
          type: 'full'
        },
        {}
      )
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(NOT_FOUND|BACKUP_FAILED)$/) })
    const failed = app.services.backups.list({ connectionId: app.connectionId, limit: 20 })
    const failedRecord = failed.items.find((b) => b.status === 'failed')
    expect(failedRecord).toBeTruthy()
    expect(failedRecord?.error).toBeTruthy()
  })

  it('restores a full backup into a temp database and verifies row counts', async () => {
    const backup = await app.services.backups.create(
      {
        connectionId: app.connectionId,
        database: app.database,
        scope: 'database',
        type: 'full',
        verify: true
      },
      {}
    )
    const job = await app.services.restore.toTempDatabase(
      { backupId: backup.id, projectId: null },
      'user'
    )
    if (job.tempDatabase) tempDatabases.push(job.tempDatabase)

    expect(job.mode).toBe('to_temp_database')
    expect(job.status).toBe('completed')
    expect(job.tempDatabase).toBeTruthy()
    expect(job.progress).toBe(100)
    expect(job.mayBePartial).toBe(false)
    expect(job.steps.some((s) => s.status === 'ok')).toBe(true)

    // Read the restored data back with an independent mysql2 connection.
    const restored = await openTestConnection(job.tempDatabase!)
    try {
      const [users] = await restored.query('SELECT COUNT(*) AS n FROM qa_bk_users')
      const [orders] = await restored.query('SELECT COUNT(*) AS n FROM qa_bk_orders')
      expect(Number((users as Array<{ n: number }>)[0].n)).toBe(4)
      expect(Number((orders as Array<{ n: number }>)[0].n)).toBe(6)
      const [views] = await restored.query(
        "SELECT COUNT(*) AS n FROM information_schema.views WHERE table_schema = DATABASE() AND table_name = 'qa_bk_view'"
      )
      expect(Number((views as Array<{ n: number }>)[0].n)).toBe(1)
    } finally {
      await restored.end().catch(() => {})
    }

    const fetched = app.services.restore.getJob(job.id)
    expect(fetched?.status).toBe('completed')
    expect(app.services.restore.listJobs({ limit: 10 }).total).toBeGreaterThanOrEqual(1)
  })

  it('retention sweep deletes unreferenced expired backups but keeps referenced ones', async () => {
    const original = app.services.settings.get()
    try {
      // 1) A backup referenced by a recovery point must never be deleted.
      //    A fractional retention gives a retentionUntil in the very near past.
      app.services.settings.update({ retentionDays: 0.00001 })
      await conn.query('CREATE TABLE qa_bk_dropme (id INT PRIMARY KEY) ENGINE=InnoDB')
      const plan = await app.services.execution.plan(
        {
          connectionId: app.connectionId,
          database: app.database,
          sql: 'DROP TABLE qa_bk_dropme'
        },
        'user'
      )
      expect(plan.recoveryPlan.strategy).toBe('full_backup')
      app.services.execution.approve(plan.planId, 'retention test')
      const execution = await app.services.execution.execute(
        { planId: plan.planId, confirmed: true },
        'user'
      )
      expect(execution.ok).toBe(true)
      const referencedBackupId = execution.backupId
      expect(referencedBackupId).toBeTruthy()

      // 2) A second backup with no references is expired and must be swept.
      const unreferenced = await app.services.backups.create(
        {
          connectionId: app.connectionId,
          database: app.database,
          scope: 'database',
          type: 'full',
          verify: true
        },
        {}
      )
      // Let the fractional retention window elapse.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      const sweep = await app.services.backups.retentionSweep()
      expect(sweep.skippedReferenced).toContain(referencedBackupId!)
      expect(sweep.deleted).toContain(unreferenced.id)
      expect(existsSync(unreferenced.filePath)).toBe(false)
      const after = app.services.backups.get(unreferenced.id)
      expect(after?.status).toBe('deleted')
      // Still referenced => file untouched.
      expect(existsSync(app.services.backups.get(referencedBackupId!)!.filePath)).toBe(true)
      expect(sweep.freedBytes).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(sweep.warnings)).toBe(true)
    } finally {
      app.services.settings.update({
        retentionDays: original.retentionDays,
        backupDir: original.backupDir
      })
      await conn.query('DROP TABLE IF EXISTS qa_bk_dropme').catch(() => {})
    }
  })
})
