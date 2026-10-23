/**
 * Chapter 8 test #1: MySQL/MariaDB connection and disconnect/reconnect.
 *
 * Runs against the real portable MariaDB 11.4 instance on 127.0.0.1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestApp } from '../helpers/app'
import { createTestApp, saveConnection } from '../helpers/app'
import { isServerAvailable, openTestConnection } from '../helpers/mariadb'
import { AppError } from '@main/util/errors'

const available = await isServerAvailable()

describe.skipIf(!available)('integration: connection lifecycle', () => {
  let app: TestApp

  beforeAll(async () => {
    app = await createTestApp('conn')
  }, 240_000)

  afterAll(async () => {
    // The shared portable instance is intentionally left running: other suites
    // and teammates rely on it. Only our own database/session is disposed.
    await app?.dispose()
  }, 240_000)

  it('connects and reports the real server version/flavor', async () => {
    const status = await app.services.connections.status(app.connectionId)
    expect(status.state).toBe('connected')
    expect(status.serverVersion).toMatch(/11\.4\./)
    expect(status.serverFlavor).toBe('mariadb')
    expect(status.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('lists databases and includes the dedicated test database', async () => {
    const databases = await app.services.connections.listDatabases(app.connectionId)
    const names = databases.map((d) => d.name)
    expect(names).toContain(app.database)
    expect(names).toContain('information_schema')
    expect(databases.every((d) => typeof d.name === 'string' && d.name.length > 0)).toBe(true)
  })

  it('opens a session and executes real queries', async () => {
    const session = await app.services.connections.openSession(app.connectionId)
    const result = await session.rawQuery<{ one: number; db: string }>(
      'SELECT 1 AS one, DATABASE() AS db'
    )
    expect(result.rows[0].one).toBe(1)
    expect(result.rows[0].db).toBe(app.database)
    expect(session.serverFlavor).toBe('mariadb')
  })

  it('reconnects after an explicit disconnect', async () => {
    await app.services.connections.disconnect(app.connectionId)
    const disconnected = await app.services.connections.status(app.connectionId)
    expect(disconnected.state).toBe('disconnected')

    const session = await app.services.connections.openSession(app.connectionId)
    const result = await session.rawQuery<{ one: number }>('SELECT 1 AS one')
    expect(result.rows[0].one).toBe(1)
    expect((await app.services.connections.status(app.connectionId)).state).toBe('connected')
  })

  it('fails with CONNECTION_FAILED when the port is closed (and records lastState=error)', async () => {
    const bad = await saveConnection(app.services, 'qa-closed-port', { port: 1, database: '' })
    await expect(app.services.connections.connect(bad.id)).rejects.toMatchObject({
      code: 'CONNECTION_FAILED'
    })
    const status = await app.services.connections.status(bad.id)
    expect(status.state).toBe('error')
    await app.services.connections.remove(bad.id)
  })

  it('recovers after the server kills the pooled connection', async () => {
    const server = await import('../helpers/mariadb').then((m) => m.ensureTestServer())
    const session = await app.services.connections.openSession(app.connectionId)
    const idRow = await session.rawQuery<{ id: number }>('SELECT CONNECTION_ID() AS id')
    const killedId = idRow.rows[0].id

    // Kill it from an independent admin connection: this is what a network drop
    // or an admin KILL looks like to the app's pool.
    const admin = await openTestConnection()
    try {
      await admin.query(`KILL ${Number(killedId)}`)
    } finally {
      await admin.end().catch(() => {})
    }

    // The manager's ping() path must rebuild the pool instead of staying broken.
    // `ping` is implemented by MySqlConnectionManager but is not part of the
    // ConnectionManager interface, so narrow the concrete type here.
    const manager = app.services.connections as typeof app.services.connections & {
      ping(id: string): Promise<void>
    }
    await manager.ping(app.connectionId)
    const fresh = await app.services.connections.openSession(app.connectionId)
    const result = await fresh.rawQuery<{ one: number }>('SELECT 1 AS one')
    expect(result.rows[0].one).toBe(1)
    expect((await app.services.connections.status(app.connectionId)).state).toBe('connected')
    expect(server.port).toBeGreaterThan(0)
  })

  it('rejects an incorrect database name with a mapped AppError', async () => {
    await expect(
      app.services.connections.openSession(app.connectionId, 'qa_database_that_does_not_exist')
    ).rejects.toBeInstanceOf(AppError)
  })
})
