/**
 * Type declarations for the portable MariaDB test harness (scripts/mariadb.mjs).
 * Keeping this next to the implementation lets `tsc` typecheck tests/helpers
 * without enabling `allowJs`.
 */

export interface MariaDbInfo {
  pid: number
  port: number
  host: string
  user: string
  password: string
  datadir: string
  socket: string | null
  version: string
  startedAt: string
  logPath?: string
  serverRoot?: string
  readyMs?: number
  reused?: boolean
}

export interface MariaDbStatus extends Partial<MariaDbInfo> {
  running: boolean
  pidAlive?: boolean
  tcpReachable?: boolean
  pingOk?: boolean
}

export interface MariaDbPaths {
  projectRoot: string
  testdataDir: string
  downloadDir: string
  serverRoot: string
  dataDir: string
  tmpDir: string
  logPath: string
  infoPath: string
}

export function getPaths(): MariaDbPaths

export function startServer(options?: { port?: number; forceRestart?: boolean }): Promise<MariaDbInfo>
export function stopServer(): Promise<{ stopped: boolean; reason?: string; pid?: number; port?: number | null }>
export function getInfo(): Promise<MariaDbStatus>
export function resetDatabase(): Promise<MariaDbInfo>
export function exec(sql: string, options?: { timeout?: number }): Promise<unknown>
export function createDatabase(name: string): Promise<string>
export function dropDatabase(name: string): Promise<void>
export function ensureBinaries(): Promise<unknown>
export function adminPing(port: number): Promise<boolean>

declare const api: {
  startServer: typeof startServer
  stopServer: typeof stopServer
  getInfo: typeof getInfo
  exec: typeof exec
  createDatabase: typeof createDatabase
  dropDatabase: typeof dropDatabase
  resetDatabase: typeof resetDatabase
  ensureBinaries: typeof ensureBinaries
  getPaths: typeof getPaths
  adminPing: typeof adminPing
}

export default api
