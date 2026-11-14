export const CONTEXT_USAGE_STATUS_KEY = 'inkstone_context_usage'

export const SYSTEM_PART_IDS = ['prompt', 'builtin', 'mcp', 'skills', 'mcpInfo', 'memory'] as const
export type SystemPartId = (typeof SYSTEM_PART_IDS)[number]

export interface ContextSourceItem { name: string; tokens: number; deferred?: boolean }

export interface ContextSources {
  parts: Record<SystemPartId, number>
  deferred: { builtin: number; mcp: number }
  mcpTools: ContextSourceItem[]
  memoryFiles: ContextSourceItem[]
  skills: ContextSourceItem[]
  builtinTools: ContextSourceItem[]
  mcpServers: ContextSourceItem[]
}

const parsed = new Map<string, ContextSources | null>()

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

function items(value: unknown): ContextSourceItem[] {
  if (!Array.isArray(value)) return []
  const out: ContextSourceItem[] = []
  for (const row of value) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0]) continue
    out.push(row[2] ? { name: row[0], tokens: count(row[1]), deferred: true } : { name: row[0], tokens: count(row[1]) })
  }
  return out
}

export function parseContextSources(text: string | undefined): ContextSources | null {
  if (!text) return null
  if (parsed.has(text)) return parsed.get(text) ?? null
  let result: ContextSources | null = null
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    if (raw && raw.v === 1) {
      const deferred = (raw.deferred ?? {}) as Record<string, unknown>
      result = {
        parts: Object.fromEntries(SYSTEM_PART_IDS.map((id) => [id, count(raw[id])])) as Record<SystemPartId, number>,
        deferred: { builtin: count(deferred.builtin), mcp: count(deferred.mcp) },
        mcpTools: items(raw.mcpTools),
        memoryFiles: items(raw.memoryFiles),
        skills: items(raw.skillList),
        builtinTools: items(raw.builtinTools),
        mcpServers: items(raw.mcpServers)
      }
    }
  } catch {
    result = null
  }
  if (parsed.size > 16) parsed.clear()
  parsed.set(text, result)
  return result
}

export type SourceListId = 'builtin' | 'mcp' | 'skills' | 'mcpInfo' | 'memory' | 'deferredMcp' | 'deferredBuiltin'

export function sourceItems(sources: ContextSources | null | undefined, id: string): ContextSourceItem[] {
  if (!sources) return []
  switch (id) {
    case 'builtin': return sources.builtinTools.filter((item) => !item.deferred)
    case 'mcp': return sources.mcpTools.filter((item) => !item.deferred)
    case 'deferredBuiltin': return sources.builtinTools.filter((item) => item.deferred)
    case 'deferredMcp': return sources.mcpTools.filter((item) => item.deferred)
    case 'skills': return sources.skills
    case 'mcpInfo': return sources.mcpServers
    case 'memory': return sources.memoryFiles
    default: return []
  }
}

export function scaledSourceItems(sources: ContextSources | null | undefined, id: string, shownTokens: number): ContextSourceItem[] {
  const items = sourceItems(sources, id)
  const estimate = sources && (SYSTEM_PART_IDS as readonly string[]).includes(id) ? sources.parts[id as SystemPartId] : 0
  if (!items.length || estimate <= 0 || shownTokens <= 0 || shownTokens === estimate) return items
  const factor = shownTokens / estimate
  return items.map((item) => ({ ...item, tokens: Math.round(item.tokens * factor) }))
}

export function sourceItemLabel(name: string, id: string): string {
  if (id === 'memory') return name.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || name
  if (id === 'mcp' || id === 'deferredMcp' || id === 'mcpInfo') return name.replace(/^mcp__/i, '').split('__').filter(Boolean).join(' › ') || name
  return name
}

export function sourcesTotal(sources: ContextSources | null | undefined): number {
  return sources ? SYSTEM_PART_IDS.reduce((sum, id) => sum + sources.parts[id], 0) : 0
}

export function scaleParts<K extends string>(parts: ReadonlyArray<{ id: K; tokens: number }>, total: number): Array<{ id: K; tokens: number }> {
  const sum = parts.reduce((n, p) => n + p.tokens, 0)
  if (sum <= 0 || total <= 0) return parts.map((p) => ({ id: p.id, tokens: 0 }))
  const exact = parts.map((p) => (p.tokens * total) / sum)
  const out = exact.map((value, index) => ({ id: parts[index].id, tokens: Math.floor(value) }))
  let rest = total - out.reduce((n, p) => n + p.tokens, 0)
  const order = exact.map((value, index) => ({ index, frac: value - Math.floor(value) })).sort((a, b) => b.frac - a.frac)
  for (let i = 0; rest > 0 && order.length; i = (i + 1) % order.length, rest -= 1) out[order[i].index].tokens += 1
  return out
}

export function splitSystem(
  systemTokens: number,
  sources: ContextSources | null | undefined,
  compacted: boolean
): Array<{ id: SystemPartId | 'summary'; tokens: number }> | null {
  const estimate = sourcesTotal(sources)
  if (!sources || estimate <= 0 || systemTokens <= 0) return null
  const parts = SYSTEM_PART_IDS.map((id) => ({ id, tokens: sources.parts[id] }))
  if (compacted && systemTokens > estimate) return [...parts, { id: 'summary' as const, tokens: systemTokens - estimate }]
  return scaleParts(parts, systemTokens)
}
