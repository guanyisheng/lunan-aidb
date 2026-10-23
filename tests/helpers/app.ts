/**
 * Full application wiring for integration tests.
 *
 * Each test suite gets its own throw-away user-data directory (SQLite store,
 * logs, backups) plus its own MariaDB database. The trusted service container
 * is constructed exactly like the Electron main process does, so tests exercise
 * the real store / connection manager / schema scanner / executor / time machine
 * instead of hand-built stubs.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServices, type ServicesBundle } from '@main/container'
import type { Services } from '@main/service-contracts'
import type { ConnectionSummary } from '@shared/types'
import {
  dropTestDatabase,
  ensureDatabase,
  ensureTestServer,
  makeDatabaseName,
  testdataDir
} from './mariadb'

export interface TestApp {
  services: Services
  store: ServicesBundle['store']
  /** Saved + connected MariaDB connection pointing at the portable test instance. */
  connection: ConnectionSummary
  connectionId: string
  database: string
  userDataDir: string
  backupDir: string
  dispose(): Promise<void>
}

export async function createTestApp(label = 'it'): Promise<TestApp> {
  const server = await ensureTestServer()
  const userDataDir = join(
    testdataDir(),
    'qa-run',
    `${label}-${Date.now()}-${randomBytes(3).toString('hex')}`
  )
  mkdirSync(userDataDir, { recursive: true })

  const database = makeDatabaseName(`qa_${label}`)
  await ensureDatabase(database)

  const bundle = await createServices({ userDataDir, safeStorage: null, logLevel: 'error' })
  let connection: ConnectionSummary
  try {
    connection = await bundle.services.connections.save({
      input: {
        name: `QA ${label}`,
        host: server.host,
        port: server.port,
        user: server.user,
        password: server.password,
        database,
        ssl: 'disabled',
        charset: 'utf8mb4',
        connectTimeoutMs: 8_000
      }
    })
    await bundle.services.connections.connect(connection.id)
  } catch (error) {
    await bundle.dispose().catch(() => {})
    await dropTestDatabase(database)
    rmSync(userDataDir, { recursive: true, force: true })
    throw error
  }

  const app: TestApp = {
    services: bundle.services,
    store: bundle.store,
    connection,
    connectionId: connection.id,
    database,
    userDataDir,
    backupDir: bundle.services.paths.backups,
    dispose: async () => {
      try {
        await bundle.dispose()
      } finally {
        await dropTestDatabase(database)
        rmSync(userDataDir, { recursive: true, force: true })
      }
    }
  }
  return app
}

/** Create an extra saved connection (not connected) for connection failure tests. */
export async function saveConnection(
  services: Services,
  name: string,
  overrides: { host?: string; port?: number; database?: string } = {}
): Promise<ConnectionSummary> {
  const server = await ensureTestServer()
  return services.connections.save({
    input: {
      name,
      host: overrides.host ?? server.host,
      port: overrides.port ?? server.port,
      user: server.user,
      password: server.password,
      database: overrides.database ?? '',
      ssl: 'disabled',
      charset: 'utf8mb4',
      connectTimeoutMs: 3_000
    }
  })
}
