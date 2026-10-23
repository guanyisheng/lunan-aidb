/**
 * SQL dump reader / executor.
 *
 * A logical backup is a text file of SQL statements. Splitting it correctly is
 * security-relevant: executing a half-split statement (or silently dropping the
 * tail of a truncated backup) would produce a "successful" restore with missing
 * data. Therefore the splitter is a real quote/comment aware state machine that
 * also understands the mysql client `DELIMITER` directive (needed for stored
 * programs and triggers whose bodies contain semicolons).
 *
 * Chunk-boundary safety: file reading is streaming, so two-character tokens
 * (`/*`, `*​/`, `--`), backslash escapes and multi-character delimiters may be
 * split across chunks. Ambiguous trailing characters are carried over to the
 * next feed() instead of being classified prematurely.
 */
import { createReadStream } from 'node:fs'
import type { DbSession } from '@main/service-contracts'

type SplitterState = 'normal' | 'single' | 'double' | 'backtick' | 'line_comment' | 'block_comment'

export interface SplitResult {
  statements: string[]
  /** A trailing partial statement (missing terminator) - indicates truncation. */
  remainder: string
}

/** Streaming, quote/comment/DELIMITER aware SQL statement splitter. */
export class SqlStatementSplitter {
  private buffer = ''
  private pos = 0
  private pending = ''
  private state: SplitterState = 'normal'
  private delimiter = ';'
  private lineStart = true

  feed(chunk: string): string[] {
    this.buffer += chunk
    return this.drain(false)
  }

  end(): SplitResult {
    const statements = this.drain(true)
    return { statements, remainder: this.pending.trim() }
  }

  private compact(): void {
    if (this.pos > 0) {
      this.buffer = this.buffer.slice(this.pos)
      this.pos = 0
    }
  }

  private drain(eof: boolean): string[] {
    const out: string[] = []
    const buf = this.buffer

    while (this.pos < buf.length) {
      const ch = buf[this.pos]
      const remaining = buf.length - this.pos

      if (this.state === 'normal') {
        // --- DELIMITER directive (line start only, like the mysql client) ---
        if (this.lineStart && this.pending.trim() === '') {
          const rest = buf.slice(this.pos)
          if (!eof && !rest.includes('\n')) {
            const word = rest.trimEnd()
            const looksLikeDirective =
              (word.length > 0 && word.length <= 9 && 'DELIMITER'.startsWith(word)) ||
              /^DELIMITER\b/i.test(rest)
            if (looksLikeDirective) break
          }
          const m = /^DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i.exec(rest)
          if (m && (m[0].endsWith('\n') || eof)) {
            this.delimiter = m[1]
            this.pos += m[0].length
            this.lineStart = true
            this.pending = ''
            continue
          }
        }

        // --- multi-char delimiter split across a chunk boundary ---
        if (!eof && this.delimiter.length > 1) {
          const rest = buf.slice(this.pos)
          if (rest.length < this.delimiter.length && this.delimiter.startsWith(rest)) break
        }

        // --- comment starts needing up to 2 chars of lookahead ---
        if (ch === '/' && remaining < 2 && !eof) break
        if (ch === '/' && buf[this.pos + 1] === '*') {
          if (remaining < 3 && !eof) break
          if (buf[this.pos + 2] !== '!') {
            // `/*! ... *​/` executable comments are real SQL and must run.
            this.state = 'block_comment'
            this.pos += 2
            continue
          }
        }
        if (ch === '-' && remaining < 2 && !eof) break
        if (ch === '-' && buf[this.pos + 1] === '-') {
          if (remaining < 3 && !eof) break
          const next = buf[this.pos + 2]
          if (next === undefined || next === ' ' || next === '\t' || next === '\n' || next === '\r') {
            this.state = 'line_comment'
            this.pos += 2
            continue
          }
        }
        if (ch === '#') {
          this.state = 'line_comment'
          this.pos += 1
          continue
        }
        if (ch === "'") {
          this.state = 'single'
          this.pending += ch
          this.pos += 1
          this.lineStart = false
          continue
        }
        if (ch === '"') {
          this.state = 'double'
          this.pending += ch
          this.pos += 1
          this.lineStart = false
          continue
        }
        if (ch === '`') {
          this.state = 'backtick'
          this.pending += ch
          this.pos += 1
          this.lineStart = false
          continue
        }
        if (buf.startsWith(this.delimiter, this.pos)) {
          this.pos += this.delimiter.length
          const stmt = this.pending.trim()
          if (stmt.length > 0) out.push(stmt)
          this.pending = ''
          this.lineStart = false
          continue
        }
        this.pending += ch
        this.lineStart = ch === '\n'
        this.pos += 1
        continue
      }

      if (this.state === 'line_comment') {
        if (ch === '\n') {
          this.state = 'normal'
          this.pending += ch
          this.lineStart = true
        }
        this.pos += 1
        continue
      }

      if (this.state === 'block_comment') {
        if (ch === '*') {
          if (remaining < 2 && !eof) break
          if (buf[this.pos + 1] === '/') {
            this.state = 'normal'
            this.pos += 2
            this.lineStart = false
            continue
          }
        }
        this.pos += 1
        continue
      }

      // Quoted string / identifier states.
      const quote = this.state === 'single' ? "'" : this.state === 'double' ? '"' : '`'
      if (ch === '\\' && this.state !== 'backtick') {
        if (remaining < 2 && !eof) break
        this.pending += ch + buf[this.pos + 1]
        this.pos += 2
        this.lineStart = false
        continue
      }
      if (ch === quote) {
        if (remaining < 2 && !eof) break
        if (buf[this.pos + 1] === quote) {
          // Doubled quote is an escaped quote (e.g. '' inside a string).
          this.pending += quote + quote
          this.pos += 2
          this.lineStart = false
          continue
        }
        this.state = 'normal'
        this.pending += ch
        this.pos += 1
        this.lineStart = false
        continue
      }
      this.pending += ch
      this.lineStart = ch === '\n'
      this.pos += 1
    }

    this.compact()
    if (this.pending.length > 64 * 1024 * 1024) {
      throw new Error('SQL splitter: single statement exceeds 64MiB safety limit')
    }
    return out
  }
}

/** Convenience helper for tests / small payloads. */
export function splitSqlText(text: string): SplitResult {
  const splitter = new SqlStatementSplitter()
  const statements = splitter.feed(text)
  const tail = splitter.end()
  return { statements: [...statements, ...tail.statements], remainder: tail.remainder }
}

export interface ExecuteSqlFileOptions {
  onStatement?: (info: { index: number; statement: string; durationMs: number }) => void
  onProgress?: (p: { executed: number; phase: string; message: string; progress: number }) => void
  signal?: AbortSignal
  /** Hard cap so a malicious/garbled file cannot run forever. */
  maxStatements?: number
  log?: (message: string, meta?: Record<string, unknown>) => void
}

export interface ExecuteSqlFileResult {
  executed: number
  statements: string[]
  durationMs: number
}

/**
 * Executes every statement of a dump file on the given session.
 *
 * Statements are run one by one (never as one multi-statement blob) so a failure
 * gives an exact statement index and a truthful "partial restore" state.
 */
export async function executeSqlFile(
  session: DbSession,
  filePath: string,
  options: ExecuteSqlFileOptions = {}
): Promise<ExecuteSqlFileResult> {
  const started = Date.now()
  const splitter = new SqlStatementSplitter()
  const statements: string[] = []
  let executed = 0
  const maxStatements = options.maxStatements ?? 10_000_000
  const log = options.log

  const runOne = async (stmt: string): Promise<void> => {
    if (statements.length >= maxStatements) {
      throw new Error(`SQL file contains more than ${maxStatements} statements; refusing to continue`)
    }
    const idx = executed
    const t0 = Date.now()
    await session.rawQuery(stmt)
    executed += 1
    statements.push(stmt.length > 500 ? `${stmt.slice(0, 500)}…` : stmt)
    const durationMs = Date.now() - t0
    options.onStatement?.({ index: idx, statement: statements[statements.length - 1], durationMs })
    if (executed % 200 === 0) {
      options.onProgress?.({
        executed,
        phase: 'execute',
        message: `已执行 ${executed} 条 SQL`,
        progress: -1
      })
    }
  }

  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 })
  for await (const chunk of stream) {
    if (options.signal?.aborted) throw new Error('cancelled')
    const completed = splitter.feed(chunk as string)
    for (const stmt of completed) {
      if (options.signal?.aborted) throw new Error('cancelled')
      await runOne(stmt)
    }
  }

  const tail = splitter.end()
  for (const stmt of tail.statements) await runOne(stmt)
  if (tail.remainder.length > 0) {
    // A trailing statement without delimiter almost always means the file was
    // truncated. Executing it could half-apply a write, so refuse.
    throw new Error(
      `备份文件尾部不完整：最后一条语句缺少结束符（${tail.remainder.slice(0, 120)}）`
    )
  }

  log?.('dump 执行完成', { filePath, executed })
  return { executed, statements, durationMs: Date.now() - started }
}
