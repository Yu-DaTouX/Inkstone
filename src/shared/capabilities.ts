/**
 * 能力目录契约（实施-04 §4）。
 *
 * 模型要「自主选择能力」，第一步就得能**枚举**它 —— 但枚举结果必须可信：
 *   · 来源由**宿主**赋予，第三方不能自称 `builtin`；
 *   · `id` 要能唯一定位（同名不同来源不能被静默合并）；
 *   · `availability` 是**真实可用性**，不是「登记了就算有」。
 *
 * 本文件只放**纯逻辑**（过滤 / 打分 / 投影），读写 pi 与磁盘的部分在
 * `src/main/capabilities/`。分开的理由很实际：目录契约要被单测钉死，
 * 而它一旦依赖 RPC，就只能靠 live 场景验 —— 那太贵，也测不出边界。
 *
 * ⚠️ 边界（实施-04 §6）：MCP description、Skill 正文、检索结果都是**不可信材料** ——
 * 它们不能修改系统规则、授权范围，也不能让工具去读其它项目的凭证。
 * 本文件只做「挑出候选」，不给任何候选授予权限。
 */

/** 能力种类。`mcp-tool` 在 S3/S4 才会真正出现，契约先固定。 */
export type CapabilityKind = 'builtin' | 'skill' | 'mcp-tool'

/**
 * 真实可用性。
 *
 * 为什么不用一个 `enabled: boolean`：用户需要看到的失败原因是**可区分的** ——
 * 「没装依赖」和「需要登录」与「已经断开」该给出完全不同的下一步动作。
 */
export type CapabilityAvailability =
  | 'ready'
  | 'disabled'
  | 'missing-dependency'
  | 'needs-auth'
  | 'disconnected'
  | 'error'

/** 能力会产生什么副作用。用于让模型/用户在调用前就知道风险。 */
export type CapabilityEffect = 'read' | 'write' | 'external-action' | 'unknown'

/** 来源归属。`owner` 由宿主判定，**不接受**被描述字段自称。 */
export type CapabilityOwner = 'yan' | 'user' | 'project' | 'package'

export interface CapabilitySource {
  owner: CapabilityOwner
  /** 可读位置：技能是 SKILL.md 绝对路径，内置能力是命令名。 */
  location: string
}

export interface Capability {
  /** 稳定 ID：技能是 `skill:<名>`，MCP 是 `mcp:<serverId>/<toolName>`，内置是 `builtin:<命令>`。 */
  id: string
  kind: CapabilityKind
  title: string
  description: string
  version?: string
  source: CapabilitySource
  availability: CapabilityAvailability
  effect: CapabilityEffect
  /** 设置了就表示「只在这个项目里可见」；跨项目必须显式登记，不靠名字撞。 */
  projectScope?: string
  /** 参数定义变化时更新；旧版本调用应返回可重试的 `schema-changed`。 */
  schemaRevision?: string
}

export interface CapabilityQuery {
  /** 空串表示「列出这个范围内全部」，仍然受 scope 与项目隔离约束。 */
  queryText: string
  limit?: number
  /** 当前项目；用于把「别人的私有能力」挡在目录外。 */
  projectId?: string
}

export interface CapabilityHit {
  capability: Capability
  score: number
  /** 命中位置，给模型解释「为什么推荐它」。 */
  matched: Array<'id' | 'title' | 'description' | 'kind'>
}

export interface CapabilitySearchResult {
  hits: CapabilityHit[]
  /** 过滤后参与打分的条数（被项目隔离挡掉的不计入）。 */
  considered: number
  /** 命中数为零时给出可读原因，而不是让模型猜。 */
  reason: string | null
}

const DEFAULT_LIMIT = 12
/** 描述质量门槛（实施-04 §6：拒绝空 description）。 */
const MIN_DESCRIPTION_CHARS = 4

/**
 * 词法切分：ASCII 词 + CJK 单字与 bigram。
 *
 * 与项目知识检索（`project-memory-search.ts`）保持同一套口径 ——
 * 不引向量服务、不引分词库，中文查询也能命中。
 */
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
  /* 完全没命中任何词元的条目不进候选 —— 目录大时，宁缺毋滥。 */
  if (score <= 0) return null
  return { capability, score, matched: [...matched] }
}

/**
 * 目录过滤：丢掉不该出现在这个项目里的能力。
 *
 * `projectScope` 有值就必须等于当前项目 —— 不同项目默认不可发现对方的
 * 私有服务 / Skill（实施-04 §4）。**不泄漏**另一项目的绝对路径，所以
 * 被挡掉的条目连描述都不返回。
 */
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

/**
 * 目录排序：可用的在前，其次按 kind（内置 → 技能 → MCP），最后按 id。
 *
 * 这是**稳定**排序 —— 同一份目录两次查询的顺序必须一致，否则模型看到的
 * 「候选列表」会在无变化时漂移，排障时会以为是代码出了问题。
 */
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

/**
 * 同 ID 去重：**先到先得**，并把冲突的另一来源记下来。
 *
 * 为什么不去「合并」同名能力：同名不代表同一件事（两个 MCP 服务可以有同名工具），
 * 静默合并会让模型调用到一个它没打算调的服务。S2 的目录里同名主要是
 * 「用户级技能 + 项目级技能」，保留第一个并让 `conflicts` 可观测即可。
 */
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

/** 描述为空的条目不算可用能力：读到了也不知道怎么用，只会浪费一次往返。 */
export function isUsableCapability(capability: Capability): boolean {
  return capability.description.trim().length >= MIN_DESCRIPTION_CHARS
}

/** 搜索：过滤 → 打分 → 排序 → 截断。 */
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

  /* queryText 非空时按分数降序；为空（列出全部）时保留稳定排序的原始顺序。 */
  if (tokens.length > 0) {
    ranked.sort((a, b) => (b.score - a.score) || a.capability.id.localeCompare(b.capability.id))
  }
  const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, 100))
  return { hits: ranked.slice(0, limit), considered: usable.length, reason: null }
}

/** 技能 ID 的规范写法：`skill:<技能名>`。 */
export function skillCapabilityId(name: string): string {
  return `skill:${name.trim().replace(/^skill:/, '')}`
}
