import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from '@main/service-contracts'
import { redactText, redactValue } from './redact'

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerOptions {
  level?: Level
  filePath?: string | null
  console?: boolean
}

/**
 * Structured logger with mandatory redaction. Writing to disk is best-effort:
 * a logging failure must never take down a database operation.
 */
export class FileLogger implements Logger {
  private readonly level: Level
  private readonly filePath: string | null
  private readonly toConsole: boolean

  constructor(opts: LoggerOptions = {}, private readonly scope = 'app') {
    this.level = opts.level ?? 'info'
    this.filePath = opts.filePath ?? null
    this.toConsole = opts.console ?? true
    if (this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true })
      } catch {
        /* ignore */
      }
    }
  }

  child(scope: string): Logger {
    return new FileLogger(
      { level: this.level, filePath: this.filePath, console: this.toConsole },
      `${this.scope}:${scope}`
    )
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta)
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta)
  }

  private write(level: Level, message: string, meta?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return
    const ts = new Date().toISOString()
    let line = `${ts} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${redactText(message)}`
    if (meta && Object.keys(meta).length > 0) {
      try {
        line += ` ${JSON.stringify(redactValue(meta))}`
      } catch {
        line += ' [unserializable-meta]'
      }
    }
    if (this.toConsole && level !== 'debug') {
      // eslint-disable-next-line no-console
      console.log(line)
    }
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, `${line}\n`, 'utf8')
      } catch {
        /* logging must never throw */
      }
    }
  }
}

export class NullLogger implements Logger {
  debug(_message?: string, _meta?: Record<string, unknown>): void {}
  info(_message?: string, _meta?: Record<string, unknown>): void {}
  warn(_message?: string, _meta?: Record<string, unknown>): void {}
  error(_message?: string, _meta?: Record<string, unknown>): void {}
  child(): Logger {
    return this
  }
}
