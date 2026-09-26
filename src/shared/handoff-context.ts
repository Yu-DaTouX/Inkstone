/** Bounded evidence from the active JSONL ancestry, excluding sibling branches and image/thinking data. */
export function handoffHistoryExcerpt(raw: string): string {
  const entries = new Map<string, Record<string, unknown>>()
  let head: string | null = null
  let skipped = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry.id === 'string' && entry.type !== 'session') {
        entries.set(entry.id, entry)
        head = entry.id
      }
    } catch { skipped++ }
  }
  const branch: Record<string, unknown>[] = []
  const seen = new Set<string>()
  while (head && entries.has(head) && !seen.has(head)) {
    seen.add(head)
    const entry = entries.get(head)!
    branch.push(entry)
    head = typeof entry.parentId === 'string' ? entry.parentId : null
  }
  branch.reverse()
  const messages = branch.filter(e => e.type === 'message')
  const first = messages.find(e => (e.message as { role?: string })?.role === 'user')
  const summary = branch.filter(e => e.type === 'compaction').at(-1)
  const prefix = [first, summary].filter((e): e is Record<string, unknown> => !!e)
  const render = (e: Record<string, unknown>, limit: number): string => {
    const m = e.message as { role?: string; toolName?: string; content?: unknown } | undefined
    const content = e.type === 'compaction' ? e.summary : m?.content
    const body = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map(b => b.type === 'text' ? b.text : b.type === 'toolCall'
        ? JSON.stringify({ tool: b.name, arguments: b.arguments }) : '').filter(Boolean).join('\n') : ''
    return JSON.stringify({ entryId: e.id, role: m?.role ?? e.type, tool: m?.toolName,
      text: body.slice(0, limit), truncated: body.length > limit })
  }
  const blocks = prefix.map(e => render(e, 8000))
  let budget = 48000 - blocks.join('\n').length
  const tail: string[] = []
  for (const e of messages.slice(-30).reverse()) {
    if (prefix.includes(e)) continue
    const block = render(e, 2400)
    if (block.length > budget) break
    tail.unshift(block)
    budget -= block.length + 1
  }
  return `当前分支节选：共 ${messages.length} 条消息，坏行 ${skipped}；不是完整历史，可回来源会话读原文。\n${[...blocks, ...tail].join('\n')}`
}

/** Only new generations use this stricter gate; existing stored packages remain readable. */
export function handoffContinuationProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'missing-content-fields'
  const value = raw as Record<string, unknown>
  for (const field of ['constraints', 'acceptance', 'done', 'remaining', 'nextActions', 'blockers', 'files', 'notes']) {
    if (!Array.isArray(value[field]) || !(value[field] as unknown[]).every(v => typeof v === 'string'))
      return 'missing-content-fields'
  }
  for (const field of ['remaining', 'nextActions']) {
    if (!(value[field] as string[]).some(v => v.trim())) return 'missing-continuation'
  }
  return null
}
