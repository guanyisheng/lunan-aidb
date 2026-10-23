import type { EventMap, EventName, MethodMap, MethodName } from '@shared/ipc'
import type { AppErrorPayload, ErrorCode } from '@shared/types'

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown
  readonly hint?: string

  constructor(payload: AppErrorPayload) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
    this.details = payload.details
    this.hint = payload.hint
  }
}

function bridge(): Window['aidb'] {
  const api = window.aidb
  if (!api) {
    throw new ApiError({ code: 'INTERNAL', message: '预加载桥未注入，界面无法与主进程通信' })
  }
  return api
}

/** Typed IPC call that throws `ApiError` on failure. */
export async function call<K extends MethodName>(method: K, payload: MethodMap[K]['req']): Promise<MethodMap[K]['res']> {
  const result = await bridge().invoke(method, payload)
  if (!result.ok) throw new ApiError(result.error)
  return result.data
}

/** Typed IPC call that returns the envelope (use when the failure is expected). */
export async function tryCall<K extends MethodName>(
  method: K,
  payload: MethodMap[K]['req']
): Promise<{ ok: true; data: MethodMap[K]['res'] } | { ok: false; error: AppErrorPayload }> {
  try {
    const data = await bridge().invoke(method, payload)
    return data
  } catch (e) {
    return { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }
  }
}

export function onEvent<K extends EventName>(type: K, listener: (payload: EventMap[K]) => void): () => void {
  if (!window.aidb) return () => {}
  return window.aidb.on(type, listener)
}

export function platform(): string {
  return window.aidb?.platform ?? 'unknown'
}
