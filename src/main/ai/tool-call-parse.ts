/**
 * Fallback parser for models that emit tool calls as plain text
 * instead of OpenAI-compatible `delta.tool_calls`.
 */
import type { ToolCall } from '@shared/types'
import { newId } from '../util/id'

const KNOWN_TOOLS = new Set([
  'list_databases',
  'inspect_schema',
  'search_memory',
  'run_readonly_query',
  'explain_query',
  'propose_sql_change',
  'execute_approved_change',
  'verify_task_result'
])

export function extractToolCallsFromContent(content: string, allowedNames?: Set<string>): ToolCall[] {
  const text = (content ?? '').trim()
  if (!text) return []
  const allow = allowedNames ?? KNOWN_TOOLS
  const found: ToolCall[] = []
  const seen = new Set<string>()

  const push = (name: string, args: Record<string, unknown>): void => {
    const tool = name.trim()
    if (!allow.has(tool)) return
    const key = `${tool}:${stableArgs(args)}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({
      id: newId('call'),
      name: tool,
      arguments: args,
      rawArguments: JSON.stringify(args)
    })
  }

  // {"tool":"inspect_schema","tool_input":{...}}  /  tool_name + arguments
  for (const match of text.matchAll(
    /\{\s*"(?:tool|name|function)"\s*:\s*"([a-zA-Z0-9_]+)"\s*,\s*"(?:tool_input|arguments|parameters|input)"\s*:\s*(\{[\s\S]*?\})\s*\}/g
  )) {
    const args = tryParseObject(match[2])
    if (args) push(match[1], args)
  }

  // OpenAI-ish <tool_call> / invoke blocks
  for (const match of text.matchAll(
    /<(?:tool_call|function_call|tool)\b[^>]*>\s*([\s\S]*?)\s*<\/(?:tool_call|function_call|tool)>/gi
  )) {
    const inner = match[1].trim()
    const asJson = tryParseObject(inner)
    if (asJson && typeof asJson.name === 'string') {
      const args =
        asJson.arguments && typeof asJson.arguments === 'object' && !Array.isArray(asJson.arguments)
          ? (asJson.arguments as Record<string, unknown>)
          : asJson.parameters && typeof asJson.parameters === 'object' && !Array.isArray(asJson.parameters)
            ? (asJson.parameters as Record<string, unknown>)
            : {}
      push(asJson.name, args)
      continue
    }
    const nameMatch = inner.match(/"name"\s*:\s*"([a-zA-Z0-9_]+)"/)
    const argsMatch = inner.match(/"(?:arguments|parameters)"\s*:\s*(\{[\s\S]*\})/)
    if (nameMatch && argsMatch) {
      const args = tryParseObject(argsMatch[1])
      if (args) push(nameMatch[1], args)
    }
  }

  // Harmony / channel style: to=tool.run[ "name": "...", "arguments": {...} ]
  for (const match of text.matchAll(
    /to=tool\.(?:run|call)?\s*\[\s*"name"\s*:\s*"([a-zA-Z0-9_]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\]/gi
  )) {
    const args = tryParseObject(match[2])
    if (args) push(match[1], args)
  }
  for (const match of text.matchAll(
    /to=([a-zA-Z0-9_]+)\s*(?:<\|.*?\|>)?\s*(?:commentary\s*)?(?:json)?\s*(\{[\s\S]*?\})/gi
  )) {
    const maybeTool = match[1]
    if (!allow.has(maybeTool)) continue
    const args = tryParseObject(match[2])
    if (args) push(maybeTool, args)
  }

  // Bare: run_readonly_query({ "sql": "..." })
  for (const match of text.matchAll(/\b([a-zA-Z0-9_]{3,40})\s*\(\s*(\{[\s\S]*?\})\s*\)/g)) {
    if (!allow.has(match[1])) continue
    const args = tryParseObject(match[2])
    if (args) push(match[1], args)
  }

  // Single-table shorthand from models: {"tool":"inspect_schema","tool_input":{"table":"orders"}}
  // already covered; also accept table without database.
  return found.slice(0, 6)
}

/** True when the assistant message is mostly tool markup with little human prose. */
export function looksLikeToolMarkupOnly(content: string): boolean {
  const text = (content ?? '').trim()
  if (!text) return false
  if (/<\|[^|]+\|>/.test(text) && /tool\.|tool_call|list_databases|inspect_schema/.test(text)) return true
  if (/^\s*\{\s*"(?:tool|name)"\s*:/.test(text) && text.length < 800) return true
  if (/<\/?(?:tool_call|function_call)\b/i.test(text) && text.replace(/<[^>]+>/g, '').trim().length < 80) return true
  return false
}

export function stripToolCallMarkup(content: string): string {
  let text = content ?? ''
  text = text.replace(/<\|[^|]*\|>/g, ' ')
  text = text.replace(/<\/?(?:tool_call|function_call|tool)\b[^>]*>[\s\S]*?<\/(?:tool_call|function_call|tool)>/gi, ' ')
  text = text.replace(/to=tool\.[^\n]*/gi, ' ')
  text = text.replace(/\{\s*"(?:tool|name|function)"\s*:\s*"[a-zA-Z0-9_]+"[\s\S]*?\}\s*/g, ' ')
  return text.replace(/\s{2,}/g, ' ').trim()
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // try to balance braces for truncated fragments
    let depth = 0
    let end = -1
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end > 0) {
      try {
        const parsed = JSON.parse(trimmed.slice(0, end + 1)) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      } catch {
        return null
      }
    }
  }
  return null
}

function stableArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args)
  } catch {
    return String(Object.keys(args).sort())
  }
}
