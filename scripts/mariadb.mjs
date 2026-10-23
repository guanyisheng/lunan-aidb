#!/usr/bin/env node
/**
 * AIDB Studio - portable MariaDB test-instance harness.
 *
 * Downloads a *portable* MariaDB Windows x64 zip from the TUNA mirror into
 * `.testdata/downloads`, extracts it to `.testdata/mariadb`, initialises an
 * isolated datadir at `.testdata/mariadb-data`, starts `mysqld` on a random
 * free port bound to 127.0.0.1 with a password-less `root`, and tracks the
 * instance in `.testdata/mariadb.json`.
 *
 * It never installs a Windows service, never touches the system MySQL/MariaDB
 * installation, never writes outside the project `.testdata` directory and
 * never listens on anything but 127.0.0.1.
 *
 * CLI
 *   node scripts/mariadb.mjs start              # idempotent; reuses a running instance
 *   node scripts/mariadb.mjs stop               # graceful mysqladmin shutdown, then kill
 *   node scripts/mariadb.mjs status             # JSON status (running, pid, port, ...)
 *   node scripts/mariadb.mjs reset              # stop, delete datadir, re-init, start
 *   node scripts/mariadb.mjs exec -- <sql>      # run SQL against the test instance
 *
 * Importable API
 *   import { startServer, stopServer, getInfo, exec, createDatabase, resetDatabase } from './scripts/mariadb.mjs'
 *
 * Environment variables
 *   AIDB_MARIADB_BIN      Path to an existing MariaDB/MySQL *bin* directory.
 *                         Required on macOS/Linux (auto-download is Windows-only,
 *                         and that path is UNVERIFIED - see tests/README.md).
 *   AIDB_MARIADB_PORT     Fixed TCP port (default: a random free port).
 *   AIDB_MARIADB_VERSION  MariaDB version to download (default 11.4.13, LTS).
 *   AIDB_MARIADB_URL      Full download URL override (inside the mirror tree).
 *   AIDB_MARIADB_ARCHIVE  Use an already downloaded zip instead of downloading.
 *   AIDB_TESTDATA_DIR     Override the `.testdata` directory location.
 *
 * Safety: all child processes are spawned with argument arrays (no shell
 * string concatenation), so paths containing spaces or non-ASCII characters
 * (including the project's Chinese workspace path) are passed through safely.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ */
/* Paths / constants                                                   */
/* ------------------------------------------------------------------ */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''

const TESTDATA_DIR = path.resolve(
  process.env.AIDB_TESTDATA_DIR ? process.env.AIDB_TESTDATA_DIR : path.join(PROJECT_ROOT, '.testdata')
)
const DOWNLOAD_DIR = path.join(TESTDATA_DIR, 'downloads')
const EXTRACT_DIR = path.join(TESTDATA_DIR, 'mariadb')

/**
 * Datadir / logs must NOT live on filesystems that emit AppleDouble `._*`
 * sidecars (common on macOS external volumes under /Volumes/…). MariaDB then
 * exposes those files as fake tables named `#mysql50#._…` and metadata queries
 * fail with "Incorrect table name". Prefer an explicit override, else a local
 * tmp runtime dir on Darwin when the project itself sits on /Volumes.
 */
function resolveRuntimeDir() {
  if (process.env.AIDB_MARIADB_RUNTIME_DIR) {
    return path.resolve(process.env.AIDB_MARIADB_RUNTIME_DIR)
  }
  const onExternalVolume = PROJECT_ROOT.startsWith(`${path.sep}Volumes${path.sep}`)
  if (process.platform === 'darwin' && onExternalVolume) {
    return path.join(os.tmpdir(), 'aidb-studio-mariadb')
  }
  return TESTDATA_DIR
}

const RUNTIME_DIR = resolveRuntimeDir()
const DATA_DIR = path.join(RUNTIME_DIR, 'mariadb-data')
const TMP_DIR = path.join(RUNTIME_DIR, 'tmp')
const LOG_PATH = path.join(RUNTIME_DIR, 'mariadb.log')
const CONSOLE_LOG_PATH = path.join(RUNTIME_DIR, 'mariadb-console.log')
const INFO_PATH = path.join(RUNTIME_DIR, 'mariadb.json')
const INIT_MARKER = path.join(RUNTIME_DIR, '.mariadb-initialized')

const DEFAULT_VERSION = process.env.AIDB_MARIADB_VERSION || '11.4.13'
const MIRROR_BASE = 'https://mirrors.tuna.tsinghua.edu.cn/mariadb'
const DEFAULT_ARCHIVE_NAME = `mariadb-${DEFAULT_VERSION}-winx64.zip`
const DEFAULT_DOWNLOAD_URL =
  process.env.AIDB_MARIADB_URL ||
  `${MIRROR_BASE}/mariadb-${DEFAULT_VERSION}/winx64-packages/${DEFAULT_ARCHIVE_NAME}`

const READY_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 30_000

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(...args) {
  console.error('[mariadb]', ...args)
}

function existsSync(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function safeJson(value) {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === 'bigint') return val.toString()
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(val)) return val.toString('base64')
      return val
    },
    2
  )
}

/** Absolute paths used by this harness (handy for diagnostics / tests). */
export function getPaths() {
  return {
    projectRoot: PROJECT_ROOT,
    testdataDir: TESTDATA_DIR,
    runtimeDir: RUNTIME_DIR,
    downloadDir: DOWNLOAD_DIR,
    serverRoot: EXTRACT_DIR,
    dataDir: DATA_DIR,
    tmpDir: TMP_DIR,
    logPath: LOG_PATH,
    infoPath: INFO_PATH
  }
}

/* ------------------------------------------------------------------ */
/* Binary resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * Candidate "bin" directories for a pre-installed MariaDB/MySQL on macOS/Linux.
 * Prefer AIDB_MARIADB_BIN; otherwise probe Homebrew Cellar / opt layouts.
 * Never returns a Windows zip extract path — that remains EXTRACT_DIR/bin.
 */
function discoverSystemBinDir() {
  if (process.env.AIDB_MARIADB_BIN) return path.resolve(process.env.AIDB_MARIADB_BIN)

  const home = os.homedir()
  const prefixes = [
    '/opt/homebrew/opt',
    '/usr/local/opt',
    '/opt/homebrew',
    '/usr/local',
    '/opt/local',
    path.join(home, '.local')
  ]
  const formulae = [
    'mariadb@11.4',
    'mariadb@11.8',
    'mariadb@10.11',
    'mariadb',
    'mysql@8.4',
    'mysql@8.0',
    'mysql'
  ]
  const candidates = []
  for (const prefix of prefixes) {
    for (const formula of formulae) {
      candidates.push(path.join(prefix, formula, 'bin'))
    }
    candidates.push(path.join(prefix, 'bin'))
  }
  // Flat layouts (e.g. /usr/bin) are last-resort: only accept if mysqld + install-db exist.
  candidates.push('/usr/sbin', '/usr/bin', '/sbin', '/bin')

  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    const server = firstExisting([
      path.join(dir, `mysqld${EXE}`),
      path.join(dir, `mariadbd${EXE}`)
    ])
    const installDb = firstExisting([
      path.join(dir, `mariadb-install-db${EXE}`),
      path.join(dir, `mysql_install_db${EXE}`)
    ])
    const admin = firstExisting([
      path.join(dir, `mysqladmin${EXE}`),
      path.join(dir, `mariadb-admin${EXE}`)
    ])
    if (server && installDb && admin) return dir
  }
  return null
}

function binDir() {
  if (process.env.AIDB_MARIADB_BIN) return path.resolve(process.env.AIDB_MARIADB_BIN)
  const extracted = path.join(EXTRACT_DIR, 'bin')
  if (existsSync(path.join(extracted, `mysqld${EXE}`)) || existsSync(path.join(extracted, `mariadbd${EXE}`))) {
    return extracted
  }
  const system = discoverSystemBinDir()
  if (system) return system
  return extracted
}

function serverRoot() {
  return path.dirname(binDir())
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function resolveBinaries() {
  const dir = binDir()
  const find = (names) => firstExisting(names.map((name) => path.join(dir, name)))

  const server = find([`mysqld${EXE}`, `mariadbd${EXE}`])
  const installDb = find([`mariadb-install-db${EXE}`, `mysql_install_db${EXE}`])
  const admin = find([`mysqladmin${EXE}`, `mariadb-admin${EXE}`])
  const client = find([`mysql${EXE}`, `mariadb${EXE}`])
  const dump = find([`mysqldump${EXE}`, `mariadb-dump${EXE}`])

  return { dir, server, installDb, admin, client, dump }
}

function requireBinaries() {
  const bins = resolveBinaries()
  if (!bins.server || !bins.installDb || !bins.admin) {
    throw new Error(
      `MariaDB binaries not found in ${bins.dir}. ` +
        `Run "node scripts/mariadb.mjs start" on Windows to download them, ` +
        `or set AIDB_MARIADB_BIN to a directory containing mysqld/mariadb-install-db/mysqladmin.`
    )
  }
  return bins
}

/* ------------------------------------------------------------------ */
/* Download + extraction                                               */
/* ------------------------------------------------------------------ */

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error(`Too many redirects while downloading ${url}`))
      return
    }
    const tmp = `${dest}.part`
    const request = https.get(url, { headers: { 'User-Agent': 'aidb-studio-test-harness' } }, (res) => {
      const status = res.statusCode || 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        resolve(downloadFile(next, dest, redirects + 1))
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`Download failed: HTTP ${status} for ${url}`))
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      let lastPct = -10
      const out = fs.createWriteStream(tmp)
      res.on('data', (chunk) => {
        received += chunk.length
        if (total > 0) {
          const pct = Math.floor((received / total) * 100)
          if (pct >= lastPct + 10) {
            lastPct = pct
            log(`downloading ${path.basename(dest)}: ${pct}% (${(received / 1048576).toFixed(1)} MB)`)
          }
        }
      })
      res.on('error', (err) => {
        out.destroy()
        reject(err)
      })
      out.on('error', reject)
      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(tmp, dest)
          } catch (err) {
            reject(err)
            return
          }
          resolve(dest)
        })
      })
      res.pipe(out)
    })
    request.on('error', reject)
    request.setTimeout(120_000, () => {
      request.destroy(new Error('Download timed out after 120s of inactivity'))
    })
  })
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  // Windows 10+ ships bsdtar which understands .zip. Fall back to
  // PowerShell's Expand-Archive if unavailable.
  const tar = spawnSync('tar', ['-xf', zipPath, '-C', destDir], {
    windowsHide: true,
    encoding: 'utf8'
  })
  if (tar.status === 0) return
  if (IS_WIN) {
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        zipPath,
        destDir
      ],
      { windowsHide: true, encoding: 'utf8' }
    )
    if (ps.status === 0) return
    throw new Error(
      `Failed to extract ${zipPath}: tar=${tar.status} ${tar.stderr || ''} powershell=${ps.status} ${ps.stderr || ''}`
    )
  }
  const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { encoding: 'utf8' })
  if (unzip.status === 0) return
  throw new Error(`Failed to extract ${zipPath}: tar=${tar.status} unzip=${unzip.status} ${unzip.stderr || ''}`)
}

/** Ensure mysqld / mariadb-install-db / mysqladmin are resolvable. */
export async function ensureBinaries() {
  const bins = resolveBinaries()
  if (bins.server && bins.installDb && bins.admin) {
    if (!process.env.AIDB_MARIADB_BIN && bins.dir !== path.join(EXTRACT_DIR, 'bin')) {
      log(`using system MariaDB binaries at ${bins.dir}`)
    }
    return bins
  }

  if (process.env.AIDB_MARIADB_BIN) {
    // Explicitly configured, so do not silently download somewhere else.
    requireBinaries()
  }

  // macOS/Linux: prefer a discovered Homebrew/system install over a Windows-only zip.
  if (!IS_WIN) {
    const systemDir = discoverSystemBinDir()
    if (systemDir) {
      process.env.AIDB_MARIADB_BIN = systemDir
      const resolved = resolveBinaries()
      if (resolved.server && resolved.installDb && resolved.admin) {
        log(`using discovered MariaDB binaries at ${systemDir}`)
        return resolved
      }
    }
    throw new Error(
      'MariaDB binaries not found. On macOS install with `brew install mariadb` ' +
        '(or `brew install mariadb@11.4`) and re-run, or set AIDB_MARIADB_BIN to a ' +
        'directory containing mysqld/mariadbd, mariadb-install-db and mysqladmin. ' +
        'Automatic zip download remains Windows x64 only.'
    )
  }

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })

  let archive = process.env.AIDB_MARIADB_ARCHIVE ? path.resolve(process.env.AIDB_MARIADB_ARCHIVE) : null
  if (archive) {
    if (!existsSync(archive)) throw new Error(`AIDB_MARIADB_ARCHIVE does not exist: ${archive}`)
    log(`using local archive ${archive}`)
  } else {
    archive = path.join(DOWNLOAD_DIR, DEFAULT_ARCHIVE_NAME)
    if (!existsSync(archive) || fs.statSync(archive).size < 1024 * 1024) {
      log(`downloading MariaDB ${DEFAULT_VERSION} from TUNA mirror (${DEFAULT_DOWNLOAD_URL})`)
      await downloadFile(DEFAULT_DOWNLOAD_URL, archive)
      log(`downloaded ${archive} (${(fs.statSync(archive).size / 1048576).toFixed(1)} MB)`)
    } else {
      log(`using cached archive ${archive}`)
    }
  }

  const staging = path.join(TESTDATA_DIR, `.extract-${DEFAULT_VERSION}`)
  await fsp.rm(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  log('extracting archive...')
  extractZip(archive, staging)

  // The zip contains exactly one top-level directory `mariadb-<version>-winx64`.
  const entries = await fsp.readdir(staging, { withFileTypes: true })
  const topDir = entries.find((entry) => entry.isDirectory() && /^mariadb-/i.test(entry.name))
  const sourceRoot = topDir ? path.join(staging, topDir.name) : staging

  await fsp.rm(EXTRACT_DIR, { recursive: true, force: true })
  await fsp.rename(sourceRoot, EXTRACT_DIR)
  await fsp.rm(staging, { recursive: true, force: true })

  const resolved = resolveBinaries()
  if (!resolved.server || !resolved.installDb || !resolved.admin) {
    throw new Error(`Extraction produced no usable MariaDB binaries under ${EXTRACT_DIR}`)
  }
  log(`mariadb binaries ready at ${EXTRACT_DIR}`)
  return resolved
}

/* ------------------------------------------------------------------ */
/* Data directory init                                                 */
/* ------------------------------------------------------------------ */

function isDataDirInitialized() {
  // A datadir is only usable once the system `mysql` schema exists.
  return existsSync(path.join(DATA_DIR, 'mysql'))
}

async function ensureDataDir() {
  const bins = requireBinaries()
  if (isDataDirInitialized()) return

  log(`initialising datadir ${DATA_DIR}`)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  // Windows `mariadb-install-db.exe` is a tiny wrapper: only `--datadir` is
  // reliable. The Unix shell script (Homebrew / MariaDB4j) needs an explicit
  // `--basedir` so it finds `my_print_defaults` / `share/mysql` next to our
  // staged tree rather than a stale Cellar path baked into the script.
  const args = IS_WIN
    ? [`--datadir=${DATA_DIR}`]
    : [
        `--basedir=${serverRoot()}`,
        `--datadir=${DATA_DIR}`,
        '--auth-root-authentication-method=normal',
        '--skip-test-db'
      ]
  const result = spawnSync(bins.installDb, args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 180_000,
    cwd: serverRoot(),
    env: {
      ...process.env,
      // Ensure PATH prefers our staged bin (my_print_defaults, resolveip).
      PATH: `${bins.dir}${path.delimiter}${process.env.PATH || ''}`
    }
  })
  if (result.status !== 0) {
    throw new Error(
      `mariadb-install-db failed (exit ${result.status}).\n` +
        `stdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`
    )
  }
  fs.writeFileSync(INIT_MARKER, new Date().toISOString(), 'utf8')
  if (!isDataDirInitialized()) {
    throw new Error(`mariadb-install-db reported success but ${path.join(DATA_DIR, 'mysql')} is missing`)
  }
}

/* ------------------------------------------------------------------ */
/* Info file                                                           */
/* ------------------------------------------------------------------ */

function readInfoSync() {
  try {
    const raw = fs.readFileSync(INFO_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function writeInfo(info) {
  fs.mkdirSync(TESTDATA_DIR, { recursive: true })
  const tmp = `${INFO_PATH}.tmp`
  fs.writeFileSync(tmp, safeJson(info), 'utf8')
  fs.renameSync(tmp, INFO_PATH)
}

function removeInfo() {
  try {
    fs.rmSync(INFO_PATH, { force: true })
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Liveness probes                                                     */
/* ------------------------------------------------------------------ */

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

function tcpPing(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function runCapture(exe, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ ok: false, status: null, stdout, stderr: String(err), error: err })
      return
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve({ ok: false, status: null, stdout, stderr: stderr + '\n(timeout)', timedOut: true })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, status: null, stdout, stderr: String(err), error: err })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, status: code, stdout, stderr })
    })
  })
}

export async function adminPing(port) {
  const bins = resolveBinaries()
  if (!bins.admin || !port) return false
  const result = await runCapture(
    bins.admin,
    [
      '--no-defaults',
      '--protocol=tcp',
      '--host=127.0.0.1',
      `--port=${port}`,
      '--user=root',
      'ping'
    ],
    10_000
  )
  return result.ok && /alive/i.test(result.stdout)
}

/* ------------------------------------------------------------------ */
/* Port selection                                                      */
/* ------------------------------------------------------------------ */

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/* ------------------------------------------------------------------ */
/* Start / stop / status                                               */
/* ------------------------------------------------------------------ */

function tailLog(maxLines = 30) {
  const parts = []
  for (const file of [LOG_PATH, CONSOLE_LOG_PATH]) {
    try {
      const content = fs.readFileSync(file, 'utf8').trim()
      if (content) parts.push(`--- ${path.basename(file)} ---\n${content.split(/\r?\n/).slice(-maxLines).join('\n')}`)
    } catch {
      /* ignore */
    }
  }
  return parts.length > 0 ? parts.join('\n') : '(no log)'
}

async function waitForReady(port, child, timeoutMs = READY_TIMEOUT_MS) {
  const start = Date.now()
  let lastError = ''
  while (Date.now() - start < timeoutMs) {
    if (child && child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(
        `mysqld exited during startup (exit ${child.exitCode}). Log tail:\n${tailLog()}`
      )
    }
    if (await tcpPing(port, 750)) {
      if (await adminPing(port)) return Date.now() - start
      lastError = 'TCP open but mysqladmin ping failed'
    } else {
      lastError = 'TCP not reachable yet'
    }
    await sleep(500)
  }
  throw new Error(
    `MariaDB did not become ready within ${timeoutMs}ms (port ${port}, last probe: ${lastError}).\n` +
      `Log tail:\n${tailLog()}`
  )
}

async function detectServerVersion(port) {
  const bins = resolveBinaries()
  if (bins.client) {
    const result = await runCapture(
      bins.client,
      [
        '--no-defaults',
        '--protocol=tcp',
        '--host=127.0.0.1',
        `--port=${port}`,
        '--user=root',
        '--batch',
        '--skip-column-names',
        '-e',
        'SELECT VERSION()'
      ],
      15_000
    )
    if (result.ok) {
      const line = result.stdout.trim().split(/\r?\n/)[0]
      if (line) return line
    }
  }
  const version = spawnSync(bins.server, ['--version'], { windowsHide: true, encoding: 'utf8' })
  const match = /Ver\s+([0-9][^\s]*)/i.exec(`${version.stdout || ''}${version.stderr || ''}`)
  return match ? match[1] : `mariadb-${DEFAULT_VERSION}`
}

/**
 * Start the portable test MariaDB server (idempotent).
 * @returns {Promise<object>} the instance info also written to `.testdata/mariadb.json`
 */
export async function startServer(options = {}) {
  fs.mkdirSync(TESTDATA_DIR, { recursive: true })

  // 1. Reuse a tracked running instance.
  const previous = readInfoSync()
  if (!options.forceRestart && previous?.port && (await tcpPing(previous.port, 750))) {
    if (isPidAlive(previous.pid) && (await adminPing(previous.port))) {
      log(`reusing running instance pid=${previous.pid} port=${previous.port}`)
      return { ...previous, reused: true }
    }
  }
  if (previous) {
    // Stale metadata: clean it up but leave the datadir untouched.
    log('removing stale instance metadata')
    removeInfo()
  }

  // 2. Binaries + datadir.
  await ensureBinaries()
  const bins = requireBinaries()
  await ensureDataDir()

  // 3. Port selection (respect explicit env override).
  const envPort = Number(process.env.AIDB_MARIADB_PORT || options.port || 0)
  const port = envPort > 0 ? envPort : await findFreePort()

  // 4. Spawn mysqld with an argument array and redirect both stdio streams to
  //    a console log; mysqld additionally writes its own error log.
  //    `--no-defaults` must be first so no machine-wide my.ini is ever read.
  //    `--tmpdir` is pinned inside the project: on this machine InnoDB failed to
  //    create its temp files when it used the default %TEMP% location.
  fs.mkdirSync(TMP_DIR, { recursive: true })
  const consoleFd = fs.openSync(CONSOLE_LOG_PATH, 'a')
  fs.appendFileSync(CONSOLE_LOG_PATH, `\n===== ${new Date().toISOString()} starting mysqld on port ${port} =====\n`)
  const args = [
    '--no-defaults',
    `--basedir=${serverRoot()}`,
    `--datadir=${DATA_DIR}`,
    `--tmpdir=${TMP_DIR}`,
    `--log-error=${LOG_PATH}`,
    `--port=${port}`,
    '--bind-address=127.0.0.1',
    '--skip-networking=0',
    '--skip-name-resolve',
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_unicode_ci',
    '--innodb-buffer-pool-size=64M',
    `--pid-file=${path.join(TESTDATA_DIR, 'mariadb.pid')}`
  ]

  log(`starting ${bins.server} on 127.0.0.1:${port}`)
  // `detached: true` is required on Windows: the test server must outlive the
  // CLI process that launched it (and any job object owned by the caller).
  const child = spawn(bins.server, args, {
    windowsHide: true,
    detached: true,
    cwd: serverRoot(),
    stdio: ['ignore', consoleFd, consoleFd]
  })
  let earlyExit = null
  child.once('error', (err) => {
    earlyExit = err
  })
  child.once('exit', (code, signal) => {
    if (child.exitCode !== null) earlyExit = earlyExit || new Error(`mysqld exited (code=${code}, signal=${signal})`)
  })
  child.unref()
  fs.closeSync(consoleFd)

  try {
    if (earlyExit) throw earlyExit
    const readyMs = await waitForReady(port, child)
    const version = await detectServerVersion(port)
    const info = {
      pid: child.pid,
      port,
      host: '127.0.0.1',
      user: 'root',
      password: '',
      datadir: DATA_DIR,
      socket: null,
      version,
      startedAt: new Date().toISOString(),
      logPath: LOG_PATH,
      serverRoot: serverRoot(),
      readyMs
    }
    writeInfo(info)
    log(`ready in ${readyMs}ms: ${version} on 127.0.0.1:${port} (pid ${child.pid})`)
    return info
  } catch (err) {
    // Startup failed: do not leave an orphan process behind.
    if (child.pid && isPidAlive(child.pid)) {
      await killPid(child.pid)
    }
    throw err
  }
}

async function killPid(pid) {
  if (!pid) return
  if (IS_WIN) {
    await runCapture('taskkill', ['/PID', String(pid), '/T', '/F'], 15_000)
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

async function waitForExit(pid, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true
    await sleep(250)
  }
  return !isPidAlive(pid)
}

/** Stop the tracked test instance (graceful shutdown, then force-kill on timeout). */
export async function stopServer() {
  const info = readInfoSync()
  if (!info?.pid) {
    return { stopped: false, reason: 'no tracked instance' }
  }
  const pidAlive = isPidAlive(info.pid)
  const bins = resolveBinaries()

  if (pidAlive) {
    log(`stopping pid=${info.pid} via mysqladmin shutdown`)
    if (bins.admin && info.port) {
      const result = await runCapture(
        bins.admin,
        [
          '--no-defaults',
          '--protocol=tcp',
          '--host=127.0.0.1',
          `--port=${info.port}`,
          '--user=root',
          'shutdown'
        ],
        20_000
      )
      if (!result.ok) log(`mysqladmin shutdown returned ${result.status}: ${(result.stderr || '').trim()}`)
    } else {
      log('mysqladmin not available; skipping graceful shutdown')
    }

    if (!(await waitForExit(info.pid, SHUTDOWN_TIMEOUT_MS))) {
      log(`pid=${info.pid} still alive after ${SHUTDOWN_TIMEOUT_MS}ms; force-killing`)
      await killPid(info.pid)
      if (!(await waitForExit(info.pid, 10_000))) {
        throw new Error(`Failed to stop MariaDB process ${info.pid}`)
      }
    }
  }

  removeInfo()
  return { stopped: true, pid: info.pid, port: info.port ?? null }
}

/** Current status; `running` requires a live pid *and* a responsive server. */
export async function getInfo() {
  const info = readInfoSync()
  if (!info) return { running: false }
  const pidAlive = isPidAlive(info.pid)
  const tcpOk = pidAlive && info.port ? await tcpPing(info.port, 750) : false
  const pingOk = tcpOk ? await adminPing(info.port) : false
  const running = pidAlive && tcpOk && pingOk
  return {
    ...info,
    running,
    pidAlive,
    tcpReachable: tcpOk,
    pingOk
  }
}

/** Stop, delete the datadir, re-initialise and start a fresh instance. */
export async function resetDatabase() {
  await stopServer()
  log(`resetting datadir ${DATA_DIR}`)
  await fsp.rm(DATA_DIR, { recursive: true, force: true })
  try {
    await fsp.rm(INIT_MARKER, { force: true })
  } catch {
    /* ignore */
  }
  await ensureBinaries()
  await ensureDataDir()
  return startServer()
}

/* ------------------------------------------------------------------ */
/* SQL execution                                                       */
/* ------------------------------------------------------------------ */

let mysqlModulePromise = null

async function loadMysql() {
  if (!mysqlModulePromise) mysqlModulePromise = import('mysql2/promise')
  return mysqlModulePromise
}

async function openConnection(overrides = {}) {
  const info = readInfoSync()
  if (!info?.port) throw new Error('MariaDB test instance is not running; run "node scripts/mariadb.mjs start" first.')
  const mysql = await loadMysql()
  return mysql.createConnection({
    host: '127.0.0.1',
    port: info.port,
    user: 'root',
    password: '',
    charset: 'utf8mb4',
    multipleStatements: true,
    connectTimeout: overrides.connectTimeout ?? 5_000,
    ...overrides
  })
}

/**
 * Execute one or more SQL statements against the test instance.
 * @param {string} sql
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<unknown>} raw mysql2 result (array of result sets for multi-statement SQL)
 */
export async function exec(sql, options = {}) {
  if (typeof sql !== 'string' || sql.trim() === '') throw new Error('exec(sql): sql must be a non-empty string')
  const connection = await openConnection()
  try {
    const [rows] = await connection.query({ sql, timeout: options.timeout ?? 60_000 })
    return rows
  } finally {
    await connection.end().catch(() => {})
  }
}

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/

/**
 * Create a test database with utf8mb4 defaults (idempotent).
 * Database names are restricted to safe identifiers to avoid injection.
 */
export async function createDatabase(name) {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `createDatabase(name): unsafe database name ${JSON.stringify(name)} (expected /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/)`
    )
  }
  await exec(
    `CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  )
  return name
}

/** Drop a test database (used by reset/cleanup helpers). */
export async function dropDatabase(name) {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`dropDatabase(name): unsafe database name ${JSON.stringify(name)}`)
  }
  await exec(`DROP DATABASE IF EXISTS \`${name}\``)
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function parseSqlArg(argv) {
  const separator = argv.indexOf('--')
  const parts = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1)
  return parts.join(' ')
}

async function main(argv) {
  const command = argv[0]
  switch (command) {
    case 'start': {
      const info = await startServer()
      console.log(safeJson(info))
      return 0
    }
    case 'stop': {
      const result = await stopServer()
      console.log(safeJson(result))
      return 0
    }
    case 'status': {
      const info = await getInfo()
      console.log(safeJson(info))
      return info.running ? 0 : 3
    }
    case 'reset': {
      const info = await resetDatabase()
      console.log(safeJson(info))
      return 0
    }
    case 'exec': {
      const sql = parseSqlArg(argv)
      if (!sql.trim()) {
        throw new Error('exec requires SQL: node scripts/mariadb.mjs exec -- "SELECT 1"')
      }
      const result = await exec(sql)
      console.log(safeJson(result))
      return 0
    }
    case 'help':
    case '--help':
    case '-h':
    case undefined: {
      console.log(
        [
          'Usage: node scripts/mariadb.mjs <command>',
          '',
          'Commands:',
          '  start                 start (or reuse) the portable test MariaDB instance',
          '  stop                  graceful shutdown, force-kill after timeout',
          '  status                print instance JSON; exit 3 when not running',
          '  reset                 stop, wipe datadir, re-initialise, start',
          '  exec -- <sql>         execute SQL against the running instance',
          '',
          'Environment: AIDB_MARIADB_BIN, AIDB_MARIADB_PORT, AIDB_MARIADB_VERSION,',
          '             AIDB_MARIADB_URL, AIDB_MARIADB_ARCHIVE, AIDB_TESTDATA_DIR'
        ].join('\n')
      )
      return 0
    }
    default:
      throw new Error(`Unknown command ${JSON.stringify(command)}. Try "node scripts/mariadb.mjs help".`)
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error(`[mariadb] ERROR: ${err?.stack || err}`)
      process.exitCode = 1
    })
}

export default {
  startServer,
  stopServer,
  getInfo,
  exec,
  createDatabase,
  dropDatabase,
  resetDatabase,
  ensureBinaries,
  getPaths,
  adminPing
}
