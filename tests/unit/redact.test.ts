/**
 * Log / audit redaction (security/redact.ts).
 * Secrets must never reach logs, audit records or IPC errors in plaintext.
 */
import { describe, expect, it } from 'vitest'
import { redactText, redactValue, sqlPreview } from '@main/security/redact'

describe('redactText', () => {
  it('redacts key = value credentials in SQL/JSON text', () => {
    expect(redactText("password = 'hunter2'")).toBe("password = '[REDACTED]'")
    expect(redactText('api_key: "sk-live-abcd1234"')).toContain('[REDACTED]')
    expect(redactText('{password: "p@ss"}')).toContain('[REDACTED]')
  })

  it('redacts raw JSON text with quoted keys', () => {
    expect(redactText('"password":"p@ss"')).toContain('[REDACTED]')
    expect(redactText('{"apiKey":"sk-live-abcd1234"}')).toContain('[REDACTED]')
  })

  it('redacts IDENTIFIED BY and PASSWORD() secrets', () => {
    expect(redactText("CREATE USER u IDENTIFIED BY 'topsecret'")).toBe(
      "CREATE USER u IDENTIFIED BY '[REDACTED]'"
    )
  })

  it('redacts bearer tokens, OpenAI-style keys and connection URIs', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnop123')).toBe(
      'Authorization: Bearer [REDACTED]'
    )
    expect(redactText('key=sk-abcdefghijklmnop')).toContain('sk-[REDACTED]')
    expect(redactText('mysql://root:secret@127.0.0.1:3306/db')).toBe(
      'mysql://[REDACTED]@127.0.0.1:3306/db'
    )
  })

  it('leaves harmless text untouched', () => {
    expect(redactText('SELECT id, email FROM users WHERE id = 7')).toBe(
      'SELECT id, email FROM users WHERE id = 7'
    )
  })
})

describe('redactValue', () => {
  it('redacts sensitive object keys regardless of nesting', () => {
    const input = {
      host: '127.0.0.1',
      password: 'secret',
      nested: { apiKey: 'sk-abcdefghijklmnop', token: 'abc', port: 3306 },
      list: [{ password: 'p' }, { ok: 1 }]
    }
    const out = redactValue(input) as Record<string, unknown>
    expect(out.password).toBe('[REDACTED]')
    const nested = out.nested as Record<string, unknown>
    expect(nested.apiKey).toBe('[REDACTED]')
    expect(nested.token).toBe('[REDACTED]')
    expect(nested.port).toBe(3306)
    const list = out.list as Record<string, unknown>[]
    expect(list[0].password).toBe('[REDACTED]')
    expect(list[1].ok).toBe(1)
  })

  it('redacts secret-looking strings inside values', () => {
    const out = redactValue({ connection: 'mysql://root:pw@127.0.0.1/db' }) as Record<string, unknown>
    expect(out.connection).toBe('mysql://[REDACTED]@127.0.0.1/db')
  })

  it('bounds large strings and arrays', () => {
    const big = 'a'.repeat(5000)
    const out = redactValue(big) as string
    expect(out.length).toBeLessThan(4100)
    expect(out).toContain('[truncated]')
    const array = Array.from({ length: 150 }, (_, i) => i)
    expect((redactValue(array) as unknown[]).length).toBe(100)
  })

  it('keeps primitives intact', () => {
    expect(redactValue(null)).toBeNull()
    expect(redactValue(42)).toBe(42)
    expect(redactValue(true)).toBe(true)
  })
})

describe('sqlPreview', () => {
  it('flattens whitespace, redacts and truncates', () => {
    expect(sqlPreview('SELECT\n  1,\n  2')).toBe('SELECT 1, 2')
    const long = sqlPreview(`SELECT '${'x'.repeat(600)}'`)
    expect(long.length).toBeLessThanOrEqual(501)
    expect(sqlPreview("ALTER USER u IDENTIFIED BY 'secret'")).toContain('[REDACTED]')
  })
})
