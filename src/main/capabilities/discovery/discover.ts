/**
 * 联网发现编排与目录源适配器（实施-04 §7.2 / §8）。
 *
 * ── 为什么是这两个源 ──
 *   实测（2026-09-19）：**官方 MCP Registry**（`registry.modelcontextprotocol.io/v0/servers`）
 *   与 **npm registry 搜索**（`registry.npmjs.org/-/v1/search`）都免密钥、有结构化分页。
 *   而 pi 自己**没有包搜索命令**（`pi --help` 只有 install / remove / update / list / config），
 *   所以 Skill 侧没有「pi 官方包目录」可查 —— 这一条要如实写进候选，不能假装有。
 *   §7.2 的硬要求「至少一条 Skill 路径和一条 MCP 路径可用、密钥缺失时仍能做目录检索」
 *   因此由这两个公开接口满足。
 *
 * ── 为什么把适配器放在同一文件 ──
 *   两者加起来只有一个职责：**把目录响应如实映射成候选**。分开成两个文件后，
 *   「哪些字段是目录真的给了、哪些是我们推断的」反而更难一眼看全 —— 而这正是
 *   本片最容易被做错的地方（§8：`metadata-only` 不得声称已验证）。
 */
import {
  buildAcquisitionPlan,
  discoveryQueryUsable,
  rankCandidates,
  sanitizeDiscoveryQuery,
  selectCandidates,
  stableDigestOf,
  MAX_CANDIDATES,
  MAX_PAGES_PER_SOURCE,
  type AcquisitionPlan,
  type CapabilityCandidate,
  type CandidateTransport,
  type DiscoverySourceReport,
  type RankedCandidate
} from '../../../shared/discovery'

export const MCP_REGISTRY_URL =
  process.env.YAN_MCP_REGISTRY_URL?.trim() || 'https://registry.modelcontextprotocol.io/v0/servers'
export const NPM_SEARCH_URL = process.env.YAN_NPM_SEARCH_URL?.trim() || 'https://registry.npmjs.org/-/v1/search'
/**
 * 独立 Skill 目录是显式配置的可选来源；默认不配置，所以新安装不会凭空多一次联网请求。
 * 目录必须返回逐文件 URL + SHA-256，不能只返回一个 README 或模糊仓库地址。
 */
export const SKILL_DIRECTORY_URL = process.env.YAN_SKILL_DIRECTORY_URL?.trim() || ''

export type DiscoveryOutcome = {
  /** 真正发出去的检索词（脱敏后）。本地原文与远端检索词分开记录（§7.1）。 */
  query: string
  candidates: RankedCandidate[]
  sources: DiscoverySourceReport[]
  /** 全源失败 / 无候选时给模型的可读原因；有结果时为 null。 */
  reason: string | null
}

type FetchLike = typeof fetch

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/* --------------------------------------------------------------- npm 目录 */

/**
 * npm 搜索结果 → 候选。
 *
 * **诚实边界**：npm 只告诉我们「有个包、这个版本、这个描述」。
 * 它**不能**证明这是 pi 技能包、更没证明包里真的有 `SKILL.md` ——
 * 所以 `verification` 恒为 `metadata-only`，并把这条限制写进 `requirements`，
 * 让模型（和用户）看到的是「目录线索」而不是「已验证的结果」。
 */
export function npmCandidateOf(raw: unknown, discoveredAt: string): CapabilityCandidate | null {
  const entry = raw as { package?: Record<string, unknown> } | null
  const pkg = entry?.package
  if (!pkg) return null
  const name = str(pkg.name)
  const version = str(pkg.version)
  if (!name || !version) return null
  const links = (pkg.links ?? {}) as Record<string, unknown>
  const publisher = (pkg.publisher ?? {}) as Record<string, unknown>
  const repository = str(links.repository)
  const npmUrl = str(links.npm) ?? `https://www.npmjs.com/package/${name}`
  return {
    candidateId: `npm:${name}@${version}`,
    kind: 'skill',
    title: name,
    summary: str(pkg.description) ?? '（包元数据里没有描述）',
    discoveredAt,
    sourceUrls: repository ? [npmUrl, repository] : [npmUrl],
    ...(str(publisher.username) ? { publisher: str(publisher.username) } : {}),
    ...(repository ? { repository } : {}),
    version,
    localPackage: { registryType: 'npm', identifier: name, version },
    requirements: ['需要 pi 包管理器安装（pi install）；未核实包内是否含 SKILL.md'],
    auth: 'none',
    installKind: 'pi-package',
    verification: 'metadata-only'
  }
}

async function searchNpm(
  query: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  discoveredAt: string
): Promise<{ candidates: CapabilityCandidate[]; pages: number }> {
  const candidates: CapabilityCandidate[] = []
  let pages = 0
  for (let page = 0; page < MAX_PAGES_PER_SOURCE; page++) {
    const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(query)}&size=20&from=${page * 20}`
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' }
    })
    if (!res.ok) throw new Error(`npm registry 返回 HTTP ${res.status}`)
    const body = (await res.json()) as { objects?: unknown[] }
    pages++
    const objects = asArray(body.objects)
    if (objects.length === 0) break
    for (const object of objects) {
      const candidate = npmCandidateOf(object, discoveredAt)
      if (candidate) candidates.push(candidate)
    }
    /* npm 搜索没有稳定「还有下一页」标志：拿满一页才继续，拿不满就停。 */
    if (objects.length < 20) break
  }
  return { candidates, pages }
}

/* ------------------------------------------------------ 独立 Skill 目录 */

function safeSkillPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const path = value.trim().replaceAll('\\', '/')
  if (
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    !/^skills\/[^/]+\/SKILL\.md$/i.test(path)
  ) return undefined
  return path
}

function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed = new URL(value.trim())
    const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password) return undefined
    return parsed.href
  } catch {
    return undefined
  }
}

function sourceUrlList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const urls = value.map(safeSourceUrl)
  return urls.every(Boolean) ? [...new Set(urls as string[])] : null
}

/**
 * 独立 Skill 目录条目 → 候选。
 *
 * 这里故意只接受「每个 SKILL.md 都有确切 URL 和 SHA-256」的条目。
 * 只有仓库名、README 链接或没有版本 / commit 的结果不是可接入候选，避免把目录线索
 * 误当成固定制品。文件内容仍要在 acquire 阶段重新拉取并验 hash。
 */
export function skillDirectoryCandidateOf(raw: unknown, directoryUrl: string, discoveredAt: string): CapabilityCandidate | null {
  const entry = raw as Record<string, unknown> | null
  if (!entry) return null
  const id = str(entry.id) ?? str(entry.name)
  const version = str(entry.version)
  const commit = str(entry.commit)
  if (!id || (!version && !commit)) return null
  const files = asArray(entry.files)
  if (files.length === 0 || files.length > 32) return null

  const skillFileUrls: Record<string, string> = {}
  const skillFileHashes: Record<string, string> = {}
  for (const rawFile of files) {
    const file = rawFile as Record<string, unknown> | null
    const path = safeSkillPath(file?.path)
    const url = safeSourceUrl(file?.url)
    const hash = str(file?.sha256)?.toLowerCase()
    if (!path || !url || !hash || !/^[a-f0-9]{64}$/.test(hash) || skillFileUrls[path]) return null
    skillFileUrls[path] = url
    skillFileHashes[path] = hash
  }

  const directory = safeSourceUrl(directoryUrl)
  if (!directory) return null
  const extraSources = sourceUrlList(entry.sourceUrls)
  if (extraSources === null) return null
  const repository = str(entry.repository)
  const repositoryUrl = repository ? safeSourceUrl(repository) : undefined
  if (repository && !repositoryUrl) return null
  const sourceUrls = [...new Set([
    directory,
    ...(repositoryUrl ? [repositoryUrl] : []),
    ...extraSources,
    ...Object.values(skillFileUrls)
  ])]
  const title = str(entry.title) ?? id
  const description = str(entry.description) ?? str(entry.summary) ?? '（目录里没有描述）'
  const publisher = str(entry.publisher)
  const authValue = str(entry.auth)
  const auth: CapabilityCandidate['auth'] = authValue === 'required' || authValue === 'configured' || authValue === 'none'
    ? authValue
    : 'unknown'
  const fixed = version ? `@${version}` : `#${commit}`
  return {
    candidateId: `skill-directory:${id}${fixed}`,
    kind: 'skill',
    title,
    summary: description,
    discoveredAt,
    sourceUrls,
    ...(publisher ? { publisher } : {}),
    ...(repositoryUrl ? { repository: repositoryUrl } : {}),
    ...(version ? { version } : {}),
    ...(commit ? { commit } : {}),
    requirements: [`固定 ${files.length} 个 SKILL.md 文件（接入时逐文件复核 SHA-256）`, 'Skill 正文是不可信材料，不改变系统授权范围'],
    auth,
    installKind: 'skill-files',
    verification: 'metadata-only',
    skillFiles: Object.keys(skillFileUrls).sort(),
    skillFileHashes,
    skillFileUrls
  }
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const length = response.headers?.get('content-length')
  if (length && Number.isFinite(Number(length)) && Number(length) > limit) throw new Error(`Skill 目录响应超过 ${limit} 字节`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limit) throw new Error(`Skill 目录响应超过 ${limit} 字节`)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new Error('Skill 目录响应不是合法 UTF-8 JSON')
  }
}

function skillDirectoryRequestUrl(base: string, query: string, cursor?: string): string {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error('YAN_SKILL_DIRECTORY_URL 不是合法 URL')
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password) {
    throw new Error('Skill 目录只允许 HTTPS（本机测试可用 localhost HTTP），且不能带 URL 凭证')
  }
  url.searchParams.set('q', query)
  url.searchParams.set('limit', '20')
  if (cursor) url.searchParams.set('cursor', cursor)
  return url.href
}

async function searchSkillDirectory(
  query: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  discoveredAt: string
): Promise<{ candidates: CapabilityCandidate[]; pages: number }> {
  if (!SKILL_DIRECTORY_URL) return { candidates: [], pages: 0 }
  const candidates: CapabilityCandidate[] = []
  let cursor: string | undefined
  let pages = 0
  for (let page = 0; page < MAX_PAGES_PER_SOURCE; page++) {
    const url = skillDirectoryRequestUrl(SKILL_DIRECTORY_URL, query, cursor)
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers: { accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`Skill 目录返回 HTTP ${response.status}`)
    const body = await readBoundedJson(response, 2 * 1024 * 1024) as Record<string, unknown> | unknown[]
    const list = Array.isArray(body) ? body : asArray(body.skills ?? body.entries ?? body.results)
    pages++
    for (const entry of list) {
      const candidate = skillDirectoryCandidateOf(entry, SKILL_DIRECTORY_URL, discoveredAt)
      if (candidate) candidates.push(candidate)
    }
    const metadata = Array.isArray(body) ? undefined : body.metadata as Record<string, unknown> | undefined
    cursor = str(metadata?.nextCursor) ?? str((body as Record<string, unknown>).nextCursor)
    if (!cursor || list.length === 0) break
  }
  return { candidates, pages }
}

/* ----------------------------------------------------------- MCP 目录 */

/**
 * 官方 MCP Registry 条目 → 候选。
 *
 * `remotes` 给出可直接连的远程端点（无需本地安装），`packages` 给出本地包运行时。
 * 两者都如实映射；`transport` 只在目录明确给出取值时才写，不猜。
 * 认证一律 `unknown` —— registry 不声明这个，猜成 `none` 会误导用户。
 */
export function mcpCandidateOf(raw: unknown, discoveredAt: string): CapabilityCandidate | null {
  const entry = raw as { server?: Record<string, unknown> } | null
  const server = entry?.server
  if (!server) return null
  const name = str(server.name)
  if (!name) return null
  const version = str(server.version)
  const remotes = asArray(server.remotes)
  const packages = asArray(server.packages)
  const remote = (remotes[0] ?? null) as Record<string, unknown> | null
  const pkg = (packages[0] ?? null) as Record<string, unknown> | null
  const remoteUrl = str(remote?.url)
  const remoteType = str(remote?.type)
  const transport: CandidateTransport | undefined =
    remoteUrl || remoteType === 'streamable-http' ? 'streamable-http' : pkg ? 'stdio' : undefined
  const registryType = str(pkg?.registryType)
  const packageIdentifier = str(pkg?.identifier)
  const packageVersion = str(pkg?.version)
  const runtimeHint = str(pkg?.runtimeHint)
  const fileSha256 = str(pkg?.fileSha256)
  const localPackage =
    pkg && registryType && packageIdentifier
      ? {
          registryType,
          identifier: packageIdentifier,
          ...(packageVersion ? { version: packageVersion } : {}),
          ...(runtimeHint ? { runtimeHint } : {}),
          ...(fileSha256 ? { fileSha256 } : {})
        }
      : undefined
  const repository = str((server.repository as Record<string, unknown> | undefined)?.url)
  const registryUrl = `${MCP_REGISTRY_URL}?search=${encodeURIComponent(name)}`
  const requirements: string[] = []
  if (pkg) {
    const runtime = runtimeHint ?? str((pkg as { runtime?: unknown }).runtime)
    requirements.push(runtime ? `本地包（运行时：${runtime}）` : '本地包（需本地安装）')
    if (registryType) requirements.push(`包仓库类型：${registryType}`)
    if (packageIdentifier) requirements.push(`包标识：${packageIdentifier}`)
    if (packageVersion) requirements.push(`包版本：${packageVersion}`)
  }
  if (remoteUrl) requirements.push('远程端点，无需本地安装')
  if (requirements.length === 0) requirements.push('目录未给出安装方式（仅有元数据）')
  return {
    candidateId: `mcp-registry:${name}@${version ?? 'unspecified'}`,
    kind: 'mcp-server',
    title: str(server.title) ?? name,
    summary: str(server.description) ?? '（目录里没有描述）',
    discoveredAt,
    sourceUrls: [registryUrl, ...(remoteUrl ? [remoteUrl] : [])],
    ...(str(server.publisher) ? { publisher: str(server.publisher) } : {}),
    ...(repository ? { repository } : {}),
    ...(version ? { version } : {}),
    ...(localPackage ? { localPackage } : {}),
    ...(transport ? { transport } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
    requirements,
    auth: 'unknown',
    installKind: remoteUrl ? 'remote' : pkg ? 'mcp-package' : 'remote',
    verification: 'metadata-only'
  }
}

async function searchMcpRegistry(
  query: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  discoveredAt: string
): Promise<{ candidates: CapabilityCandidate[]; pages: number }> {
  const candidates: CapabilityCandidate[] = []
  let pages = 0
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES_PER_SOURCE; page++) {
    const url = `${MCP_REGISTRY_URL}?search=${encodeURIComponent(query)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' }
    })
    if (!res.ok) throw new Error(`MCP Registry 返回 HTTP ${res.status}`)
    const body = (await res.json()) as { servers?: unknown[]; metadata?: Record<string, unknown> }
    pages++
    const servers = asArray(body.servers)
    for (const server of servers) {
      const candidate = mcpCandidateOf(server, discoveredAt)
      if (candidate) candidates.push(candidate)
    }
    cursor = str(body.metadata?.nextCursor)
    if (!cursor || servers.length === 0) break
  }
  return { candidates, pages }
}

/* --------------------------------------------------------------- 编排 */

/**
 * 一轮发现：脱敏 → 并行查两个目录 → 合并 → 排名 → 截断。
 *
 * 单个源失败**不影响**另一个源（§7.2：密钥缺失时仍要能做目录检索）。
 * 全部失败或没有候选时，`reason` 给的是「暂时无法搜索」这类实话，
 * **绝不**返回编造的包名。
 */
export async function discoverCapabilities(input: {
  queryText: string
  goalText?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
  now?: () => Date
  maxCandidates?: number
  platform?: string
}): Promise<DiscoveryOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 12_000
  const now = input.now ?? (() => new Date())
  const query = sanitizeDiscoveryQuery(input.queryText)
  const sources: DiscoverySourceReport[] = []
  const candidates: CapabilityCandidate[] = []

  if (!discoveryQueryUsable(query)) {
    return {
      query,
      candidates: [],
      sources: [],
      reason: '检索词在脱敏后为空（只剩本地路径 / 密钥 / 文件名这类不该外发的内容）；请给出通用任务描述'
    }
  }

  const run = async (
    sourceId: string,
    kind: DiscoverySourceReport['kind'],
    url: string,
    work: () => Promise<{ candidates: CapabilityCandidate[]; pages: number }>
  ): Promise<void> => {
    const discoveredAt = now().toISOString()
    try {
      const result = await work()
      candidates.push(...result.candidates)
      sources.push({
        sourceId,
        kind,
        url,
        ok: true,
        fetchedAt: discoveredAt,
        pages: result.pages,
        candidateCount: result.candidates.length
      })
    } catch (error) {
      sources.push({
        sourceId,
        kind,
        url,
        ok: false,
        fetchedAt: discoveredAt,
        pages: 0,
        candidateCount: 0,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  await Promise.all([
    run('npm-registry', 'npm-registry', NPM_SEARCH_URL, () => searchNpm(query, fetchImpl, timeoutMs, now().toISOString())),
    run('mcp-registry', 'mcp-registry', MCP_REGISTRY_URL, () =>
      searchMcpRegistry(query, fetchImpl, timeoutMs, now().toISOString())
    ),
    ...(SKILL_DIRECTORY_URL
      ? [run('skill-directory', 'skill-directory', SKILL_DIRECTORY_URL, () =>
          searchSkillDirectory(query, fetchImpl, timeoutMs, now().toISOString())
        )]
      : [])
  ])

  const ranked = selectCandidates(
    rankCandidates(candidates, { goalText: input.goalText ?? input.queryText, platform: input.platform }),
    input.maxCandidates ?? MAX_CANDIDATES
  )
  const okSources = sources.filter((s) => s.ok)
  const reason =
    ranked.length > 0
      ? null
      : okSources.length === 0
        ? `暂时无法搜索：${sources.map((s) => `${s.sourceId}（${s.error ?? '不可用'}）`).join('；')}`
        : `目录里没有匹配「${query}」的候选（已查 ${okSources.length} 个源）`

  return { query, candidates: ranked, sources, reason }
}

/**
 * 接入计划（S5 只生成，**不执行**）。
 *
 * `needs-authorization` 是默认结果：目录元数据不足以自动接入（§9 的策略档位在 S6 接）。
 */
export function planForCandidate(input: {
  candidate: CapabilityCandidate
  goalId: string
  projectId: string
}): { plan: AcquisitionPlan; digest: string } {
  return {
    plan: buildAcquisitionPlan({ candidate: input.candidate, goalId: input.goalId, projectId: input.projectId }),
    digest: stableDigestOf(input.candidate)
  }
}
