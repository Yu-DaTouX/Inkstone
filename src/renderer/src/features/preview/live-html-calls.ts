import type { UIMessage } from '../../../../shared/ipc'

const HTML_FILE = /\.html?$/i
const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'multiedit', 'str_replace'])

export interface HtmlToolCall {
  id: string
  path: string
  done: boolean
  draft: string | null
  focusText: string | null
  endedAt?: number
}

const RAW_PATH = /"(?:path|file_path|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/
const RAW_CONTENT = /"content"\s*:\s*"/
const JSON_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }

export function partialJsonContent(raw: string): string | null {
  const match = RAW_CONTENT.exec(raw)
  if (!match) return null
  const parts: string[] = []
  let from = match.index + match[0].length
  for (let i = from; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '"') {
      parts.push(raw.slice(from, i))
      return parts.join('')
    }
    if (ch !== '\\') continue
    parts.push(raw.slice(from, i))
    const next = raw[i + 1]
    if (next === undefined) return parts.join('')
    if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return parts.join('')
      parts.push(String.fromCharCode(parseInt(hex, 16)))
      i += 5
    } else {
      parts.push(JSON_ESCAPES[next] ?? next)
      i += 1
    }
    from = i + 1
  }
  parts.push(raw.slice(from))
  return parts.join('')
}

function rawToolPath(argsRaw: string | undefined): string | null {
  const match = argsRaw ? RAW_PATH.exec(argsRaw.slice(0, 600)) : null
  if (!match) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  }
}

function toolPath(args: unknown, argsRaw: string | undefined): string | null {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const raw = [record.path, record.file_path, record.file, rawToolPath(argsRaw)].find((value): value is string => typeof value === 'string' && value.trim() !== '')
  return raw && HTML_FILE.test(raw.trim()) ? raw.trim() : null
}

function writeDraft(name: string, args: unknown, argsRaw: string | undefined): string | null {
  if (name.toLowerCase() !== 'write') return null
  const content = args && typeof args === 'object' ? (args as Record<string, unknown>).content : undefined
  if (typeof content === 'string') return content
  return argsRaw ? partialJsonContent(argsRaw) : null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
const FOCUS_MAX = 40

export function visibleSnippet(source: string): string | null {
  let text = source.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<(script|style)\b[\s\S]*$/i, ' ')
  if (!text.includes('<') && /[{}]/.test(text)) return null
  const firstOpen = text.indexOf('<')
  const firstClose = text.indexOf('>')
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) text = text.slice(firstClose + 1)
  const lastOpen = text.lastIndexOf('<')
  if (lastOpen >= 0 && text.indexOf('>', lastOpen) < 0) text = text.slice(0, lastOpen)
  let best = ''
  for (const part of text.split(/<[^>]*>/)) {
    const clean = part.replace(/&(#39|[a-z]+);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all).replace(/\s+/g, ' ').trim()
    if (clean.length < 2 || /[{}]|^[\s\d.,:;%#()-]+$/.test(clean)) continue
    if (clean.length > best.length) best = clean
  }
  return best ? best.slice(0, FOCUS_MAX).trim() : null
}

function editTexts(args: unknown): string[] {
  if (!args || typeof args !== 'object') return []
  const record = args as Record<string, unknown>
  const own = [record.newText, record.new_string, record.new_str, record.content].filter((value): value is string => typeof value === 'string')
  const edits = Array.isArray(record.edits) ? record.edits : []
  const nested = edits.flatMap((edit) => (edit && typeof edit === 'object' ? editTexts(edit) : []))
  return [...own, ...nested]
}

export function editFocusText(name: string, args: unknown): string | null {
  if (name.toLowerCase() === 'write') return null
  for (const text of editTexts(args)) {
    const snippet = visibleSnippet(text)
    if (snippet) return snippet
  }
  return null
}

export function currentTurnHtmlCalls(messages: readonly UIMessage[]): HtmlToolCall[] {
  let start = messages.length - 1
  while (start >= 0 && messages[start].role !== 'user') start--
  const calls: HtmlToolCall[] = []
  for (let i = start + 1; i < messages.length; i++) {
    for (const call of messages[i].toolCalls ?? []) {
      if (call.parentToolCallId || !WRITE_TOOLS.has(call.name.toLowerCase())) continue
      const path = toolPath(call.args, call.argsRaw)
      if (!path) continue
      calls.push({ id: call.id, path, done: call.status === 'ok', draft: writeDraft(call.name, call.args, call.argsRaw), focusText: editFocusText(call.name, call.args), endedAt: call.endedAt })
    }
  }
  return calls
}

const HTML_START = /<!doctype html|<html[\s>]/gi
const THINKING_DRAFT_MIN = 300
const THINKING_DRAFT_STALE_TAIL = 800
const TEMPLATE_CODE = /\$\{[^}\n]*\}|\{\{[^}\n]*\}\}|<%[\s\S]*?%>/
const QUOTED_START = /[`'"(+=]\s*$/

export function htmlInText(text: string): string | null {
  let start = -1
  for (const match of text.matchAll(HTML_START)) start = match.index ?? start
  if (start < 0) return null
  const doctype = /<!doctype html[^>]*>\s*$/i.exec(text.slice(0, start))
  if (doctype) start = doctype.index
  const rest = text.slice(start)
  const close = rest.search(/<\/html\s*>/i)
  const fence = rest.indexOf('```')
  const ends = [close >= 0 ? rest.indexOf('>', close) + 1 : -1, fence].filter((value) => value > 0)
  const html = ends.length ? rest.slice(0, Math.min(...ends)) : rest
  if (html.length < THINKING_DRAFT_MIN || TEMPLATE_CODE.test(html)) return null
  if (ends.length && text.length - start - html.length > THINKING_DRAFT_STALE_TAIL) return null
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  return QUOTED_START.test(text.slice(lineStart, start)) ? null : html
}

export function thinkingHtmlDraft(messages: readonly UIMessage[]): string | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || !last.thinking) return null
  if ((last.toolCalls ?? []).some((call) => WRITE_TOOLS.has(call.name.toLowerCase()))) return null
  return htmlInText(last.thinking)
}

export function resolveAgainst(cwd: string, path: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) return path
  const base = cwd.replace(/[\\/]+$/, '')
  const sep = base.includes('\\') ? '\\' : '/'
  return base ? `${base}${sep}${path.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)}` : path
}
