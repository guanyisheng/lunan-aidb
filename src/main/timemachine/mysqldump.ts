/**
 * Optional mysqldump integration.
 *
 * mysqldump is treated as an *untrusted external tool*: availability and exit
 * code are checked, the produced file must be non-empty and end with the tool's
 * completion marker, and any failure falls back to the internal engine. A
 * command that prints something is never considered a successful backup.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, promises as fs } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { ConnectionCredential } from '@main/service-contracts'
import { AppError } from '@main/util/errors'
import { fileSize, pathExists } from '@main/util/fsx'

export interface DumpToolInfo {
  available: boolean
  path: string | null
  name: string | null
}

const CANDIDATE_NAMES = ['mysqldump', 'mysqldump.exe', 'mariadb-dump', 'mariadb-dump.exe']

/** Synchronous detection for BackupService.stats() (contract is sync). */
export function findDumpToolSync(): DumpToolInfo {
  const configured = process.env.AIDB_MYSQLDUMP_PATH?.trim()
  if (configured && existsSync(configured)) {
    return { available: true, path: configured, name: configured.split(/[\\/]/).pop() ?? configured }
  }
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    for (const name of CANDIDATE_NAMES) {
      const candidate = join(dir, name)
      try {
        if (existsSync(candidate)) {
          return { available: true, path: candidate, name }
        }
      } catch {
        /* ignore unreadable PATH entries */
      }
    }
  }
  return { available: false, path: null, name: null }
}

/** Async detection that also proves the binary can start (used by health checks). */
export async function probeDumpTool(timeoutMs = 4000): Promise<DumpToolInfo & { version?: string }> {
  const info = findDumpToolSync()
  if (!info.available || !info.path) return info
  try {
    const version = await runCapture(info.path, ['--version'], timeoutMs)
    return { ...info, version: version.trim().split(/\r?\n/)[0] }
  } catch {
    return { ...info, available: false }
  }
}

function runCapture(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`命令超时: ${bin}`))
    }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => {
      if (out.length < 64 * 1024) out += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < 64 * 1024) err += c.toString('utf8')
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${bin} 退出码 ${code}: ${err.slice(0, 500)}`))
    })
  })
}

export interface MysqldumpOptions {
  credential: ConnectionCredential
  database: string
  tables?: string[]
  bodyPath: string
  type?: 'full' | 'schema_only' | 'data_only'
  signal?: AbortSignal
  timeoutMs?: number
  redact?: (text: string) => string
}

export interface MysqldumpResult {
  toolPath: string
  toolName: string
  bytes: number
}

/**
 * Runs mysqldump into `bodyPath`. Password is passed through MYSQL_PWD so it
 * never appears in the child's argv (visible in process listings) or logs.
 */
export async function runMysqldump(options: MysqldumpOptions): Promise<MysqldumpResult> {
  const tool = findDumpToolSync()
  if (!tool.available || !tool.path) {
    throw new AppError('BACKUP_FAILED', 'mysqldump/mariadb-dump 不可用')
  }
  const { credential } = options
  const args = [
    `--host=${credential.host}`,
    `--port=${credential.port}`,
    `--user=${credential.user}`,
    '--protocol=TCP',
    '--default-character-set=utf8mb4',
    '--single-transaction',
    '--skip-lock-tables',
    '--routines',
    '--triggers',
    '--events',
    '--hex-blob',
    '--add-drop-table',
    '--add-drop-trigger',
    '--no-tablespaces'
  ]
  if ((options.type ?? 'full') === 'schema_only') args.push('--no-data')
  if ((options.type ?? 'full') === 'data_only') args.push('--no-create-info', '--skip-triggers')
  args.push(options.database)
  if (options.tables && options.tables.length > 0) args.push(...options.tables)

  const redact = options.redact ?? ((s: string) => s)
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
  await fs.mkdir(dirname(options.bodyPath), { recursive: true }).catch(() => undefined)

  return new Promise<MysqldumpResult>((resolve, reject) => {
    const out = createWriteStream(options.bodyPath)
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | null = null
    // Register the completion listeners BEFORE piping: the write stream may
    // finish before `close` fires, and attaching a listener afterwards would
    // hang forever.
    const outDone = new Promise<void>((res) => {
      out.once('finish', () => res())
      out.once('close', () => res())
      out.once('error', () => res())
    })
    const finish = (err: Error | null, result?: MysqldumpResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (err) {
        out.destroy()
        reject(err)
      } else if (result) {
        resolve(result)
      }
    }
    const child = spawn(tool.path as string, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MYSQL_PWD: credential.password }
    })
    timer = setTimeout(() => {
      child.kill()
      finish(new AppError('TIMEOUT', `mysqldump 超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)

    options.signal?.addEventListener('abort', () => {
      child.kill()
      finish(new AppError('CANCELLED', '备份已取消'))
    })

    child.stdout?.pipe(out)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })
    child.on('error', (e) => finish(toBackupError(e, redact)))
    child.on('close', (code) => {
      void (async () => {
        try {
          if (!out.writableEnded) out.end()
          await outDone
          if (code !== 0) {
            finish(
              new AppError('BACKUP_FAILED', `mysqldump 退出码 ${code}`, {
                details: { stderr: redact(stderr).slice(0, 2000) }
              })
            )
            return
          }
          if (!(await pathExists(options.bodyPath))) {
            finish(new AppError('BACKUP_FAILED', 'mysqldump 未生成文件'))
            return
          }
          const bytes = await fileSize(options.bodyPath)
          if (bytes <= 0) {
            finish(new AppError('BACKUP_FAILED', 'mysqldump 生成的文件为空'))
            return
          }
          // `-- Dump completed` is printed by mysqldump only after a clean finish.
          const tail = await readTailUtf8(options.bodyPath, 8192)
          if (!/Dump completed/i.test(tail)) {
            finish(
              new AppError('BACKUP_FAILED', 'mysqldump 输出尾部缺少完成标记（可能被截断）', {
                details: { tail: redact(tail.slice(-500)) }
              })
            )
            return
          }
          finish(null, {
            toolPath: tool.path as string,
            toolName: tool.name ?? 'mysqldump',
            bytes
          })
        } catch (e) {
          finish(toBackupError(e, redact))
        }
      })()
    })
  })
}

function toBackupError(e: unknown, redact: (s: string) => string): AppError {
  if (e instanceof AppError) return e
  const msg = e instanceof Error ? e.message : String(e)
  return new AppError('BACKUP_FAILED', redact(msg))
}

async function readTailUtf8(filePath: string, bytes: number): Promise<string> {
  const size = await fileSize(filePath)
  const fh = await fs.open(filePath, 'r')
  try {
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

