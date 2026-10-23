/**
 * Guards for the recovery-point capture path.
 *
 * The WHERE text used to capture before-images does not come from the user's
 * raw input directly: it is the classifier's AST-reserialised predicate. Even
 * so it is re-validated here before it is concatenated into a SELECT:
 *
 *  - exactly one statement,
 *  - a simple predicate over the target table only (no sub-selects, no UNION,
 *    no INTO OUTFILE / file or locking functions),
 *  - an explicit row cap so a capture can never turn into an unbounded dump.
 */
import { Parser } from 'node-sql-parser'
import { AppError } from '@main/util/errors'

export const MAX_CAPTURE_ROWS = 10_000

const parser = new Parser()

const FORBIDDEN_PATTERN =
  /(?:;|--|#|\/\*|\*\/|\u0000|\bUNION\b|\bINTO\s+(?:OUTFILE|DUMPFILE)\b|\bOUTFILE\b|\bDUMPFILE\b)/i

const DANGEROUS_FUNCTIONS = new Set([
  'sleep',
  'benchmark',
  'load_file',
  'get_lock',
  'release_lock',
  'is_free_lock',
  'is_used_lock',
  'master_pos_wait',
  'updatexml',
  'extractvalue',
  'sys_exec',
  'sys_eval'
])

export interface WhereValidationOk {
  ok: true
  normalized: string
}
export interface WhereValidationFail {
  ok: false
  reason: string
}

export function validateWherePredicate(
  whereSql: string,
  targetTable: string
): WhereValidationOk | WhereValidationFail {
  const text = (whereSql ?? '').trim()
  if (!text) return { ok: false, reason: 'WHERE 为空' }
  if (text.length > 8000) return { ok: false, reason: 'WHERE 过长，拒绝捕获' }
  if (FORBIDDEN_PATTERN.test(text)) {
    return { ok: false, reason: 'WHERE 中包含不允许的标记（分号/注释/UNION/文件导出）' }
  }
  const sql = `SELECT * FROM \`${targetTable.replace(/`/g, '``')}\` WHERE (${text})`
  let ast: unknown
  try {
    ast = parser.astify(sql, { database: 'mysql' })
  } catch (e) {
    return { ok: false, reason: `WHERE 无法重新解析：${(e as Error).message}` }
  }
  if (Array.isArray(ast)) return { ok: false, reason: 'WHERE 解析出多条语句' }
  const root = ast as Record<string, unknown>
  if (root.type !== 'select') return { ok: false, reason: 'WHERE 解析结果不是 SELECT' }
  if (root._next) return { ok: false, reason: 'WHERE 包含 UNION/多段查询' }
  const from = Array.isArray(root.from) ? (root.from as Record<string, unknown>[]) : []
  if (from.length !== 1) {
    return { ok: false, reason: 'WHERE 的目标表不唯一' }
  }
  const fromTable = typeof from[0]?.table === 'string' ? String(from[0].table) : ''
  const fromDb = from[0]?.db
  if (from.length !== 1 || fromTable.toLowerCase() !== targetTable.toLowerCase()) {
    return { ok: false, reason: 'WHERE 的目标表与预期不一致' }
  }
  if (fromDb !== null && fromDb !== undefined && String(fromDb).length > 0) {
    return { ok: false, reason: 'WHERE 中不允许跨库引用' }
  }
  if (!root.where) return { ok: false, reason: 'WHERE 为空' }
  // Only inspect the predicate subtree: the root 'select' itself is expected.
  const problem = inspectNode(root.where, targetTable, 0)
  if (problem) return { ok: false, reason: problem }
  return { ok: true, normalized: text }
}

function inspectNode(node: unknown, table: string, depth: number): string | null {
  if (depth > 60) return 'WHERE 嵌套过深'
  if (Array.isArray(node)) {
    for (const item of node) {
      const issue = inspectNode(item, table, depth + 1)
      if (issue) return issue
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  const obj = node as Record<string, unknown>
  const type = typeof obj.type === 'string' ? (obj.type as string) : ''
  if (type === 'select' || type === 'union' || type === 'with') {
    return 'WHERE 中不允许子查询'
  }
  if (type === 'function' || type === 'aggr_func') {
    const name = extractFunctionName(obj).toLowerCase()
    if (name && DANGEROUS_FUNCTIONS.has(name)) {
      return `WHERE 中不允许函数 ${name}`
    }
  }
  if (type === 'column_ref') {
    const tbl = obj.table
    if (typeof tbl === 'string' && tbl && tbl.toLowerCase() !== table.toLowerCase()) {
      return `WHERE 引用了其他表 ${tbl}`
    }
    return null
  }
  for (const key of Object.keys(obj)) {
    if (key === 'loc' || key === '_parentheses') continue
    const issue = inspectNode(obj[key], table, depth + 1)
    if (issue) return issue
  }
  return null
}

function extractFunctionName(node: Record<string, unknown>): string {
  // node-sql-parser shapes differ by version/keyword:
  //   { name: 'SLEEP' }
  //   { name: { name: [ { type:'default', value:'SLEEP' } ] } }
  //   { name: { value: 'SLEEP' } }
  // Collect every string-ish value under `name` instead of assuming one shape.
  const parts: string[] = []
  const collect = (value: unknown): void => {
    if (value === null || value === undefined) return
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>
      if (typeof obj.value === 'string') parts.push(obj.value)
      if (typeof obj.name === 'string') parts.push(obj.name)
      if (Array.isArray(obj.name)) collect(obj.name)
      else if (obj.name && typeof obj.name === 'object') collect(obj.name)
      // Some nodes put the identifier in `value` as an object/array.
      if (obj.value && typeof obj.value === 'object') collect(obj.value)
    }
  }
  collect(node.name)
  collect(node.aggr)
  return parts.join('').toLowerCase()
}

/** Ensures a captured row set never silently exceeds the cap. */
export function assertCaptureCap(rows: unknown[], cap = MAX_CAPTURE_ROWS): void {
  if (rows.length > cap) {
    throw new AppError(
      'PROTECTION_FAILED',
      `受影响行数超过捕获上限 ${cap}，需要改为完整备份后才能继续`,
      { hint: '请缩小 WHERE 范围，或先创建已验证的完整备份' }
    )
  }
}

/** Builds `(pk1 = ? AND pk2 = ?) OR ...` for PK based row lookups. */
export function buildPkMatch(
  columns: string[],
  rows: Record<string, unknown>[]
): { sql: string; params: unknown[] } {
  const params: unknown[] = []
  const groups = rows.map((row) => {
    const parts = columns.map((c) => {
      params.push(row[c] ?? null)
      return `\`${c.replace(/`/g, '``')}\` = ?`
    })
    return `(${parts.join(' AND ')})`
  })
  return { sql: groups.join(' OR '), params }
}
