/**
 * MariaDB test-instance helpers.
 *
 * These helpers talk to the *real* portable MariaDB instance managed by
 * `scripts/mariadb.mjs`. They never mock the database: integration tests must
 * exercise actual SQL, actual schemas and actual failure modes.
 *
 * Usage:
 *   const ctx = await withTestDatabase('schema')   // unique, auto-dropped
 *   const conn = await openTestConnection()        // ad-hoc mysql2 connection
 *
 * The instance is started lazily (idempotent) the first time a helper needs it.
 * If the machine cannot run MariaDB the integration suites skip themselves via
 * `describe.skipIf(!(await isServerAvailable()))`.
 */
import { randomBytes } from 'node:crypto'
import mysql from 'mysql2/promise'
import type { ConnectionOptions } from 'mysql2/promise'
import {
  createDatabase as harnessCreateDatabase,
  dropDatabase as harnessDropDatabase,
  exec as harnessExec,
  getInfo,
  getPaths,
  startServer,
  type MariaDbInfo,
  type MariaDbStatus
} from '../../scripts/mariadb.mjs'

export type { MariaDbInfo, MariaDbStatus }

/** Re-exported so suites can start/stop the instance explicitly (beforeAll/afterAll). */
export { startServer, stopServer } from '../../scripts/mariadb.mjs'

export interface TestServerConfig {
  host: string
  port: number
  user: string
  password: string
  version: string
}

let startPromise: Promise<TestServerConfig> | null = null

/** Start (idempotently) and return the connection parameters of the test server. */
export async function ensureTestServer(): Promise<TestServerConfig> {
  if (!startPromise) {
    startPromise = (async () => {
      const info = await startServer()
      return { host: '127.0.0.1', port: info.port, user: info.user, password: info.password, version: info.version }
    })().catch((error) => {
      startPromise = null
      throw error
    })
  }
  try {
    return await startPromise
  } catch (error) {
    // A previously started instance may have died; retry once with a fresh start.
    startPromise = null
    const info = await startServer()
    return { host: '127.0.0.1', port: info.port, user: info.user, password: info.password, version: info.version }
  }
}

/** True when a MariaDB test instance is available (running or startable). */
export async function isServerAvailable(): Promise<boolean> {
  try {
    const status = await getInfo()
    if (status.running) return true
    await ensureTestServer()
    return true
  } catch (error) {
    console.warn('[tests] MariaDB test instance unavailable:', error instanceof Error ? error.message : error)
    return false
  }
}

/** Current instance info without forcing a start. */
export async function serverInfo(): Promise<MariaDbStatus> {
  return getInfo()
}

/** mysql2 connection options for the test server. */
export async function sqlConfig(overrides: Partial<ConnectionOptions> = {}): Promise<ConnectionOptions> {
  const server = await ensureTestServer()
  return {
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
    charset: 'utf8mb4',
    multipleStatements: false,
    connectTimeout: 10_000,
    ...overrides
  }
}

/** Open a mysql2 connection (caller must close it). */
export async function openTestConnection(
  database?: string,
  overrides: Partial<ConnectionOptions> = {}
): Promise<mysql.Connection> {
  const config = await sqlConfig({ ...overrides, ...(database ? { database } : {}) })
  return mysql.createConnection(config)
}

/** Path to the portable server's `bin` directory (mysqldump, mysql, ...). */
export function serverBinDir(): string {
  return `${getPaths().serverRoot}/bin`
}

export function testdataDir(): string {
  return getPaths().testdataDir
}

/** Quote a MySQL identifier with backticks (safe for test-supplied names). */
export function quoteIdent(name: string): string {
  if (!/^[A-Za-z0-9_$]+$/.test(name)) throw new Error(`Unsafe identifier for test helper: ${name}`)
  return `\`${name}\``
}

/**
 * Generate a collision-free, filesystem/identifier-safe database name.
 * MariaDB identifiers are limited to 64 characters.
 */
export function makeDatabaseName(prefix = 'aidb_it'): string {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 20)
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const suffix = randomBytes(3).toString('hex')
  return `${safePrefix}_${stamp}_${suffix}`.slice(0, 64)
}

/** Create (dropping first) a database and return its name. */
export async function createTestDatabase(prefix = 'aidb_it'): Promise<string> {
  await ensureTestServer()
  const name = makeDatabaseName(prefix)
  await ensureDatabase(name)
  return name
}

/** Create a database if it does not exist. */
export async function ensureDatabase(name: string): Promise<void> {
  await ensureTestServer()
  await harnessCreateDatabase(name)
}

/** Drop a test database. Safe to call on a non-existent database. */
export async function dropTestDatabase(name: string): Promise<void> {
  try {
    await harnessDropDatabase(name)
  } catch (error) {
    console.warn(`[tests] failed to drop database ${name}:`, error instanceof Error ? error.message : error)
  }
}

/** Execute SQL against the test server via the harness (root, no default db). */
export async function execSql(sql: string, database?: string): Promise<unknown> {
  await ensureTestServer()
  if (database) {
    return harnessExec(`USE ${quoteIdent(database)}; ${sql}`)
  }
  return harnessExec(sql)
}

export interface TestDatabaseContext {
  database: string
  connection: mysql.Connection
  /** Re-open a fresh connection to the same database (e.g. after a forced disconnect). */
  reopen(): Promise<mysql.Connection>
}

/**
 * Create a throw-away database plus a mysql2 connection, run `fn`, then drop the
 * database and close the connection. The database is always dropped, even when
 * the callback throws.
 */
export async function withTestDatabase<T>(
  label: string,
  fn: (ctx: TestDatabaseContext) => Promise<T>
): Promise<T> {
  const database = await createTestDatabase(label)
  let connection = await openTestConnection(database)
  const ctx: TestDatabaseContext = {
    database,
    get connection() {
      return connection
    },
    reopen: async () => {
      await connection.end().catch(() => {})
      connection = await openTestConnection(database)
      return connection
    }
  }
  try {
    return await fn(ctx)
  } finally {
    await connection.end().catch(() => {})
    await dropTestDatabase(database)
  }
}
