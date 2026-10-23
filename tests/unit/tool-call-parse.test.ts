import { describe, expect, it } from 'vitest'
import {
  extractToolCallsFromContent,
  looksLikeToolMarkupOnly,
  stripToolCallMarkup
} from '@main/ai/tool-call-parse'

describe('extractToolCallsFromContent', () => {
  it('parses OpenAI-ish tool JSON dumped as text', () => {
    const calls = extractToolCallsFromContent(
      JSON.stringify({ tool: 'inspect_schema', tool_input: { database: 'app', table: 'orders' } })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('inspect_schema')
    expect(calls[0].arguments).toEqual({ database: 'app', table: 'orders' })
  })

  it('parses harmony-style channel tool markup', () => {
    const raw = `<|start|>assistant<|channel|>commentary to=tool.run[
"name": "list_databases",
"arguments": {}
]<|call|>`
    const calls = extractToolCallsFromContent(raw)
    expect(calls.some((call) => call.name === 'list_databases')).toBe(true)
    expect(looksLikeToolMarkupOnly(raw)).toBe(true)
    expect(stripToolCallMarkup(raw).length).toBeLessThan(raw.length)
  })

  it('parses bare function-call syntax', () => {
    const calls = extractToolCallsFromContent(
      'run_readonly_query({"sql":"SELECT 1","database":"demo","maxRows":10})'
    )
    expect(calls[0]?.name).toBe('run_readonly_query')
    expect(calls[0]?.arguments.sql).toBe('SELECT 1')
  })
})
