/**
 * Redaction helpers. Every log line, audit record and IPC error passes through
 * here so database passwords, API keys and bearer tokens never reach disk.
 */

const SENSITIVE_KEY = /^(password|passwd|pwd|secret|api[_-]?key|apikey|token|authorization|credential|cookie)$/i

const STRING_RULES: { re: RegExp; replace: (m: string, ...groups: string[]) => string }[] = [
  // JSON / object payload text: {"password":"secret"} or {"apiKey": "sk-..."}
  {
    re: /("(?:password|passwd|pwd|api[_-]?key|apiKey|secret|token|authorization)"\s*:\s*")([^"]{0,512})(")/gi,
    replace: (_m, prefix: string, _value: string, suffix: string) => `${prefix}[REDACTED]${suffix}`
  },
  // key = "value" / key: 'value' inside SQL or free text
  {
    re: /(\b(?:password|passwd|pwd|api[_-]?key|apiKey|secret|token|authorization)\b\s*[:=]\s*)(['"])([^'"]{0,512})\2/gi,
    replace: (_m, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`
  },
  // IDENTIFIED BY 'secret' / PASSWORD('secret')
  {
    re: /(\bIDENTIFIED\s+BY\s+)(['"])([^'"]{0,512})\2/gi,
    replace: (_m, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`
  },
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/g, replace: () => 'Bearer [REDACTED]' },
  { re: /\bsk-[A-Za-z0-9]{12,}/g, replace: () => 'sk-[REDACTED]' },
  { re: /\bmysql:\/\/[^@\s]+@/gi, replace: () => 'mysql://[REDACTED]@' }
]

export function redactText(input: string): string {
  let out = input
  for (const rule of STRING_RULES) {
    out = out.replace(rule.re, rule.replace as never)
  }
  return out
}

/** Deep redaction for structured payloads (audit metadata, error details). */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const r = redactText(value)
    return r.length > 4000 ? `${r.slice(0, 4000)}…[truncated]` : r
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactValue(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v, depth + 1)
    }
    return out
  }
  return String(value)
}

/** SQL preview for logs / history (single line, bounded). */
export function sqlPreview(sql: string, maxLength = 500): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  const redacted = redactText(oneLine)
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted
}
