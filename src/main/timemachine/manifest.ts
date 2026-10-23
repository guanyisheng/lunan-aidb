/**
 * Backup file format + independent verification.
 *
 * File layout (internal engine):
 *   -- AIDB-BACKUP v1
 *   -- AIDB-META {json manifest}
 *   SET NAMES / SET FOREIGN_KEY_CHECKS=0 ...
 *   ... SQL statements ...
 *   -- AIDB-END
 *
 * Verification never trusts the manifest: table and row counts are recomputed
 * from the actual file contents and compared with the manifest and the stored
 * checksum. This is what makes `status='verified'` meaningful.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ensureDir, fileSize, pathExists, sha256File } from '@main/util/fsx'
import {
  BACKUP_END,
  BACKUP_FORMAT_VERSION,
  BACKUP_HEADER,
  BACKUP_META_PREFIX,
  type BackupManifestV1
} from './internal-types'
import { SqlStatementSplitter } from './sqlfile'

export interface ManifestParseResult {
  manifest: BackupManifestV1 | null
  issues: string[]
}

/** Reads the header block (first ~64KiB) and parses the embedded manifest. */
export async function readBackupManifest(filePath: string): Promise<ManifestParseResult> {
  const issues: string[] = []
  if (!(await pathExists(filePath))) {
    return { manifest: null, issues: ['备份文件不存在'] }
  }
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(128 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const head = buf.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')
    const lines = head.split(/\r?\n/)
    if ((lines[0] ?? '').trim() !== BACKUP_HEADER) {
      issues.push(`缺少头部标记 ${BACKUP_HEADER}`)
      return { manifest: null, issues }
    }
    const metaLine = lines.find((l) => l.startsWith(BACKUP_META_PREFIX))
    if (!metaLine) {
      issues.push('缺少 AIDB-META 元数据行')
      return { manifest: null, issues }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(metaLine.slice(BACKUP_META_PREFIX.length))
    } catch {
      issues.push('AIDB-META 不是合法 JSON')
      return { manifest: null, issues }
    }
    const manifest = normalizeManifest(parsed)
    if (!manifest) {
      issues.push('AIDB-META 字段缺失或版本不受支持')
      return { manifest: null, issues }
    }
    return { manifest, issues }
  } finally {
    await fh.close()
  }
}

function normalizeManifest(value: unknown): BackupManifestV1 | null {
  if (!value || typeof value !== 'object') return null
  const m = value as Partial<BackupManifestV1>
  if (m.version !== BACKUP_FORMAT_VERSION || m.format !== 'aidb-backup') return null
  if (typeof m.database !== 'string' || !m.database) return null
  if (!Array.isArray(m.tables) || !Array.isArray(m.objects)) return null
  if (!m.rowCounts || typeof m.rowCounts !== 'object') return null
  return {
    ...m,
    views: Array.isArray(m.views) ? m.views : [],
    countedRows: m.countedRows && typeof m.countedRows === 'object' ? m.countedRows : {},
    totalRows: typeof m.totalRows === 'number' ? m.totalRows : 0,
    warnings: Array.isArray(m.warnings) ? m.warnings : [],
    schemaHash: typeof m.schemaHash === 'string' ? m.schemaHash : '',
    serverVersion: typeof m.serverVersion === 'string' ? m.serverVersion : '',
    serverFlavor: m.serverFlavor ?? 'unknown',
    charset: typeof m.charset === 'string' ? m.charset : 'utf8mb4',
    type: m.type ?? 'full',
    scope: m.scope ?? 'database',
    tool: m.tool ?? 'internal',
    startedAt: typeof m.startedAt === 'string' ? m.startedAt : '',
    finishedAt: typeof m.finishedAt === 'string' ? m.finishedAt : '',
    dumper: typeof m.dumper === 'string' ? m.dumper : 'aidb-internal'
  } as BackupManifestV1
}

export function buildBackupHeader(manifest: BackupManifestV1): string {
  return `${BACKUP_HEADER}\n${BACKUP_META_PREFIX}${JSON.stringify(manifest)}\n`
}

/** Reads the last bytes of a file to confirm the EOF marker is present. */
export async function readTail(filePath: string, bytes = 4096): Promise<string> {
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

export async function hasValidFooter(filePath: string): Promise<boolean> {
  if (!(await pathExists(filePath))) return false
  const tail = await readTail(filePath)
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] === BACKUP_END
}

export async function writeChecksumSidecar(filePath: string, checksum: string): Promise<void> {
  await fs.writeFile(`${filePath}.sha256`, `${checksum}  ${filePath.split(/[\\/]/).pop() ?? ''}\n`, 'utf8')
}

export async function readChecksumSidecar(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(`${filePath}.sha256`, 'utf8')
    const m = /^([0-9a-f]{64})/i.exec(raw.trim())
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Assembles the final `.sql` file: header + dumped body + EOF marker.
 * Checksum is computed over the finished file, so restoring a modified dump is
 * detected even when the manifest itself was not touched.
 */
export async function writeBackupFile(
  filePath: string,
  manifest: BackupManifestV1,
  bodyPath: string
): Promise<{ checksumSha256: string; fileSize: number }> {
  await ensureDir(dirname(filePath))
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, buildBackupHeader(manifest), 'utf8')
  await pipeline(createReadStream(bodyPath), createWriteStream(tmp, { flags: 'a' }))
  await fs.appendFile(tmp, `${BACKUP_END}\n`, 'utf8')
  const checksum = await sha256File(tmp)
  const size = await fileSize(tmp)
  await fs.rename(tmp, filePath)
  await writeChecksumSidecar(filePath, checksum)
  return { checksumSha256: checksum, fileSize: size }
}

/* ------------------------------------------------------------------ */
/* Content scanning                                                    */
/* ------------------------------------------------------------------ */

export interface DumpScanResult {
  createTableCount: number
  createViewCount: number
  insertStatements: number
  /** Rows counted per table from INSERT value tuples (schema.table => count). */
  rowCountsByTable: Record<string, number>
  tableNames: string[]
  viewNames: string[]
  bytesScanned: number
  /** CREATE TABLE name => statement body (used for schema hashing). */
  createStatements: Record<string, string>
}

interface InsertInfo {
  table: string
  rowCount: number
}

function unquoteIdent(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).replace(/``/g, '`')
  }
  return trimmed
}

function parseInsert(stmt: string): InsertInfo | null {
  const re = /^\s*(?:INSERT|REPLACE)\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+|IGNORE\s+)*INTO\s+(?:`(?:[^`]|``)+`|[\w$]+)(?:\s*\.\s*(?:`(?:[^`]|``)+`|[\w$]+))?/i
  const m = re.exec(stmt)
  if (!m) return null
  const tablePart = m[0]
    .replace(/^\s*(?:INSERT|REPLACE)[\s\S]*?INTO\s+/i, '')
    .trim()
  const parts = splitQualified(tablePart)
  const table = unquoteIdent(parts[parts.length - 1])
  const rowCount = countValueTuples(stmt, m[0].length)
  return { table, rowCount }
}

function splitQualified(text: string): string[] {
  const parts: string[] = []
  let cur = ''
  let inBacktick = false
  for (const ch of text) {
    if (ch === '`') {
      inBacktick = !inBacktick
      cur += ch
      continue
    }
    if (ch === '.' && !inBacktick) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

/** Counts `(...)` value tuples of an INSERT starting after the table clause. */
export function countValueTuples(stmt: string, searchFrom = 0): number {
  const valuesMatch = /\bVALUES?\b/i.exec(stmt.slice(searchFrom))
  if (!valuesMatch) return 0
  let i = searchFrom + valuesMatch.index + valuesMatch[0].length
  let depth = 0
  let inQuote: string | null = null
  let count = 0
  let onDuplicateDepth = -1
  for (; i < stmt.length; i += 1) {
    const ch = stmt[i]
    if (inQuote) {
      if (ch === '\\' && inQuote !== '`') {
        i += 1
        continue
      }
      if (ch === inQuote) {
        if (stmt[i + 1] === inQuote) {
          i += 1
          continue
        }
        inQuote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inQuote = ch
      continue
    }
    if (ch === '(') {
      if (depth === 0) count += 1
      depth += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && (ch === 'O' || ch === 'o')) {
      if (/^ON\s+DUPLICATE\b/i.test(stmt.slice(i))) {
        onDuplicateDepth = i
        break
      }
    }
  }
  if (onDuplicateDepth >= 0) {
    // rows already counted; ON DUPLICATE KEY UPDATE adds no tuples
  }
  return count
}

function parseCreateTable(stmt: string): string | null {
  const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:`(?:[^`]|``)+`|[\w$]+)(?:\s*\.\s*(?:`(?:[^`]|``)+`|[\w$]+))?)/i.exec(stmt)
  if (!m) return null
  const parts = splitQualified(m[1])
  return unquoteIdent(parts[parts.length - 1])
}

function parseCreateView(stmt: string): string | null {
  const m = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM\s*=\s*\S+\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\S+\s+)?VIEW\s+((?:`(?:[^`]|``)+`|[\w$]+)(?:\s*\.\s*(?:`(?:[^`]|``)+`|[\w$]+))?)/i.exec(stmt)
  if (!m) return null
  const parts = splitQualified(m[1])
  return unquoteIdent(parts[parts.length - 1])
}

/**
 * Streams a dump file once and derives structure + row counts from the SQL
 * itself. This is intentionally independent of the manifest.
 */
export async function scanDumpFile(filePath: string): Promise<DumpScanResult> {
  const result: DumpScanResult = {
    createTableCount: 0,
    createViewCount: 0,
    insertStatements: 0,
    rowCountsByTable: {},
    tableNames: [],
    viewNames: [],
    bytesScanned: 0,
    createStatements: {}
  }
  const splitter = new SqlStatementSplitter()
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 })
  let bytes = 0
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk as string)
    const statements = splitter.feed(chunk as string)
    for (const stmt of statements) {
      // mysqldump wraps VIEW/TRIGGER/RULE DDL in executable comments
      // (`/*!50001 CREATE ... */`), which the server executes. Strip the
      // wrapper only for classification; the original text is still executed.
      const classify = stripExecutableComment(stmt)
      if (/^\s*CREATE\s+TABLE/i.test(classify)) {
        const table = parseCreateTable(classify)
        if (table) {
          result.createTableCount += 1
          result.tableNames.push(table)
          result.createStatements[table] = classify
        }
        continue
      }
      if (/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:ALGORITHM|DEFINER|SQL|VIEW)/i.test(classify)) {
        const view = parseCreateView(classify)
        if (view) {
          result.createViewCount += 1
          result.viewNames.push(view)
          result.createStatements[view] = classify
        }
        continue
      }
      if (/^\s*(?:INSERT|REPLACE)\s/i.test(classify)) {
        const info = parseInsert(classify)
        if (info) {
          result.insertStatements += 1
          result.rowCountsByTable[info.table] = (result.rowCountsByTable[info.table] ?? 0) + info.rowCount
        }
      }
    }
  }
  result.bytesScanned = bytes
  return result
}

/** Hashes the schema portion (CREATE statements) for stable comparisons. */
export function hashCreateStatements(createStatements: Record<string, string>): string {
  const hash = createHash('sha256')
  for (const name of Object.keys(createStatements).sort()) {
    hash.update(name)
    hash.update('\u0000')
    hash.update(createStatements[name].replace(/\s+/g, ' ').trim())
    hash.update('\u0000')
  }
  return hash.digest('hex')
}

/* ------------------------------------------------------------------ */
/* Full verification of a backup file                                  */
/* ------------------------------------------------------------------ */

export interface BackupInspection {
  fileExists: boolean
  nonEmpty: boolean
  fileSize: number
  checksumOk: boolean | null
  structureOk: boolean
  tableCount: number | null
  viewCount: number | null
  totalInsertRows: number
  rowDataPresent: boolean
  rowCounts: Record<string, number>
  manifest: BackupManifestV1 | null
  notes: string[]
}

export async function inspectBackupFile(
  filePath: string,
  expectedChecksum?: string | null
): Promise<BackupInspection> {
  const notes: string[] = []
  const exists = await pathExists(filePath)
  if (!exists) {
    return {
      fileExists: false,
      nonEmpty: false,
      fileSize: 0,
      checksumOk: null,
      structureOk: false,
      tableCount: null,
      viewCount: null,
      totalInsertRows: 0,
      rowDataPresent: false,
      rowCounts: {},
      manifest: null,
      notes: ['备份文件不存在']
    }
  }
  const size = await fileSize(filePath)
  const nonEmpty = size > 0
  if (!nonEmpty) notes.push('备份文件为空')

  const { manifest, issues } = await readBackupManifest(filePath)
  notes.push(...issues)

  let checksumOk: boolean | null = null
  if (expectedChecksum) {
    const actual = await sha256File(filePath)
    checksumOk = actual.toLowerCase() === expectedChecksum.toLowerCase()
    if (!checksumOk) notes.push('sha256 校验和不一致')
    else notes.push('sha256 校验和一致')
  } else {
    const sidecar = await readChecksumSidecar(filePath)
    if (sidecar) {
      const actual = await sha256File(filePath)
      checksumOk = actual.toLowerCase() === sidecar
      notes.push(checksumOk ? 'sha256 侧车校验一致' : 'sha256 侧车校验不一致')
    } else {
      notes.push('没有可用的期望校验和，跳过 checksum 比对')
    }
  }

  let structureOk = false
  let totalInsertRows = 0
  const rowCounts: Record<string, number> = {}
  let tableCount: number | null = null
  let viewCount: number | null = null
  if (nonEmpty && manifest) {
    const footerOk = await hasValidFooter(filePath)
    if (!footerOk) notes.push(`缺少结尾标记 ${BACKUP_END}（文件可能被截断）`)
    const scan = await scanDumpFile(filePath)
    tableCount = scan.createTableCount
    viewCount = scan.createViewCount
    rowCountsByName(scan, rowCounts)
    totalInsertRows = Object.values(scan.rowCountsByTable).reduce((a, b) => a + b, 0)

    const expectedTableCount = manifest.type === 'data_only' ? 0 : manifest.tables.length
    if (scan.createTableCount !== expectedTableCount) {
      notes.push(
        `CREATE TABLE 数量 ${scan.createTableCount} 与 manifest 表数量 ${expectedTableCount} 不一致`
      )
    }
    const expectedViewCount = manifest.type === 'data_only' ? 0 : manifest.views.length
    if (scan.createViewCount !== expectedViewCount) {
      notes.push(`CREATE VIEW 数量 ${scan.createViewCount} 与 manifest 视图数量 ${expectedViewCount} 不一致`)
    }
    let rowMismatch = 0
    for (const table of manifest.tables) {
      const fileRows = scan.rowCountsByTable[table] ?? 0
      const manifestRows = manifest.rowCounts[table] ?? 0
      if (fileRows !== manifestRows) {
        rowMismatch += 1
        notes.push(`表 ${table} 的 INSERT 行数 ${fileRows} 与 manifest ${manifestRows} 不一致`)
      }
    }
    if (rowMismatch > 0) notes.push(`${rowMismatch} 张表的行数与 manifest 不一致`)

    structureOk =
      footerOk && scan.createTableCount === expectedTableCount && scan.createViewCount === expectedViewCount
  } else if (nonEmpty) {
    notes.push('无法解析 manifest，结构校验未通过')
  }

  const rowDataPresent =
    totalInsertRows > 0 || (manifest !== null && manifest.type !== 'schema_only' && manifest.totalRows === 0)

  return {
    fileExists: true,
    nonEmpty,
    fileSize: size,
    checksumOk,
    structureOk,
    tableCount,
    viewCount,
    totalInsertRows,
    rowDataPresent,
    rowCounts,
    manifest,
    notes
  }
}

function rowCountsByName(scan: DumpScanResult, target: Record<string, number>): void {
  for (const [name, count] of Object.entries(scan.rowCountsByTable)) target[name] = count
}

/** `/*!50001 CREATE ... *\/` => `CREATE ...` (classification only). */
function stripExecutableComment(stmt: string): string {
  return stmt
    .replace(/^\s*(?:\/\*!\d*\s*)+/g, '')
    .replace(/\*\/\s*$/g, '')
    .trim()
}
