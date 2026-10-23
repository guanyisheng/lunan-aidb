import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Write JSON atomically (tmp file + rename) so a crash cannot corrupt state. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

export async function fileSize(file: string): Promise<number> {
  const st = await fs.stat(file)
  return st.size
}

export async function removeFile(file: string): Promise<void> {
  try {
    await fs.unlink(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

export async function removeDirRecursive(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

export async function freeDiskBytes(dir: string): Promise<number> {
  try {
    const st = await fs.statfs(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return -1
  }
}

export function joinInto(dir: string, ...parts: string[]): string {
  return join(dir, ...parts)
}

/** Windows-safe filename fragment (keeps unicode letters). */
export function safeFileFragment(name: string, maxLength = 60): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, maxLength)
  return cleaned || 'unnamed'
}
