import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const shortId = () => randomBytes(4).toString('hex')
const ms = (iso) => Date.parse(iso)

function blankUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function writer({ cwd, title, provider, model, startedAt }) {
  const sessionId = randomUUID()
  const entries = [{ type: 'session', version: 3, id: sessionId, timestamp: startedAt, cwd }]
  let parentId = null
  const push = (entry) => {
    const id = shortId()
    entries.push({ ...entry, id, parentId })
    parentId = id
  }
  push({ type: 'model_change', timestamp: startedAt, provider, modelId: model })
  return {
    sessionId,
    user(text, timestamp) {
      push({ type: 'message', timestamp, message: { role: 'user', content: [{ type: 'text', text }], timestamp: ms(timestamp) } })
    },
    assistant(content, timestamp, stopReason) {
      push({ type: 'message', timestamp, message: { role: 'assistant', content, api: 'openai-responses', provider, model, usage: blankUsage(), stopReason, timestamp: ms(timestamp) } })
    },
    toolResult(toolCallId, toolName, text, isError, timestamp) {
      push({ type: 'message', timestamp, message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError, timestamp: ms(timestamp) } })
    },
    finish() {
      push({ type: 'session_info', timestamp: entries[entries.length - 1].timestamp, name: title })
      return { sessionId, startedAt, lines: entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n' }
    }
  }
}

function jsonl(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function outputText(output) {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map((part) => part.text ?? '').join('')
  return JSON.stringify(output ?? '')
}

export function codexToPi(file, { title }) {
  const rows = jsonl(file)
  const meta = rows.find((row) => row.type === 'session_meta')?.payload ?? {}
  const model = rows.find((row) => row.type === 'turn_context')?.payload?.model ?? 'gpt'
  const out = writer({ cwd: meta.cwd ?? 'E:\\', title, provider: 'openai-codex', model, startedAt: meta.timestamp ?? rows[0].timestamp })
  const names = new Map()
  for (const row of rows) {
    const p = row.payload ?? {}
    if (row.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage') {
      out.user(p.item.content.map((part) => part.text ?? '').join(''), row.timestamp)
    } else if (row.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
      const text = p.content.map((part) => part.text ?? '').join('')
      if (text.trim()) out.assistant([{ type: 'text', text }], row.timestamp, 'stop')
    } else if (row.type === 'response_item' && (p.type === 'custom_tool_call' || p.type === 'function_call')) {
      const name = p.name === 'exec' ? 'codemode' : p.name
      names.set(p.call_id, name)
      const args = p.type === 'custom_tool_call' ? { code: p.input } : safeJson(p.arguments)
      out.assistant([{ type: 'toolCall', id: p.call_id, name, arguments: args }], row.timestamp, 'toolUse')
    } else if (row.type === 'response_item' && (p.type === 'custom_tool_call_output' || p.type === 'function_call_output')) {
      out.toolResult(p.call_id, names.get(p.call_id) ?? 'tool', outputText(p.output), false, row.timestamp)
    }
  }
  return out.finish()
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { input: text }
  }
}

const CLAUDE_TOOLS = {
  Bash: (input) => ['bash', { command: input.command }],
  Read: (input) => ['read', { path: input.file_path, ...(input.offset ? { offset: input.offset } : {}), ...(input.limit ? { limit: input.limit } : {}) }],
  Write: (input) => ['write', { path: input.file_path, content: input.content }],
  Edit: (input) => ['edit', { path: input.file_path, edits: [{ oldText: input.old_string, newText: input.new_string }] }]
}

export function claudeToPi(file, { title }) {
  const rows = jsonl(file).filter((row) => !row.isSidechain && (row.type === 'user' || row.type === 'assistant'))
  const first = rows[0]
  const model = rows.find((row) => row.type === 'assistant')?.message?.model ?? 'claude'
  const relocated = jsonl(file).filter((row) => row.type === 'relocated').pop()?.relocatedCwd
  const out = writer({ cwd: relocated ?? first?.cwd ?? 'E:\\', title, provider: 'anthropic', model, startedAt: first?.timestamp })
  const names = new Map()
  let pending = null
  const flush = () => {
    if (!pending) return
    out.assistant(pending.content, pending.timestamp, pending.content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop')
    pending = null
  }
  for (const row of rows) {
    const content = row.message?.content
    if (row.type === 'assistant') {
      const parts = []
      for (const part of Array.isArray(content) ? content : []) {
        if (part.type === 'text' && part.text.trim()) parts.push({ type: 'text', text: part.text })
        else if (part.type === 'thinking' && part.thinking?.trim()) parts.push({ type: 'thinking', thinking: part.thinking })
        else if (part.type === 'tool_use') {
          const [name, args] = CLAUDE_TOOLS[part.name]?.(part.input ?? {}) ?? [part.name, part.input ?? {}]
          names.set(part.id, name)
          parts.push({ type: 'toolCall', id: part.id, name, arguments: args })
        }
      }
      if (!parts.length) continue
      if (pending && pending.messageId === row.message.id) pending.content.push(...parts)
      else {
        flush()
        pending = { messageId: row.message.id, content: parts, timestamp: row.timestamp }
      }
      continue
    }
    flush()
    if (typeof content === 'string') {
      if (!content.startsWith('<')) out.user(content, row.timestamp)
      continue
    }
    const results = (content ?? []).filter((part) => part.type === 'tool_result')
    for (const result of results) out.toolResult(result.tool_use_id, names.get(result.tool_use_id) ?? 'tool', outputText(result.content), result.is_error === true, row.timestamp)
    const text = (content ?? []).filter((part) => part.type === 'text' && !part.text.startsWith('<') && !part.text.startsWith('[Image:')).map((part) => part.text).join('\n')
    if (!results.length && text.trim()) out.user(text, row.timestamp)
  }
  flush()
  return out.finish()
}
