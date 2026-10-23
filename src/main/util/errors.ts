import type { AppErrorPayload, ErrorCode } from '@shared/types'

/**
 * Typed, serialisable application error. Every service throws AppError; the IPC
 * layer converts it to `{ ok:false, error }` without leaking stack traces.
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown
  readonly hint?: string

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; hint?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.details = options?.details
    this.hint = options?.hint
  }

  toPayload(): AppErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.hint ? { hint: this.hint } : {})
    }
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

export function toAppError(e: unknown, fallbackCode: ErrorCode = 'INTERNAL'): AppError {
  if (isAppError(e)) return e
  if (e instanceof Error) {
    const anyErr = e as Error & { code?: string; sqlMessage?: string; errno?: number }
    const message = anyErr.sqlMessage || anyErr.message || 'Unknown error'
    const code = mapDbErrorCode(anyErr.code)
    return new AppError(code, message, { details: { errno: anyErr.errno, rawCode: anyErr.code } })
  }
  return new AppError(fallbackCode, String(e))
}

function mapDbErrorCode(code: string | undefined): ErrorCode {
  switch (code) {
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_DBACCESS_DENIED_ERROR':
    case 'ER_TABLEACCESS_DENIED_ERROR':
    case 'ER_SPECIFIC_ACCESS_DENIED_ERROR':
      return 'PERMISSION_DENIED'
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ER_CON_COUNT_ERROR':
      return 'CONNECTION_FAILED'
    case 'ER_NO_SUCH_TABLE':
    case 'ER_BAD_DB_ERROR':
      return 'NOT_FOUND'
    default:
      return 'QUERY_FAILED'
  }
}

export function assert(condition: unknown, message: string, code: ErrorCode = 'VALIDATION'): asserts condition {
  if (!condition) throw new AppError(code, message)
}
