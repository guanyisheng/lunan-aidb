/**
 * AIDB Studio - AST based SQL risk classification.
 *
 * Security notes
 * --------------
 * - Statement splitting is implemented as a small state machine (quotes,
 *   backslash escapes, `--` / `#` line comments, `/* ... *​/` block comments and
 *   client `DELIMITER` directives). Regex-only splitting is unsafe for SQL that
 *   contains semicolons inside strings/comments/triggers.
 * - Classification relies on `node-sql-parser` (MySQL dialect) where possible.
 *   When parsing fails we *fail strict*: high/critical risk, backup required and
 *   `parser: 'fallback'` with the parse error recorded. The parser is a policy
 *   input, never a substitute for database privileges.
 * - `whereSql` is the AST-reserialised predicate. `parser.sqlify(where)` throws
 *   for bare expressions in node-sql-parser 5.x, so we fall back to
 *   `exprToSQL(where)`; if both fail it is `null` (never a hand-built guess).
 * - `pkValues` (INSERT) is a best-effort literal column→value map; without a
 *   live catalog we cannot know the real primary key, so the time machine must
 *   intersect it with the table's actual PK columns. `null` means it could not
 *   be parsed statically.
 */
import { Parser } from 'node-sql-parser'
import type {
  RiskLevel,
  SqlAnalysis,
  SqlStatementKind,
  StatementCategory,
  StatementRisk
} from '@shared/types'
import type { Services, SqlRiskClassifier } from '../service-contracts'
import { AppError } from '../util/errors'
import type { ServicesSource } from './internal'

/* Keep types referenced for future evolution; classifier itself stays I/O free. */
type SqlAst = Record<string, unknown>

const RISK_ORDER: Record<RiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

function riskOf(levels: RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>((acc, level) => maxRisk(acc, level), 'none')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(obj: Record<string, unknown> | null, key: string): string | null {
  if (!obj) return null
  const value = obj[key]
  return typeof value === 'string' ? value : null
}

function readArray(obj: Record<string, unknown> | null, key: string): unknown[] {
  if (!obj) return []
  const value = obj[key]
  return Array.isArray(value) ? value : []
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))]
}

/* ------------------------------------------------------------------ */
/* Statement splitting state machine                                   */
/* ------------------------------------------------------------------ */

/**
 * Split a SQL script into statements. Handles:
 *  - single quoted strings (`'...'`) with backslash escapes and `''` doubling;
 *  - double quoted strings (`"..."`), backtick identifiers (`` `...` ``);
 *  - `-- ` / `#` line comments and block comments (block comments may contain
 *    semicolons, e.g. executable `/*! ... *​/` comments);
 *  - client-side `DELIMITER xx` directives used by mysql clients for triggers
 *    and stored routines.
 *
 * Comments are preserved inside statements so the executed SQL stays faithful.
 * Empty/comment-only chunks are dropped.
 */
export function splitSqlStatements(sql: string): string[] {
  if (typeof sql !== 'string' || sql.trim().length === 0) return []

  const statements: string[] = []
  const length = sql.length
  let buffer = ''
  let delimiter = ';'
  let index = 0

  const push = (): void => {
    const trimmed = buffer.trim()
    if (trimmed.length > 0 && hasExecutableContent(trimmed)) statements.push(trimmed)
    buffer = ''
  }

  while (index < length) {
    const char = sql[index]

    // client DELIMITER directive: must start a line / a fresh statement
    if (
      (char === 'D' || char === 'd') &&
      isLineBoundary(sql, index) &&
      buffer.trim().length === 0
    ) {
      const match = /^DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i.exec(sql.slice(index))
      if (match) {
        delimiter = match[1]
        index += match[0].length
        continue
      }
    }

    // line comments: -- (MySQL requires whitespace/control after it) and #
    if (
      char === '#' ||
      (char === '-' &&
        sql[index + 1] === '-' &&
        (index + 2 >= length || /\s/.test(sql[index + 2])))
    ) {
      const newline = sql.indexOf('\n', index + 1)
      const end = newline === -1 ? length : newline
      buffer += sql.slice(index, end)
      index = end
      continue
    }

    // block comment
    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2)
      const end = close === -1 ? length : close + 2
      buffer += sql.slice(index, end)
      index = end
      continue
    }

    // quoted string / identifier
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      let cursor = index + 1
      buffer += char
      while (cursor < length) {
        const current = sql[cursor]
        if (current === '\\' && quote !== '`') {
          buffer += sql.slice(cursor, Math.min(cursor + 2, length))
          cursor += 2
          continue
        }
        if (current === quote) {
          if (sql[cursor + 1] === quote) {
            buffer += quote + quote
            cursor += 2
            continue
          }
          buffer += quote
          cursor += 1
          break
        }
        buffer += current
        cursor += 1
      }
      index = cursor
      continue
    }

    // statement delimiter
    if (sql.startsWith(delimiter, index)) {
      push()
      index += delimiter.length
      continue
    }

    buffer += char
    index += 1
  }

  push()
  return statements
}

function isLineBoundary(sql: string, index: number): boolean {
  if (index === 0) return true
  const previous = sql[index - 1]
  if (previous === '\n') return true
  // allow leading horizontal whitespace before the directive
  let cursor = index - 1
  while (cursor >= 0 && (sql[cursor] === ' ' || sql[cursor] === '\t' || sql[cursor] === '\r')) {
    cursor -= 1
  }
  return cursor < 0 || sql[cursor] === '\n'
}

function hasExecutableContent(chunk: string): boolean {
  const withoutBlockComments = chunk.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const withoutLineComments = withoutBlockComments.replace(/(^|[\s;])(?:--[ \t][^\n]*|#[^\n]*)/g, '$1')
  return withoutLineComments.trim().length > 0
}

/* ------------------------------------------------------------------ */
/* Small AST readers                                                   */
/* ------------------------------------------------------------------ */

function leadingKeyword(sql: string): string {
  const cleaned = sql
    .replace(/^(?:\s|\/\*[\s\S]*?\*\/|--[ \t][^\n]*\n|#[^\n]*\n)+/, '')
    .trimStart()
  const match = /^([A-Za-z_]+)/.exec(cleaned)
  return match ? match[1].toUpperCase() : ''
}

function collectTableNames(value: unknown): string[] {
  const names: string[] = []
  const visit = (candidate: unknown, depth = 0): void => {
    if (!candidate || depth > 6) return
    if (typeof candidate === 'string') {
      names.push(candidate)
      return
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1)
      return
    }
    const record = asRecord(candidate)
    if (!record) return
    const table = record.table
    if (typeof table === 'string' && table.length > 0) {
      const db = typeof record.db === 'string' && record.db.length > 0 ? record.db : null
      names.push(db ? `${db}.${table}` : table)
      return
    }
    const view = record.view
    if (typeof view === 'string' && view.length > 0) {
      names.push(view)
      return
    }
    const name = record.name
    if (typeof name === 'string' && record.type === undefined) {
      names.push(name)
    }
  }
  visit(value)
  return dedupe(names)
}

function modifySetColumns(ast: SqlAst): string[] {
  const setList = readArray(ast, 'set')
  const columns: string[] = []
  for (const item of setList) {
    const record = asRecord(item)
    const column = record ? record.column : undefined
    if (typeof column === 'string') columns.push(column)
    else {
      const columnRef = asRecord(column)
      if (columnRef && typeof columnRef.column === 'string') columns.push(columnRef.column)
    }
  }
  return dedupe(columns)
}

interface LiteralResult {
  ok: boolean
  value?: unknown
}

function literalValue(node: unknown): LiteralResult {
  const record = asRecord(node)
  if (!record) return { ok: false }
  const type = readString(record, 'type')
  switch (type) {
    case 'number': {
      // node-sql-parser stores numeric literals as strings (e.g. "5.00").
      if (typeof record.value === 'number') return { ok: true, value: record.value }
      if (typeof record.value === 'string') {
        const numeric = Number(record.value)
        if (!Number.isFinite(numeric)) return { ok: false }
        // Keep exactness for big/decimal literals; use a JS number for safe ints.
        return { ok: true, value: Number.isSafeInteger(numeric) ? numeric : record.value }
      }
      return { ok: false }
    }
    case 'single_quote_string':
    case 'double_quote_string':
    case 'backticks_quote_string':
    case 'natural_string':
    case 'var_string':
    case 'regex_string':
    case 'hex_string':
    case 'full_hex_string':
    case 'bit_string':
    case 'origin':
      return typeof record.value === 'string' ? { ok: true, value: record.value } : { ok: false }
    case 'null':
      return { ok: true, value: null }
    case 'bool':
    case 'boolean':
      return typeof record.value === 'boolean' ? { ok: true, value: record.value } : { ok: false }
    case 'param':
      return { ok: false }
    default:
      return { ok: false }
  }
}

/* ------------------------------------------------------------------ */
/* Keyword → statement kind mapping (fallback path)                    */
/* ------------------------------------------------------------------ */

function kindFromKeyword(keyword: string): SqlStatementKind {
  switch (keyword) {
    case 'SELECT':
    case 'WITH':
    case 'TABLE':
    case 'VALUES':
      return 'select'
    case 'INSERT':
      return 'insert'
    case 'REPLACE':
      return 'replace'
    case 'UPDATE':
      return 'update'
    case 'DELETE':
      return 'delete'
    case 'CREATE':
      return 'create'
    case 'ALTER':
      return 'alter'
    case 'DROP':
      return 'drop'
    case 'TRUNCATE':
      return 'truncate'
    case 'RENAME':
      return 'rename'
    case 'CALL':
    case 'PROCEDURE':
      return 'procedure'
    case 'BEGIN':
    case 'START':
    case 'COMMIT':
    case 'ROLLBACK':
    case 'SAVEPOINT':
    case 'RELEASE':
      return 'transaction'
    case 'SET':
    case 'USE':
      return 'set'
    case 'SHOW':
    case 'DESCRIBE':
    case 'DESC':
      return 'show'
    case 'EXPLAIN':
      return 'explain'
    case 'LOAD':
      return 'load'
    case 'GRANT':
      case 'REVOKE':
        return 'grant'
    default:
      return 'unknown'
  }
}

const KIND_LABELS: Record<SqlStatementKind, string> = {
  select: '查询 SELECT',
  insert: '插入 INSERT',
  update: '更新 UPDATE',
  delete: '删除 DELETE',
  replace: '替换 REPLACE',
  create: '创建 CREATE',
  alter: '变更 ALTER',
  drop: '删除对象 DROP',
  truncate: '清空 TRUNCATE',
  rename: '重命名 RENAME',
  procedure: '存储过程 CALL',
  transaction: '事务控制',
  set: '会话/变量设置 SET',
  show: '结构查询 SHOW',
  explain: '执行计划 EXPLAIN',
  load: '数据导入 LOAD',
  grant: '权限变更 GRANT',
  unknown: '未知语句'
}

/* ------------------------------------------------------------------ */
/* Classifier                                                          */
/* ------------------------------------------------------------------ */

export class AstSqlRiskClassifier implements SqlRiskClassifier {
  private readonly parser: Parser

  /**
   * The classifier is intentionally free of I/O so it can be unit tested with a
   * minimal service container. `services` is accepted for contract consistency
   * with the other db services (logging is done by the execution service).
   */
  constructor(_services: ServicesSource) {
    this.parser = new Parser()
  }

  splitStatements(sql: string): string[] {
    return splitSqlStatements(sql)
  }

  classify(sql: string): SqlAnalysis {
    if (typeof sql !== 'string' || sql.trim().length === 0) {
      return {
        statements: [],
        overallRisk: 'none',
        requiresApproval: false,
        requiresBackup: false,
        readOnly: true,
        summary: '未检测到可执行 SQL 语句。',
        analyzer: 'ast'
      }
    }

    const parts = this.splitStatements(sql)
    if (parts.length === 0) {
      return {
        statements: [],
        overallRisk: 'none',
        requiresApproval: false,
        requiresBackup: false,
        readOnly: true,
        summary: '未检测到可执行 SQL 语句（内容为空或仅包含注释）。',
        analyzer: 'ast'
      }
    }

    const statements = parts.map((part, index) => this.classifyStatement(part, index))
    const overallRisk = riskOf(statements.map((s) => s.risk))
    const requiresApproval = statements.some((s) => s.requiresApproval)
    const requiresBackup = statements.some((s) => s.requiresBackup)
    const readOnly = statements.every((s) => s.category === 'read')
    const parserKinds = new Set(statements.map((s) => s.parser))
    const analyzer: SqlAnalysis['analyzer'] =
      parserKinds.size === 1 && parserKinds.has('ast')
        ? 'ast'
        : parserKinds.size === 1 && parserKinds.has('fallback')
          ? 'fallback'
          : 'mixed'

    return {
      statements,
      overallRisk,
      requiresApproval: requiresApproval || RISK_ORDER[overallRisk] >= RISK_ORDER.high,
      requiresBackup,
      readOnly,
      summary: this.buildSummary(statements, overallRisk),
      analyzer
    }
  }

  classifyStatement(statement: string, index: number): StatementRisk {
    const sql = (statement ?? '').trim()
    if (sql.length === 0) {
      throw new AppError('VALIDATION', '无法对空 SQL 语句做风险分类')
    }
    // Defensive: a single "statement" must not smuggle more statements past the
    // splitter (public API could be called directly with a full script).
    const embedded = splitSqlStatements(sql)
    if (embedded.length > 1) {
      return this.fallbackRisk(sql, index, leadingKeyword(sql), '输入包含多条语句，必须逐条分类')
    }

    const keyword = leadingKeyword(sql)
    const parsed = this.tryParse(sql)
    if (!parsed.ok) {
      return this.fallbackRisk(sql, index, keyword, parsed.error)
    }
    return this.classifyAst(sql, index, parsed.ast)
  }

  estimateImpact(analysis: SqlAnalysis): {
    risk: RiskLevel
    requiresApproval: boolean
    requiresBackup: boolean
  } {
    return {
      risk: analysis.overallRisk,
      requiresApproval:
        analysis.requiresApproval || RISK_ORDER[analysis.overallRisk] >= RISK_ORDER.high,
      requiresBackup: analysis.requiresBackup
    }
  }

  /* ------------------------------ parsing ------------------------------ */

  private tryParse(sql: string): { ok: true; ast: SqlAst } | { ok: false; error: string } {
    try {
      const ast = this.parser.astify(sql, { database: 'mysql' })
      const list = Array.isArray(ast) ? ast : [ast]
      if (list.length === 0) return { ok: false, error: '解析结果为空' }
      if (list.length > 1) return { ok: false, error: '单条语句被解析为多个 AST' }
      const record = asRecord(list[0])
      if (!record) return { ok: false, error: '解析结果不是有效的 AST 对象' }
      return { ok: true, ast: record }
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
      return { ok: false, error: message.slice(0, 300) }
    }
  }

  private classifyAst(sql: string, index: number, ast: SqlAst): StatementRisk {
    const type = readString(ast, 'type') ?? 'unknown'
    switch (type) {
      case 'select':
        return this.classifySelect(sql, index, ast)
      case 'insert':
      case 'replace':
        return this.classifyInsert(sql, index, ast, type)
      case 'update':
        return this.classifyUpdate(sql, index, ast)
      case 'delete':
        return this.classifyDelete(sql, index, ast)
      case 'create':
        return this.classifyCreate(sql, index, ast)
      case 'alter':
        return this.classifyAlter(sql, index, ast)
      case 'drop':
        return this.classifyDrop(sql, index, ast)
      case 'truncate':
        return this.classifyTruncate(sql, index, ast)
      case 'rename':
        return this.classifyRename(sql, index, ast)
      case 'call':
        return this.classifyCall(sql, index)
      case 'grant':
        return this.classifyGrant(sql, index)
      case 'load_data':
        return this.classifyLoad(sql, index, ast)
      case 'transaction':
        return this.risk(sql, index, {
          kind: 'transaction',
          category: 'complex',
          risk: 'low',
          reasons: ['事务控制语句；事务由执行器统一管理。'],
          requiresApproval: false,
          requiresBackup: false,
          recoveryStrategy: 'none'
        })
      case 'set':
        return this.classifySet(sql, index, ast)
      case 'show':
      case 'desc':
        return this.risk(sql, index, {
          kind: 'show',
          category: 'read',
          risk: 'none',
          targetTables: this.tablesFromParser(sql),
          reasons: ['只读的结构/状态查询。'],
          requiresApproval: false,
          requiresBackup: false,
          recoveryStrategy: 'none'
        })
      case 'explain':
        return this.risk(sql, index, {
          kind: 'explain',
          category: 'read',
          risk: 'none',
          targetTables: this.tablesFromParser(sql),
          reasons: ['只读执行计划查询。'],
          requiresApproval: false,
          requiresBackup: false,
          recoveryStrategy: 'none'
        })
      case 'use':
        return this.risk(sql, index, {
          kind: 'set',
          category: 'complex',
          risk: 'low',
          reasons: ['切换当前会话数据库。'],
          requiresApproval: false,
          requiresBackup: false,
          recoveryStrategy: 'none'
        })
      default:
        return this.fallbackRisk(sql, index, leadingKeyword(sql), `暂不支持的语句类型：${type}`)
    }
  }

  /* ------------------------------ reads -------------------------------- */

  private classifySelect(sql: string, index: number, ast: SqlAst): StatementRisk {
    const tables = this.tablesFromParser(sql)
    const intoFile = /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(sql)
    const lockingRead = /\bFOR\s+(?:UPDATE|SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(sql)

    if (intoFile) {
      return this.risk(sql, index, {
        kind: 'select',
        category: 'complex',
        risk: 'high',
        targetTables: tables,
        reasons: [
          'SELECT ... INTO OUTFILE/DUMPFILE 会在数据库服务器上写文件，恢复点无法撤销该副作用。',
          '需要用户确认并检查服务器文件权限。'
        ],
        requiresApproval: true,
        requiresBackup: false,
        recoveryStrategy: 'refuse_unsafe'
      })
    }

    return this.risk(sql, index, {
      kind: 'select',
      category: 'read',
      risk: lockingRead ? 'low' : 'none',
      targetTables: tables,
      reasons: lockingRead
        ? ['只读查询，但会对扫描行加锁（FOR UPDATE / LOCK IN SHARE MODE）。']
        : ['只读查询，不修改数据。'],
      requiresApproval: false,
      requiresBackup: false,
      recoveryStrategy: 'none',
      hasWhereClause: ast.where !== null && ast.where !== undefined,
      whereSql: this.reserializeWhere(ast.where)
    })
  }

  /* ------------------------------- DML --------------------------------- */

  private classifyInsert(
    sql: string,
    index: number,
    ast: SqlAst,
    type: 'insert' | 'replace'
  ): StatementRisk {
    const targetTables = collectTableNames(ast.table)
    const firstTarget = targetTables[0] ?? null

    const explicitColumns = readArray(ast, 'columns').filter(
      (c): c is string => typeof c === 'string'
    )
    const setColumns = modifySetColumns(ast)
    const columnList = explicitColumns.length > 0 ? explicitColumns : setColumns

    const valuesNode = asRecord(ast.values)
    const valuesType = readString(valuesNode, 'type')
    const tuples = readArray(valuesNode, 'values')
    const valueTuples = valuesType === 'values' ? tuples.length : null

    let pkValues: Record<string, unknown> | null = null
    let literalPairs: unknown[] | null = null
    if (valuesType === 'values' && tuples.length > 0 && columnList.length > 0) {
      const tuple = asRecord(tuples[0])
      const items = readArray(tuple, 'value')
      if (items.length === columnList.length) {
        const pairs: unknown[] = []
        let literal = true
        for (let i = 0; i < items.length; i += 1) {
          const literalResult = literalValue(items[i])
          if (!literalResult.ok) {
            literal = false
            break
          }
          pairs.push([columnList[i], literalResult.value])
        }
        if (literal) literalPairs = pairs
      }
    } else if (columnList.length > 0) {
      const setList = readArray(ast, 'set')
      const pairs: unknown[] = []
      let literal = true
      for (const item of setList) {
        const record = asRecord(item)
        const column = record && typeof record.column === 'string' ? record.column : null
        const literalResult = literalValue(record?.value)
        if (!column || !literalResult.ok) {
          literal = false
          break
        }
        pairs.push([column, literalResult.value])
      }
      if (literal && pairs.length > 0) literalPairs = pairs
    }

    if (literalPairs && tuples.length <= 1) {
      pkValues = Object.fromEntries(literalPairs as [string, unknown][])
    }

    const insertSelect = valuesType === 'select'
    const duplicateUpdate = readArray(ast, 'on_duplicate_update').length > 0 ||
      asRecord(ast.on_duplicate_update) !== null
    const largeBatch = valueTuples !== null && valueTuples >= 1000

    const reasons: string[] = [
      type === 'replace'
        ? 'REPLACE 会先删除已有行再插入，可能丢失被替换行的数据。'
        : '写入语句，执行前将捕获受影响行信息。'
    ]
    let riskLevel: RiskLevel = 'medium'
    let requiresBackup = false
    let recoveryStrategy: StatementRisk['recoveryStrategy'] = 'before_image'

    if (insertSelect) {
      riskLevel = 'high'
      requiresBackup = true
      recoveryStrategy = 'full_backup'
      reasons.push('INSERT/REPLACE ... SELECT 影响行数在执行前未知，无法可靠捕获前镜像。')
    }
    if (largeBatch) {
      riskLevel = 'high'
      requiresBackup = true
      recoveryStrategy = 'full_backup'
      reasons.push(`批量写入 ${valueTuples} 行，需要更严格的保护策略。`)
    }
    if (duplicateUpdate) {
      riskLevel = maxRisk(riskLevel, 'high')
      reasons.push('包含 ON DUPLICATE KEY UPDATE，可能修改已存在的行。')
    }
    if (!pkValues) {
      reasons.push(
        insertSelect
          ? '无法静态解析插入行的主键值，需完整备份或依赖执行结果定位新行。'
          : '未能静态解析全部字面量值，无法确定插入行主键映射；恢复时需要完整备份或依赖 insertId/影响行数定位。'
      )
    }

    return this.risk(sql, index, {
      kind: type === 'replace' ? 'replace' : 'insert',
      category: 'dml',
      risk: riskLevel,
      targetTables,
      reasons,
      requiresApproval: true,
      requiresBackup,
      recoveryStrategy,
      targetTable: firstTarget,
      columnList,
      pkValues,
      valueTuples,
      hasWhereClause: false,
      unbounded: insertSelect
    })
  }

  private classifyUpdate(sql: string, index: number, ast: SqlAst): StatementRisk {
    const targets = this.writeTargets(ast.table)
    const hasWhereClause = ast.where !== null && ast.where !== undefined
    const whereSql = this.reserializeWhere(ast.where)
    const columnList = modifySetColumns(ast)
    const targetTable = targets[0] ?? null
    const hasLimit = ast.limit !== null && ast.limit !== undefined
    const whereSafety = hasWhereClause ? this.inspectWhere(ast.where) : { safe: false, reason: null }

    if (!hasWhereClause) {
      return this.risk(sql, index, {
        kind: 'update',
        category: 'dml',
        risk: 'critical',
        targetTables: targets,
        reasons: [
          'UPDATE 缺少 WHERE 条件，将更新整张表。',
          hasLimit ? '语句带有 LIMIT，但仍属于未限定条件的批量更新。' : '影响范围无上限。',
          '必须先生成并验证完整备份/恢复点。'
        ],
        requiresApproval: true,
        requiresBackup: true,
        recoveryStrategy: 'full_backup',
        targetTable,
        whereSql: null,
        columnList,
        hasWhereClause: false,
        unbounded: !hasLimit
      })
    }

    const replayUnsafe = !whereSafety.safe || whereSql === null
    const reasons = ['带 WHERE 条件的数据更新，将捕获受影响行的前镜像。']
    if (replayUnsafe) {
      reasons.push(
        whereSafety.reason ??
          'WHERE 谓词无法安全地重新序列化/重放（可能包含子查询、函数或无法解析的表达式），前镜像定位不可靠，已升级为完整备份策略。'
      )
    }

    return this.risk(sql, index, {
      kind: 'update',
      category: 'dml',
      risk: replayUnsafe ? 'high' : 'medium',
      targetTables: targets,
      reasons,
      requiresApproval: true,
      requiresBackup: replayUnsafe,
      recoveryStrategy: replayUnsafe ? 'full_backup' : 'before_image',
      targetTable,
      whereSql,
      columnList,
      hasWhereClause: true,
      unbounded: false
    })
  }

  private classifyDelete(sql: string, index: number, ast: SqlAst): StatementRisk {
    const directTargets = collectTableNames(ast.table)
    const targets =
      directTargets.length > 0 ? directTargets : this.writeTargets(readArray(ast, 'from'))
    const hasWhereClause = ast.where !== null && ast.where !== undefined
    const whereSql = this.reserializeWhere(ast.where)
    const targetTable = targets[0] ?? null
    const hasLimit = ast.limit !== null && ast.limit !== undefined
    const whereSafety = hasWhereClause ? this.inspectWhere(ast.where) : { safe: false, reason: null }

    if (!hasWhereClause) {
      return this.risk(sql, index, {
        kind: 'delete',
        category: 'dml',
        risk: 'critical',
        targetTables: targets,
        reasons: [
          'DELETE 缺少 WHERE 条件，将删除整张表数据。',
          hasLimit ? '语句带有 LIMIT，但仍属于未限定条件的批量删除。' : '影响范围无上限。',
          '必须先生成并验证完整备份/恢复点。'
        ],
        requiresApproval: true,
        requiresBackup: true,
        recoveryStrategy: 'full_backup',
        targetTable,
        whereSql: null,
        hasWhereClause: false,
        unbounded: !hasLimit
      })
    }

    const replayUnsafe = !whereSafety.safe || whereSql === null
    const reasons = ['带 WHERE 条件的数据删除，将捕获待删除行的前镜像。']
    if (replayUnsafe) {
      reasons.push(
        whereSafety.reason ??
          'WHERE 谓词无法安全地重新序列化/重放（可能包含子查询、函数或无法解析的表达式），前镜像定位不可靠，已升级为完整备份策略。'
      )
    }

    return this.risk(sql, index, {
      kind: 'delete',
      category: 'dml',
      risk: replayUnsafe ? 'high' : 'medium',
      targetTables: targets,
      reasons,
      requiresApproval: true,
      requiresBackup: replayUnsafe,
      recoveryStrategy: replayUnsafe ? 'full_backup' : 'before_image',
      targetTable,
      whereSql,
      hasWhereClause: true,
      unbounded: false
    })
  }

  /* ------------------------------- DDL --------------------------------- */

  private classifyCreate(sql: string, index: number, ast: SqlAst): StatementRisk {
    const keyword = (readString(ast, 'keyword') ?? 'table').toLowerCase()
    const tables = dedupe([
      ...collectTableNames(ast.table),
      ...collectTableNames(ast.view),
      ...this.tablesFromParser(sql)
    ])
    const targetTable = tables[0] ?? null
    const queryBased = ast.query_expr !== null && ast.query_expr !== undefined
    const routineLike =
      keyword === 'trigger' ||
      keyword === 'function' ||
      keyword === 'procedure' ||
      keyword === 'aggregate' ||
      keyword === 'event'

    const reasons = [`CREATE ${keyword.toUpperCase()} 属于 DDL，MySQL 会隐式提交当前事务。`]
    let riskLevel: RiskLevel = 'medium'
    let requiresBackup = false
    let recoveryStrategy: StatementRisk['recoveryStrategy'] = 'schema_snapshot'

    if (routineLike) {
      riskLevel = 'high'
      requiresBackup = true
      recoveryStrategy = 'full_backup'
      reasons.push('创建触发器/存储过程可能包含未知的副作用逻辑，需要更严格的保护。')
    }
    if (queryBased) {
      riskLevel = 'high'
      requiresBackup = true
      recoveryStrategy = 'full_backup'
      reasons.push('CREATE ... AS SELECT 会写入数据，影响范围未知。')
    }

    return this.risk(sql, index, {
      kind: 'create',
      category: 'ddl',
      risk: riskLevel,
      targetTables: tables,
      reasons,
      requiresApproval: true,
      requiresBackup,
      recoveryStrategy,
      targetTable,
      implicitCommit: true
    })
  }

  private classifyAlter(sql: string, index: number, ast: SqlAst): StatementRisk {
    const tables = collectTableNames(ast.table)
    const targetTable = tables[0] ?? null
    const destructive = /\bDROP\s+(?:COLUMN|PARTITION|INDEX|FOREIGN\s+KEY|PRIMARY\s+KEY|CHECK|CONSTRAINT)\b|\bMODIFY\b|\bCHANGE\b/i.test(
      sql
    )
    const reasons = ['ALTER 属于 DDL，MySQL 会隐式提交当前事务，无法通过事务回滚撤销。']
    if (destructive) {
      reasons.push('包含 DROP/MODIFY/CHANGE 等可能丢失列或数据的变更，需要完整备份。')
    }

    return this.risk(sql, index, {
      kind: 'alter',
      category: 'ddl',
      risk: 'high',
      targetTables: tables,
      reasons,
      requiresApproval: true,
      requiresBackup: destructive,
      recoveryStrategy: destructive ? 'full_backup' : 'schema_snapshot',
      targetTable,
      implicitCommit: true
    })
  }

  private classifyDrop(sql: string, index: number, ast: SqlAst): StatementRisk {
    const keyword = (readString(ast, 'keyword') ?? 'table').toLowerCase()
    const name = ast.name
    const tables =
      typeof name === 'string'
        ? [name]
        : dedupe([...collectTableNames(name), ...collectTableNames(ast.table)])
    return this.risk(sql, index, {
      kind: 'drop',
      category: 'destructive',
      risk: 'critical',
      targetTables: tables,
      reasons: [
        `DROP ${keyword.toUpperCase()} 会永久删除数据库对象，且 DDL 会隐式提交。`,
        '事务回滚无法撤销该操作，必须先完成经过验证的完整备份。'
      ],
      requiresApproval: true,
      requiresBackup: true,
      recoveryStrategy: 'full_backup',
      targetTable: tables[0] ?? null,
      implicitCommit: true
    })
  }

  private classifyTruncate(sql: string, index: number, ast: SqlAst): StatementRisk {
    const tables = collectTableNames(ast.name)
    return this.risk(sql, index, {
      kind: 'truncate',
      category: 'destructive',
      risk: 'critical',
      targetTables: tables,
      reasons: [
        'TRUNCATE 会清空整张表且不可回滚（DDL 隐式提交）。',
        '必须先完成经过验证的完整备份。'
      ],
      requiresApproval: true,
      requiresBackup: true,
      recoveryStrategy: 'full_backup',
      targetTable: tables[0] ?? null,
      implicitCommit: true
    })
  }

  private classifyRename(sql: string, index: number, ast: SqlAst): StatementRisk {
    const tables = collectTableNames(ast.table)
    return this.risk(sql, index, {
      kind: 'rename',
      category: 'ddl',
      risk: 'high',
      targetTables: tables,
      reasons: [
        'RENAME TABLE 属于 DDL，MySQL 会隐式提交当前事务。',
        '重命名会破坏依赖旧表名的应用与视图，需要结构快照并人工确认。'
      ],
      requiresApproval: true,
      requiresBackup: false,
      recoveryStrategy: 'schema_snapshot',
      targetTable: tables[0] ?? null,
      implicitCommit: true
    })
  }

  /* --------------------------- complex/unknown ------------------------- */

  private classifyCall(sql: string, index: number): StatementRisk {
    return this.risk(sql, index, {
      kind: 'procedure',
      category: 'complex',
      risk: 'high',
      targetTables: this.tablesFromParser(sql),
      reasons: [
        'CALL 执行存储过程，内部可能包含数据修改、DDL 或隐式提交，静态分析无法确定影响范围。',
        '按从严策略处理：需要审批和经过验证的备份。'
      ],
      requiresApproval: true,
      requiresBackup: true,
      recoveryStrategy: 'full_backup',
      implicitCommit: true
    })
  }

  private classifyGrant(sql: string, index: number): StatementRisk {
    return this.risk(sql, index, {
      kind: 'grant',
      category: 'complex',
      risk: 'high',
      targetTables: this.tablesFromParser(sql),
      reasons: [
        'GRANT/REVOKE 修改账号权限，静态分析无法可靠撤销，且可能影响生产访问控制。',
        '需要用户审批并记录审计。'
      ],
      requiresApproval: true,
      requiresBackup: true,
      recoveryStrategy: 'full_backup',
      implicitCommit: true
    })
  }

  private classifyLoad(sql: string, index: number, ast: SqlAst): StatementRisk {
    const tables = collectTableNames(ast.table)
    return this.risk(sql, index, {
      kind: 'load',
      category: 'complex',
      risk: 'critical',
      targetTables: tables,
      reasons: [
        'LOAD DATA 会从服务器/客户端文件批量导入数据，影响范围在执行前未知。',
        '需要经过验证的完整备份与人工确认。'
      ],
      requiresApproval: true,
      requiresBackup: true,
      recoveryStrategy: 'full_backup',
      targetTable: tables[0] ?? null,
      implicitCommit: false
    })
  }

  private classifySet(sql: string, index: number, ast: SqlAst): StatementRisk {
    const keyword = readString(ast, 'keyword') ?? ''
    const globalScope = /\b(?:GLOBAL|PERSIST|PERSIST_ONLY)\b/i.test(keyword) ||
      /^\s*SET\s+(?:GLOBAL|PERSIST|PERSIST_ONLY)\b/i.test(sql)
    const passwordChange = /^\s*SET\s+PASSWORD\b/i.test(sql)

    if (passwordChange) {
      return this.risk(sql, index, {
        kind: 'set',
        category: 'complex',
        risk: 'high',
        reasons: ['修改数据库账号密码，恢复点无法撤销该操作。'],
        requiresApproval: true,
        requiresBackup: false,
        recoveryStrategy: 'refuse_unsafe'
      })
    }
    if (globalScope) {
      return this.risk(sql, index, {
        kind: 'set',
        category: 'complex',
        risk: 'high',
        reasons: ['修改服务器全局变量，可能影响所有连接，且恢复点无法撤销。'],
        requiresApproval: true,
        requiresBackup: false,
        recoveryStrategy: 'none'
      })
    }
    return this.risk(sql, index, {
      kind: 'set',
      category: 'complex',
      risk: 'low',
      reasons: ['会话级变量设置，不影响持久化数据。'],
      requiresApproval: false,
      requiresBackup: false,
      recoveryStrategy: 'none'
    })
  }

  private fallbackRisk(
    sql: string,
    index: number,
    keyword: string,
    parseError: string
  ): StatementRisk {
    const kind = kindFromKeyword(keyword)
    const destructive = kind === 'drop' || kind === 'truncate' || kind === 'delete'
    const riskLevel: RiskLevel = destructive ? 'critical' : 'high'
    const implicitCommit =
      kind === 'create' ||
      kind === 'alter' ||
      kind === 'drop' ||
      kind === 'truncate' ||
      kind === 'rename' ||
      kind === 'grant' ||
      kind === 'procedure' ||
      kind === 'load'
    return this.risk(sql, index, {
      kind,
      category: 'unknown',
      risk: riskLevel,
      reasons: [
        'SQL 无法被 AST 解析器可靠解析，已按从严策略处理。',
        `解析错误：${parseError}`,
        '需要用户审批，并且必须先完成经过验证的完整备份。'
      ],
      requiresApproval: true,
      requiresBackup: true,
      recoveryStrategy: 'full_backup',
      parser: 'fallback',
      parseError,
      implicitCommit,
      unbounded: kind === 'update' || kind === 'delete' || kind === 'unknown'
    })
  }

  /* ------------------------------ helpers ------------------------------ */

  private risk(
    sql: string,
    index: number,
    input: {
      kind: SqlStatementKind
      category: StatementCategory
      risk: RiskLevel
      targetTables?: string[]
      reasons: string[]
      requiresApproval: boolean
      requiresBackup: boolean
      recoveryStrategy: StatementRisk['recoveryStrategy']
      parser?: 'ast' | 'fallback'
      parseError?: string
      hasWhereClause?: boolean
      implicitCommit?: boolean
      targetTable?: string | null
      whereSql?: string | null
      columnList?: string[]
      pkValues?: Record<string, unknown> | null
      unbounded?: boolean
      valueTuples?: number | null
    }
  ): StatementRisk {
    const targetTables = dedupe(input.targetTables ?? [])
    const targetTable =
      input.category === 'read'
        ? (input.targetTable ?? null)
        : input.targetTable !== undefined
          ? input.targetTable
          : (targetTables[0] ?? null)
    return {
      statementIndex: index,
      sql,
      kind: input.kind,
      category: input.category,
      risk: input.risk,
      targetTables,
      reasons: input.reasons,
      requiresApproval: input.requiresApproval,
      requiresBackup: input.requiresBackup,
      recoveryStrategy: input.recoveryStrategy,
      estimatedRows: null,
      parser: input.parser ?? 'ast',
      ...(input.parseError !== undefined ? { parseError: input.parseError } : {}),
      ...(input.hasWhereClause !== undefined ? { hasWhereClause: input.hasWhereClause } : {}),
      ...(input.implicitCommit !== undefined ? { implicitCommit: input.implicitCommit } : {}),
      targetTable,
      whereSql: input.whereSql ?? null,
      ...(input.columnList !== undefined ? { columnList: input.columnList } : {}),
      ...(input.pkValues !== undefined ? { pkValues: input.pkValues } : {}),
      unbounded: input.unbounded ?? false,
      ...(input.valueTuples !== undefined ? { valueTuples: input.valueTuples } : {})
    }
  }

  /** Tables referenced by a read-only statement (via parser.tableList). */
  private tablesFromParser(sql: string): string[] {
    try {
      const list = this.parser.tableList(sql, { database: 'mysql' })
      const names: string[] = []
      for (const entry of list) {
        const parts = entry.split('::')
        const table = parts[2]
        if (!table || table === 'null') continue
        const db = parts[1]
        names.push(db && db !== 'null' ? `${db}.${table}` : table)
      }
      return dedupe(names)
    } catch {
      return []
    }
  }

  /** Write targets of an UPDATE: entries without a `join` key. */
  private writeTargets(value: unknown): string[] {
    const targets: string[] = []
    const visit = (candidate: unknown): void => {
      if (!candidate) return
      if (Array.isArray(candidate)) {
        for (const item of candidate) visit(item)
        return
      }
      const record = asRecord(candidate)
      if (!record) return
      if (record.join !== undefined) return
      const table = record.table
      if (typeof table === 'string' && table.length > 0) {
        const db = typeof record.db === 'string' && record.db.length > 0 ? record.db : null
        targets.push(db ? `${db}.${table}` : table)
      }
    }
    visit(value)
    return dedupe(targets)
  }

  /**
   * The time machine replays `whereSql` / uses the AST predicate to locate
   * before-image rows. Predicates containing functions, subqueries, user
   * variables or other non-pure constructs cannot be safely replayed (their
   * value may differ at replay time), so such DML is upgraded to a full backup
   * strategy and the reason is recorded.
   */
  private inspectWhere(where: unknown): { safe: boolean; reason: string | null } {
    const safeTypes = new Set([
      'binary_expr',
      'unary_expr',
      'column_ref',
      'expr',
      'expr_list',
      'number',
      'single_quote_string',
      'double_quote_string',
      'backticks_quote_string',
      'natural_string',
      'var_string',
      'hex_string',
      'full_hex_string',
      'bit_string',
      'origin',
      'regex_string',
      'null',
      'bool',
      'boolean',
      'interval',
      'default',
      'date',
      'datetime',
      'time',
      'timestamp',
      'case',
      'cast',
      'array',
      'json'
    ])
    let unsafeType: string | null = null
    const walk = (node: unknown): void => {
      if (unsafeType || node === null || node === undefined) return
      if (typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const item of node) walk(item)
        return
      }
      const record = node as Record<string, unknown>
      const type = typeof record.type === 'string' ? record.type : null
      if (type !== null && !safeTypes.has(type)) {
        unsafeType = type
        return
      }
      for (const value of Object.values(record)) {
        if (value !== null && typeof value === 'object') walk(value)
      }
    }
    walk(where)
    if (unsafeType === null) return { safe: true, reason: null }
    return {
      safe: false,
      reason: `WHERE 谓词包含 ${unsafeType} 节点（函数/子查询/变量等），无法保证在恢复时按原语义安全重放并定位前镜像行；已升级为完整备份策略，whereSql 仅供参考。`
    }
  }

  private reserializeWhere(where: unknown): string | null {
    if (!where || typeof where !== 'object') return null
    const looseParser = this.parser as unknown as {
      sqlify(ast: unknown): string
      exprToSQL(ast: unknown): string
    }
    try {
      return looseParser.sqlify(where)
    } catch {
      // node-sql-parser 5.x does not support sqlify() on a bare expression node.
    }
    try {
      return looseParser.exprToSQL(where)
    } catch {
      return null
    }
  }

  private buildSummary(statements: StatementRisk[], overallRisk: RiskLevel): string {
    const counts = new Map<SqlStatementKind, number>()
    for (const statement of statements) {
      counts.set(statement.kind, (counts.get(statement.kind) ?? 0) + 1)
    }
    const kindText = [...counts.entries()]
      .map(([kind, count]) => `${count} 条${KIND_LABELS[kind]}`)
      .join('、')
    const riskText: Record<RiskLevel, string> = {
      none: '无风险',
      low: '低风险',
      medium: '中风险',
      high: '高风险',
      critical: '极高风险'
    }
    const parts = [`共 ${statements.length} 条语句（${kindText}）`, `整体风险：${riskText[overallRisk]}`]

    const unboundedCount = statements.filter((s) => s.unbounded).length
    if (unboundedCount > 0) parts.push(`${unboundedCount} 条语句影响范围无上限`)

    const fallbackCount = statements.filter((s) => s.parser === 'fallback').length
    if (fallbackCount > 0) parts.push(`${fallbackCount} 条语句无法解析，已按从严策略处理`)

    if (statements.some((s) => s.requiresBackup)) parts.push('需要先创建经过验证的完整备份')
    else if (statements.some((s) => s.recoveryStrategy === 'before_image')) {
      parts.push('需要捕获受影响行的前镜像')
    }
    if (statements.some((s) => s.requiresApproval)) parts.push('需要用户明确授权')
    if (statements.every((s) => s.category === 'read')) parts.push('全部为只读操作')
    if (statements.some((s) => s.implicitCommit)) parts.push('包含 DDL/隐式提交语句，事务回滚无法撤销')

    return parts.join('；') + '。'
  }
}

/* Re-exported for tests / other db modules that need the splitter helper. */
export type { Services }
