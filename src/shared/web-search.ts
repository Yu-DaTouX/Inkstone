import type { Capability } from './capabilities'

export interface WebSearchAvailability {
  available: boolean
  capabilityId?: string
  title?: string
  location?: string
  owner?: string
}

const NAME_PATTERNS: readonly RegExp[] = [
  /\bweb[\s_-]*search\b/i,
  /\bsearch[\s_-]*web\b/i,
  /\binternet[\s_-]*search\b/i,
  /\bsearch[\s_-]*internet\b/i,
  /\bsearch[\s_-]*web[\s_-]*pages?\b/i,
  /联网搜索|网页搜索|网络搜索|在线搜索|互联网搜索/
]

const PROVIDERS = /\b(tavily|brave|serper|serpapi|exa|duckduckgo|bing|google|perplexity|searxng|kagi)\b/i

export function isWebSearchCapability(capability: Capability): boolean {
  if (capability.kind === 'builtin') return false
  const name = `${capability.title} ${capability.id} ${capability.source.location}`
  if (NAME_PATTERNS.some((re) => re.test(name))) return true
  if (PROVIDERS.test(name) && /search|搜索|检索/i.test(name)) return true
  const described = capability.description ?? ''
  if (/search|搜索|检索/i.test(described) && /web|internet|联网|网页|在线/i.test(described)) return true
  return false
}

export function pickWebSearchCapability(capabilities: readonly Capability[]): Capability | undefined {
  const hits = capabilities.filter(isWebSearchCapability)
  if (hits.length === 0) return undefined
  const score = (capability: Capability): number => {
    let value = 0
    if (capability.availability === 'ready') value += 2
    if (capability.kind === 'mcp-tool') value += 1
    return value
  }
  return [...hits].sort((a, b) => score(b) - score(a))[0]
}

export function webSearchAvailability(capabilities: readonly Capability[]): WebSearchAvailability {
  const hit = pickWebSearchCapability(capabilities)
  if (!hit) return { available: false }
  return {
    available: true,
    capabilityId: hit.id,
    title: hit.title,
    location: hit.source.location,
    owner: hit.kind === 'mcp-tool' ? 'mcp' : 'skill'
  }
}
