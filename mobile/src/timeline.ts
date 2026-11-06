import { pick } from '../../src/shared/ui-lang'
import type { HistoryMessage } from './api/client'

export type ImageRef = { messageId: string; index: number }
export type ToolStep = { id: string; name: string; failed: boolean; denied: boolean; running: boolean; awaiting: boolean; summary: string; output: string; nested: boolean; images: ImageRef[] }
export type ProcessStep =
  | { kind: 'text'; key: string; message: HistoryMessage }
  | { kind: 'thinking'; key: string; text: string; ms?: number }
  | { kind: 'tool'; key: string; tool: ToolStep }
export type TimelineEntry =
  | { kind: 'message'; key: string; message: HistoryMessage; sources: readonly HistoryMessage[] }
  | { kind: 'process'; key: string; sources: readonly HistoryMessage[]; steps: ProcessStep[]; actions: number; thinking: number; failed: number; images: number; ms?: number }

export const SHOWN_ROLES = new Set(['user', 'assistant', 'bash'])

export const UNCOUNTED_TOOLS = new Set(['todo', 'todos', 'todo_write', 'update_todos'])
export const LIVE_STEPS = 3
export const ARG_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description', 'task', 'prompt', 'question']

export function argSummary(args: unknown): string {
  if (typeof args === 'string') return args.split('\n')[0].slice(0, 160)
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  const key = ARG_KEYS.find((name) => typeof record[name] === 'string' && record[name])
  const text = key ? String(record[key]) : JSON.stringify(args)
  return text.split('\n')[0].slice(0, 160)
}

export const SUBAGENT_NOTICE_RE = /^<subagent-notification id="[^"]+" status="[^"]+">/
export const isSubagentNotice = (message: HistoryMessage) => message.role === 'user' && SUBAGENT_NOTICE_RE.test(message.text?.trimStart() ?? '')

export const hasReply = (message: HistoryMessage) => !!(message.text?.trim() || message.error || message.artifacts?.length)

export function makeTimeline(messages: HistoryMessage[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let turn: HistoryMessage[] = []
  const flushTurn = () => {
    if (!turn.length) return
    let replyIndex = -1
    turn.forEach((message, index) => { if (hasReply(message)) replyIndex = index })
    const steps: ProcessStep[] = []
    const tools = new Map<string, ToolStep>()
    let first = Infinity
    let last = 0
    turn.forEach((message, index) => {
      if (message.thinking?.trim()) steps.push({ kind: 'thinking', key: `thinking-${message.id}`, text: message.thinking.trim(), ms: message.thinkingMs })
      if (index !== replyIndex && hasReply(message)) steps.push({ kind: 'text', key: `text-${message.id}`, message })
      for (const [toolIndex, tool] of (message.toolCalls ?? []).entries()) {
        if (tool.startedAt) first = Math.min(first, tool.startedAt)
        if (tool.endedAt) last = Math.max(last, tool.endedAt)
        const key = tool.id || `${message.id}:${toolIndex}`
        const old = tools.get(key)
        const denied = tool.denied === true || !!old?.denied
        const next: ToolStep = {
          id: key,
          name: tool.name || old?.name || pick('工具', 'Tool'),
          failed: (tool.status === 'error' && !denied) || !!old?.failed,
          denied,
          running: tool.status === 'running' || tool.status === 'pending',
          awaiting: tool.output === undefined && old?.output === undefined,
          summary: argSummary(tool.args) || old?.summary || '',
          output: tool.output ?? old?.output ?? '',
          nested: !!tool.parentToolCallId,
          images: tool.imageIndexes?.length ? tool.imageIndexes.map((index) => ({ messageId: message.id, index })) : old?.images ?? []
        }
        if (old) Object.assign(old, next)
        else {
          tools.set(key, next)
          steps.push({ kind: 'tool', key: `tool-${key}`, tool: next })
        }
      }
    })
    const counted = [...tools.values()].filter((tool) => !tool.nested && !(UNCOUNTED_TOOLS.has(tool.name) && !tool.failed))
    const thinking = steps.filter((step) => step.kind === 'thinking').length
    if (counted.length || thinking) {
      entries.push({ kind: 'process', key: `process-${turn[0].id}`, sources: turn, steps, actions: counted.length, thinking, failed: counted.filter((tool) => tool.failed).length, images: [...tools.values()].reduce((sum, tool) => sum + tool.images.length, 0), ms: last > first ? last - first : undefined })
    } else {
      for (const step of steps) if (step.kind === 'text') entries.push({ kind: 'message', key: step.message.id, message: step.message, sources: [step.message] })
    }
    if (replyIndex >= 0) entries.push({ kind: 'message', key: turn[replyIndex].id, message: turn[replyIndex], sources: [turn[replyIndex]] })
    turn = []
  }
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'bash') {
      flushTurn()
      if (!isSubagentNotice(message)) entries.push({ kind: 'message', key: message.id, message, sources: [message] })
    } else turn.push(message)
  }
  flushTurn()
  return entries
}

export function liveProcessKey(timeline: TimelineEntry[], running: boolean): string | null {
  if (!running) return null
  for (let index = timeline.length - 1; index >= 0; index--) {
    const entry = timeline[index]
    if (entry.kind === 'process') return entry.key
    if (entry.message.role !== 'assistant') return null
  }
  return null
}

export function reuseMessages(previous: readonly HistoryMessage[], next: HistoryMessage[]): HistoryMessage[] {
  if (!previous.length) return next
  const byId = new Map<string, HistoryMessage>()
  for (const message of previous) byId.set(message.id, message)
  let changed = previous.length !== next.length
  const out = next.map((message, index) => {
    const old = byId.get(message.id)
    const same = old !== undefined && (old === message || JSON.stringify(old) === JSON.stringify(message))
    if (!same || previous[index] !== old) changed = true
    return same ? old : message
  })
  return changed ? out : (previous as HistoryMessage[])
}

export function stabilizeTimeline(previous: readonly TimelineEntry[], next: TimelineEntry[]): TimelineEntry[] {
  if (!previous.length) return next
  const byKey = new Map<string, TimelineEntry>()
  for (const entry of previous) byKey.set(entry.key, entry)
  let changed = previous.length !== next.length
  const out = next.map((entry, index) => {
    const old = byKey.get(entry.key)
    const same = old !== undefined && old.kind === entry.kind && old.sources.length === entry.sources.length && old.sources.every((source, at) => source === entry.sources[at])
    if (!same || previous[index] !== old) changed = true
    return same ? old : entry
  })
  return changed ? out : (previous as TimelineEntry[])
}
