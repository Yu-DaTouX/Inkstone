import { escapeRegExp } from './escape'

const HEAD_KEEP = 100 * 1024
const TAIL_KEEP = 300 * 1024
const MAX_TOKENS = 6
const SNIPPET_RADIUS = 36

function visibleText(line: string): string {
  if (!line.includes('"message"')) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return ''
  }
  const message = (parsed as { message?: { role?: unknown; content?: unknown } } | null)?.message
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string' && text.trim()) parts.push(text)
    }
  }
  return parts.join('\n')
}

export function createSearchTextCollector(): { append(line: string): void; finish(): string } {
  let head = ''
  const tail: string[] = []
  let tailLength = 0
  let length = 0
  return {
    append(line) {
      const text = visibleText(line).replace(/\s+/g, ' ').trim()
      if (!text) return
      const part = `${length ? '\n' : ''}${text}`
      if (head.length < HEAD_KEEP) head += part.slice(0, HEAD_KEEP - head.length)
      tail.push(part)
      tailLength += part.length
      while (tailLength > TAIL_KEEP) {
        const excess = tailLength - TAIL_KEEP
        if (tail[0].length <= excess) tailLength -= tail.shift()!.length
        else { tail[0] = tail[0].slice(excess); tailLength -= excess }
      }
      length += part.length
    },
    finish() {
      const end = tail.join('')
      if (length <= TAIL_KEEP) return end
      if (length <= HEAD_KEEP + TAIL_KEEP) return head + end.slice(HEAD_KEEP + TAIL_KEEP - length)
      return `${head}\n…\n${end}`
    }
  }
}

export function extractSearchText(jsonl: string): string {
  const collector = createSearchTextCollector()
  let offset = 0
  while (offset < jsonl.length) {
    const end = jsonl.indexOf('\n', offset)
    collector.append(jsonl.slice(offset, end < 0 ? undefined : end))
    if (end < 0) break
    offset = end + 1
  }
  return collector.finish()
}

export function queryTokens(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/).filter(Boolean))].slice(0, MAX_TOKENS)
}

export function matchText(text: string, tokens: string[]): { matches: number; snippet: string } | null {
  if (!tokens.length) return null
  let matches = 0
  let first = Number.POSITIVE_INFINITY
  for (const token of tokens) {
    const re = new RegExp(escapeRegExp(token), 'gi')
    let found = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      found += 1
      first = Math.min(first, m.index)
      if (found >= 20) break
    }
    if (!found) return null
    matches += found
  }
  const start = Math.max(0, first - SNIPPET_RADIUS)
  const end = Math.min(text.length, first + SNIPPET_RADIUS * 2)
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return { matches, snippet: `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}` }
}
