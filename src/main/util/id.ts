import { randomUUID, createHash } from 'node:crypto'

/** Short, sortable-ish unique id with a human readable prefix. */
export function newId(prefix = 'id'): string {
  const ts = Date.now().toString(36)
  const rand = randomUUID().replace(/-/g, '').slice(0, 12)
  return `${prefix}_${ts}${rand}`
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function shortHash(input: string, length = 12): string {
  return sha256Hex(input).slice(0, length)
}
