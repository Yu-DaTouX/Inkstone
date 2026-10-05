/**
 * 会话正文检索的纯文字逻辑（主进程的索引与单测共用）：
 * 从一份 pi JSONL 里取出可见对话文字，把查询拆成词，并在文字里找片段。
 */

const HEAD_KEEP = 100 * 1024
const TAIL_KEEP = 300 * 1024
const MAX_TOKENS = 6
const SNIPPET_RADIUS = 36

/** 一行 JSONL 里的可见文字；不是用户 / 助手的消息就返回空串 */
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

/** 把整份 JSONL 压成「一条消息一行」的纯文字，再按头尾配额截断 */
export function extractSearchText(jsonl: string): string {
  const lines: string[] = []
  for (const line of jsonl.split('\n')) {
    const text = visibleText(line)
    if (text) lines.push(text.replace(/\s+/g, ' ').trim())
  }
  const joined = lines.join('\n')
  if (joined.length <= HEAD_KEEP + TAIL_KEEP) return joined
  return `${joined.slice(0, HEAD_KEEP)}\n…\n${joined.slice(joined.length - TAIL_KEEP)}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把查询拆成词（空白分隔），去重、限量 */
export function queryTokens(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/).filter(Boolean))].slice(0, MAX_TOKENS)
}

/** 在一份文字里找所有词（不区分大小写）；任何一个词不出现就不是命中 */
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
