import type { Usage, UIMessage, UIMessageImage, UIToolCall } from '../shared/ipc'
import { modelErrorNotice } from '../shared/model-errors'
import { assistantModelIdentity } from '../shared/assistant-model'
import { estimateCost } from '../shared/model-pricing'

export interface PiContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
  data?: string
  mimeType?: string
}

export interface PiMessage {
  role: string
  content?: string | PiContentBlock[]
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    totalTokens?: number
    reasoning?: number
    cost?: { total?: number }
  }
  model?: string
  provider?: string
  stopReason?: string
  errorMessage?: string
  timestamp?: number
  toolCallId?: string
  toolName?: string
  isError?: boolean
  command?: string
  exitCode?: number | null
  cancelled?: boolean
  details?: unknown
  nestedCalls?: { calls?: unknown[]; complete?: boolean }
  customType?: string
  display?: boolean
  summary?: string
}

export function assistantError(m: PiMessage): string | undefined {
  return m.stopReason === 'error' ? modelErrorNotice(m.errorMessage) : undefined
}

export function toUsage(u: PiMessage['usage'], model?: string): Usage | undefined {
  if (!u) return undefined
  const usage: Usage = {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens:
      u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
    cost: u.cost?.total ?? 0,
    ...(typeof u.reasoning === 'number' && u.reasoning > 0 ? { reasoning: u.reasoning } : {})
  }
  if (usage.cost > 0 || !model) return usage
  const estimate = estimateCost(model, usage)
  return estimate && estimate > 0 ? { ...usage, cost: estimate, costEstimated: true } : usage
}

export function imagesOf(
  content: unknown,
  localizeImage?: (mimeType: string, data: string) => string
): UIMessageImage[] | undefined {
  if (!Array.isArray(content)) return undefined
  const out: UIMessageImage[] = []
  for (const c of content as PiContentBlock[]) {
    if (c?.type !== 'image') continue
    const mimeType = c.mimeType ?? 'image/png'
    const url = localizeImage && c.data ? localizeImage(mimeType, c.data) : ''
    out.push(url ? { mimeType, data: '', url } : { mimeType, data: c.data ?? '' })
  }
  return out.length ? out : undefined
}

const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/

export function collapseSkillInvocation(text: string): string {
  const match = SKILL_BLOCK.exec(text)
  if (!match) return text
  const args = match[2]?.trim()
  return args ? `/skill:${match[1]} ${args}` : `/skill:${match[1]}`
}

export function normalizeMessage(
  m: PiMessage,
  idx: number,
  localizeImage?: (mimeType: string, data: string) => string,
  entryId?: string
): UIMessage | null {
  const id = `m${idx}`
  const entry = entryId ? { entryId } : {}

  if (m.role === 'user') {
    let text = ''

    if (typeof m.content === 'string') {
      text = m.content
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'text') text += c.text ?? ''
      }
    }

    text = collapseSkillInvocation(text)
    return {
      id,
      ...entry,
      role: 'user',
      text,
      images: imagesOf(m.content, localizeImage),
      timestamp: m.timestamp
    }
  }

  if (m.role === 'assistant') {
    const blocks = Array.isArray(m.content) ? m.content : []
    const text = blocks
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    const thinking = blocks
      .filter((c) => c.type === 'thinking')
      .map((c) => c.thinking ?? '')
      .join('')

    const toolCalls: UIToolCall[] = blocks
      .filter((c) => c.type === 'toolCall' && c.id)
      .map((c) => ({
        id: c.id!,
        name: c.name ?? 'unknown',
        args: c.arguments,
        status: 'ok' as const
      }))

    return {
      id,
      ...entry,
      role: 'assistant',
      text,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: toUsage(m.usage, m.model),
      model: assistantModelIdentity(m),
      responseDetail: 'unknown',
      timestamp: m.timestamp,
      error: assistantError(m)
    }
  }

  if (m.role === 'toolResult') {
    const images = imagesOf(m.content, localizeImage)
    return {
      id,
      ...entry,
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          id: m.toolCallId ?? id,
          name: m.toolName ?? 'tool',
          args: undefined,
          details: m.details,
          status: m.isError && !m.cancelled ? 'error' : 'ok',
          ...(m.cancelled ? { cancelled: true } : {}),
          output: Array.isArray(m.content)
            ? m.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('')
            : typeof m.content === 'string'
              ? m.content
              : '',
          ...(images ? { images } : {})
        }
      ],
      timestamp: m.timestamp
    }
  }

  if (m.role === 'bashExecution') {
    return {
      id,
      ...entry,
      role: 'bash',
      text: m.command ?? '',
      bash: {
        command: m.command ?? '',
        exitCode: m.exitCode ?? null,
        cancelled: !!m.cancelled
      },
      toolCalls: [
        {
          id,
          name: 'bash',
          args: { command: m.command },
          status: m.exitCode === 0 || m.cancelled ? 'ok' : 'error',
          ...(m.cancelled ? { cancelled: true } : {}),
          output: m.content as string | undefined
        }
      ],
      timestamp: m.timestamp
    }
  }

  if (m.role === 'custom' && m.display === true) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') : ''
    const images = imagesOf(m.content, localizeImage)
    if (!text.trim() && !images) return null
    return {
      id,
      ...entry,
      role: 'note',
      note: { kind: 'custom', ...(m.customType ? { customType: m.customType } : {}) },
      text,
      ...(images ? { images } : {}),
      timestamp: m.timestamp
    }
  }

  if (m.role === 'branchSummary' && typeof m.summary === 'string' && m.summary.trim()) {
    return { id, ...entry, role: 'note', note: { kind: 'branchSummary' }, text: m.summary, timestamp: m.timestamp }
  }

  return null
}

export function entryMessage(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  if (e.message && typeof e.message === 'object') return e.message
  const timestamp = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || undefined : undefined
  if (e.type === 'custom_message') {
    return { role: 'custom', customType: e.customType, content: e.content, display: e.display === true, timestamp }
  }
  if (e.type === 'branch_summary') {
    return { role: 'branchSummary', summary: e.summary, fromId: e.fromId ?? null, timestamp }
  }
  return null
}

export function createHistoryBuilder(localizeImage?: (mimeType: string, data: string) => string) {
  const out: UIMessage[] = []
  const callIndex = new Map<string, { msg: UIMessage; call: UIToolCall }>()

  let seq = 0
  const append = (raw: unknown, entryId?: string): void => {
    const m = raw as PiMessage
    if (m?.role === 'system') return
    const norm = normalizeMessage(m, seq, localizeImage, entryId)
    if (!norm) return

    if (m.role === 'toolResult') {
      const hit = norm.toolCalls?.[0] ? callIndex.get(norm.toolCalls[0].id) : undefined
      if (hit) {
        hit.call.status = norm.toolCalls![0].status
        hit.call.output = norm.toolCalls![0].output
        hit.call.cancelled = norm.toolCalls![0].cancelled
        hit.call.details = norm.toolCalls![0].details
        const images = norm.toolCalls![0].images
        if (images?.length) hit.call.images = images
        restoreNestedCalls(m, hit.msg, hit.call, callIndex)
        return
      }
    }

    seq += 1
    for (const c of norm.toolCalls ?? []) {
      callIndex.set(c.id, { msg: norm, call: c })
    }
    out.push(norm)
    if (m.role === 'toolResult' && norm.toolCalls?.[0]) {
      restoreNestedCalls(m, norm, norm.toolCalls[0], callIndex)
    }
  }

  return { append, finish: (): UIMessage[] => out }
}

export function normalizeHistory(
  raw: unknown[],
  localizeImage?: (mimeType: string, data: string) => string,
  entryIds?: (string | undefined)[]
): UIMessage[] {
  const builder = createHistoryBuilder(localizeImage)
  for (let i = 0; i < raw.length; i++) builder.append(raw[i], entryIds?.[i])
  return builder.finish()
}

function restoreNestedCalls(
  result: PiMessage,
  message: UIMessage,
  parent: UIToolCall,
  index: Map<string, { msg: UIMessage; call: UIToolCall }>
): void {
  if (!Array.isArray(result.nestedCalls?.calls)) return
  parent.nestedCallsIncomplete = result.nestedCalls.complete === false || result.nestedCalls.calls.length > 256 || undefined
  for (const raw of result.nestedCalls.calls.slice(0, 256)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.id !== 'string' || !entry.id.startsWith(`${parent.id}/`) ||
        typeof entry.name !== 'string' || !['ok', 'error', 'unfinished'].includes(String(entry.status)) || index.has(entry.id)) continue
    const caller = entry.id.slice(0, entry.id.lastIndexOf('/'))
    const call: UIToolCall = {
      id: entry.id,
      parentToolCallId: index.has(caller) ? caller : parent.id,
      name: entry.name,
      args: entry.arguments,
      status: entry.status === 'error' ? 'error' : 'ok',
      historySummary: true,
      incomplete: entry.status === 'unfinished' || undefined,
      output: typeof entry.error === 'string' ? entry.error : undefined
    }
    ;(message.toolCalls ??= []).push(call)
    index.set(call.id, { msg: message, call })
  }
}
