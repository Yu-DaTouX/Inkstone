/**
 * 来源搜索入口的可用性判定（实施-07 S4）。
 *
 * ── 为什么要有这个文件 ──
 * 方案对「网页搜索」的要求是一句硬条件：**只在已发现兼容搜索能力时启用**，
 * 并且明写**不要**自造私有搜索后端。所以这里做的不是「实现搜索」，
 * 而是「判断这台机器上有没有一个已接入、能搜索的能力」，让入口**有则出现、无则隐藏**。
 *
 * ── 判据为什么保守 ──
 * 只看**外部接入**的能力（MCP 工具 / 已装 Skill）：
 *  · 内置的 `knowledge.search` 是**项目知识**检索，与「搜网页」不是一回事 ——
 *    把它算进来会让入口在每台机器上都出现，那正好是这一片要避免的假能力。
 *  · 名字/标题优先，描述只在「同时提到搜索 + 网页/联网」时才作为弱证据：
 *    否则一条描述里随口写了 "search" 的工具会误报。
 *
 * 纯函数、不碰磁盘也不碰 RPC —— 输入就是能力目录，便于单测直接构造。
 */
import type { Capability } from './capabilities'

/** 渲染端据此决定来源菜单里那枚「搜索网页」入口是否出现。 */
export interface WebSearchAvailability {
  available: boolean
  /** 命中的能力（给界面显示用） */
  capabilityId?: string
  title?: string
  /**
   * 模型要敲的那条命令 / 调用形状（能力目录里 `source.location`）。
   * 宿主不自己执行它 —— 执行能力是模型的事。
   */
  location?: string
  /** 来源说明（MCP 服务名 / 技能名），界面用来解释「靠谁搜」 */
  owner?: string
}

/** 名字/标题里的搜索语义。 */
const NAME_PATTERNS: readonly RegExp[] = [
  /\bweb[\s_-]*search\b/i,
  /\bsearch[\s_-]*web\b/i,
  /\binternet[\s_-]*search\b/i,
  /\bsearch[\s_-]*internet\b/i,
  /\bsearch[\s_-]*web[\s_-]*pages?\b/i,
  /联网搜索|网页搜索|网络搜索|在线搜索|互联网搜索/
]

/** 常见搜索服务/仓库名：与 search 同时出现在名字里才算（`tavily_search`、`Brave Search`）。 */
const PROVIDERS = /\b(tavily|brave|serper|serpapi|exa|duckduckgo|bing|google|perplexity|searxng|kagi)\b/i

/**
 * 这条能力算不算「兼容搜索能力」。
 *
 * 注意：**只**看外部接入的能力。内置能力一律不算 —— 见文件头。
 */
export function isWebSearchCapability(capability: Capability): boolean {
  if (capability.kind === 'builtin') return false
  const name = `${capability.title} ${capability.id} ${capability.source.location}`
  if (NAME_PATTERNS.some((re) => re.test(name))) return true
  /* 服务名 + search：`tavily_search` / `Brave Search API` 都能命中 */
  if (PROVIDERS.test(name) && /search|搜索|检索/i.test(name)) return true
  /* 弱证据：描述里**同时**提到搜索与网页/联网（中文里“检索”也是搜索） */
  const described = capability.description ?? ''
  if (/search|搜索|检索/i.test(described) && /web|internet|联网|网页|在线/i.test(described)) return true
  return false
}

/**
 * 从目录里挑一条可用的搜索能力。
 *
 * 排序：`ready` 优先，其次 MCP 工具（它的调用形状最明确，能直接交代给模型）。
 * 没有命中时返回 `undefined` —— 调用方据此**隐藏**入口，而不是显示一个点不动的按钮。
 */
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

/** 目录 → 界面要的可用性快照。 */
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
