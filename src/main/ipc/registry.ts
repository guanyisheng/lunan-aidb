import type { BrowserWindow } from 'electron'
import type { z } from 'zod'
import type { MethodMap, MethodName } from '@shared/ipc'
import type { InvokeResult } from '@shared/types'
import type { Services } from '@main/service-contracts'
import { AppError, toAppError } from '@main/util/errors'
import { redactValue } from '@main/security/redact'

export interface HandlerContext {
  services: Services
  window: () => BrowserWindow | null
}

type AnySchema = z.ZodTypeAny
type HandlerFn = (ctx: HandlerContext, payload: unknown) => Promise<unknown>

interface Registration {
  schema: AnySchema
  handler: HandlerFn
  /** Requires an unlocked window and is audited by the handler itself. */
  sensitive?: boolean
}

const MAX_PAYLOAD_CHARS = 8 * 1024 * 1024
const registry = new Map<string, Registration>()

/**
 * Registers one allow-listed IPC method. Anything not registered here is
 * rejected by `dispatch`, which is the single security boundary between the
 * renderer and the trusted service layer.
 */
export function defineHandler<K extends MethodName>(
  method: K,
  schema: AnySchema,
  handler: (ctx: HandlerContext, payload: MethodMap[K]['req']) => Promise<MethodMap[K]['res']>
): void {
  if (registry.has(method)) throw new Error(`Duplicate IPC handler: ${method}`)
  registry.set(method, {
    schema,
    handler: (ctx, payload) => handler(ctx, payload as MethodMap[K]['req'])
  })
}

export function registeredMethods(): MethodName[] {
  return [...registry.keys()] as MethodName[]
}

export async function dispatch(
  method: unknown,
  payload: unknown,
  ctx: HandlerContext
): Promise<InvokeResult<unknown>> {
  try {
    if (typeof method !== 'string' || method.length === 0 || method.length > 120) {
      throw new AppError('VALIDATION', '非法 IPC 方法名')
    }
    const entry = registry.get(method)
    if (!entry) {
      throw new AppError('PERMISSION_DENIED', `IPC 方法未在白名单中: ${method.slice(0, 60)}`)
    }
    const rawSize = safeJsonSize(payload)
    if (rawSize > MAX_PAYLOAD_CHARS) {
      throw new AppError('VALIDATION', 'IPC 请求体过大')
    }
    const parsed = entry.schema.safeParse(payload)
    if (!parsed.success) {
      throw new AppError('VALIDATION', '参数校验失败', {
        details: redactValue(parsed.error.issues.slice(0, 20)) as unknown,
        hint: '请刷新界面后重试；若持续出现请反馈问题。'
      })
    }
    const data = await entry.handler(ctx, parsed.data)
    return { ok: true, data }
  } catch (e) {
    const err = toAppError(e)
    return { ok: false, error: err.toPayload() }
  }
}

function safeJsonSize(value: unknown): number {
  if (value === undefined || value === null) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}
