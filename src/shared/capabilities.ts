export type CapabilityKind = 'builtin' | 'skill' | 'mcp-tool'

export type CapabilityAvailability =
  | 'ready'
  | 'disabled'
  | 'missing-dependency'
  | 'needs-auth'
  | 'disconnected'
  | 'error'

export type CapabilityEffect = 'read' | 'write' | 'external-action' | 'unknown'

export type CapabilityOwner = 'yan' | 'user' | 'project' | 'package'

export interface CapabilitySource {
  owner: CapabilityOwner
  location: string
}

export interface Capability {
  id: string
  kind: CapabilityKind
  title: string
  description: string
  version?: string
  source: CapabilitySource
  availability: CapabilityAvailability
  effect: CapabilityEffect
  projectScope?: string
  schemaRevision?: string
}

export interface CapabilityQuery {
  queryText: string
  limit?: number
  projectId?: string
}

export interface CapabilityHit {
  capability: Capability
  score: number
  matched: Array<'id' | 'title' | 'description' | 'kind'>
}

export interface CapabilitySearchResult {
  hits: CapabilityHit[]
  considered: number
  reason: string | null
}

const DEFAULT_LIMIT = 12
const MIN_DESCRIPTION_CHARS = 4

export function tokenizeCapabilityQuery(text: string): string[] {
  const out = new Set<string>()
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._/-]*/g)) out.add(m[0])
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length; i++) {
    out.add(cjk[i])
    if (i + 1 < cjk.length) out.add(cjk.slice(i, i + 2))
  }
  return [...out]
}

function scoreAgainst(capability: Capability, tokens: string[]): CapabilityHit | null {
  if (tokens.length === 0) {
    return { capability, score: 0, matched: [] }
  }
  const id = capability.id.toLowerCase()
  const title = capability.title.toLowerCase()
  const description = capability.description.toLowerCase()
  const kind = capability.kind
  let score = 0
  const matched = new Set<CapabilityHit['matched'][number]>()

  for (const token of tokens) {
    if (title === token) {
      score += 12
      matched.add('title')
      continue
    }
    if (title.startsWith(token)) {
      score += 8
      matched.add('title')
      continue
    }
    if (title.includes(token)) {
      score += 5
      matched.add('title')
    }
    if (id.includes(token)) {
      score += 5
      matched.add('id')
    }
    if (description.includes(token)) {
      score += 2
      matched.add('description')
    }
    if (kind === token) {
      score += 1
      matched.add('kind')
    }
  }
  if (score <= 0) return null
  return { capability, score, matched: [...matched] }
}

export function filterCapabilities(
  catalog: readonly Capability[],
  projectId: string | undefined
): Capability[] {
  return catalog.filter((capability) => {
    if (capability.availability === 'disabled') return false
    if (!capability.projectScope) return true
    return Boolean(projectId) && capability.projectScope === projectId
  })
}

export function sortCapabilities(catalog: readonly Capability[]): Capability[] {
  const availabilityRank: Record<CapabilityAvailability, number> = {
    ready: 0,
    'needs-auth': 1,
    'missing-dependency': 2,
    disconnected: 3,
    error: 4,
    disabled: 5
  }
  const kindRank: Record<CapabilityKind, number> = { builtin: 0, skill: 1, 'mcp-tool': 2 }
  return [...catalog].sort((a, b) => {
    const byAvailability = availabilityRank[a.availability] - availabilityRank[b.availability]
    if (byAvailability !== 0) return byAvailability
    const byKind = kindRank[a.kind] - kindRank[b.kind]
    if (byKind !== 0) return byKind
    return a.id.localeCompare(b.id)
  })
}

export function dedupeCapabilities(catalog: readonly Capability[]): {
  capabilities: Capability[]
  conflicts: string[]
} {
  const seen = new Map<string, Capability>()
  const conflicts: string[] = []
  for (const capability of catalog) {
    const existing = seen.get(capability.id)
    if (!existing) {
      seen.set(capability.id, capability)
      continue
    }
    if (existing.source.location !== capability.source.location) {
      conflicts.push(capability.id)
    }
  }
  return { capabilities: [...seen.values()], conflicts: [...new Set(conflicts)] }
}

export function isUsableCapability(capability: Capability): boolean {
  return capability.description.trim().length >= MIN_DESCRIPTION_CHARS
}

export function searchCapabilities(
  catalog: readonly Capability[],
  query: CapabilityQuery
): CapabilitySearchResult {
  const scoped = filterCapabilities(catalog, query.projectId)
  const usable = scoped.filter(isUsableCapability)
  const tokens = tokenizeCapabilityQuery(query.queryText)
  const ranked = sortCapabilities(usable)
    .map((capability) => scoreAgainst(capability, tokens))
    .filter((hit): hit is CapabilityHit => hit !== null)

  if (ranked.length === 0) {
    return {
      hits: [],
      considered: usable.length,
      reason:
        usable.length === 0
          ? '当前项目没有已加载的能力（检查技能目录或安装来源）'
          : `没有匹配「${query.queryText.trim()}」的能力（已检查 ${usable.length} 条）`
    }
  }

  if (tokens.length > 0) {
    ranked.sort((a, b) => (b.score - a.score) || a.capability.id.localeCompare(b.capability.id))
  }
  const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, 100))
  return { hits: ranked.slice(0, limit), considered: usable.length, reason: null }
}

export function skillCapabilityId(name: string): string {
  return `skill:${name.trim().replace(/^skill:/, '')}`
}
