import { createHash } from 'node:crypto'
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
import { searchGithubSkills } from '../github-skills'

export const MCP_REGISTRY_URL =
  process.env.YAN_MCP_REGISTRY_URL?.trim() || 'https://registry.modelcontextprotocol.io/v0/servers'
export const NPM_SEARCH_URL = process.env.YAN_NPM_SEARCH_URL?.trim() || 'https://registry.npmjs.org/-/v1/search'
export const SKILL_DIRECTORY_URL = process.env.YAN_SKILL_DIRECTORY_URL?.trim() || ''

export type DiscoveryOutcome = {
  query: string
  candidates: RankedCandidate[]
  sources: DiscoverySourceReport[]
  reason: string | null
}

type FetchLike = typeof fetch

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function npmCandidateOf(raw: unknown, discoveredAt: string): CapabilityCandidate | null {
  const entry = raw as { package?: Record<string, unknown> } | null
  const pkg = entry?.package
  if (!pkg) return null
  const name = str(pkg.name)
  const version = str(pkg.version)
  if (!name || !version) return null
  const links = (pkg.links ?? {}) as Record<string, unknown>
  const publisher = (pkg.publisher ?? {}) as Record<string, unknown>
  const repository = safeSourceUrl(links.repository)
  const npmUrl = safeSourceUrl(links.npm) ?? `https://www.npmjs.com/package/${encodeURIComponent(name)}`
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
    const base = safeSourceUrl(NPM_SEARCH_URL)
    if (!base) throw new Error('NPM_SEARCH_URL 只允许 HTTPS（本机测试可用 localhost HTTP）')
    const urlObject = new URL(base)
    urlObject.searchParams.set('text', query)
    urlObject.searchParams.set('size', '20')
    urlObject.searchParams.set('from', String(page * 20))
    const url = urlObject.href
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' }
    })
    if (!res.ok) throw new Error(`npm registry 返回 HTTP ${res.status}`)
    const body = await readBoundedJson(res, 1024 * 1024) as { objects?: unknown[] }
    pages++
    const objects = asArray(body.objects)
    if (objects.length === 0) break
    for (const object of objects) {
      const candidate = npmCandidateOf(object, discoveredAt)
      if (candidate) candidates.push(candidate)
    }
    if (objects.length < 20) break
  }
  return { candidates, pages }
}

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

async function readBoundedBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const length = response.headers?.get('content-length')
  if (length && Number.isFinite(Number(length)) && Number(length) > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`${label}超过 ${limit} 字节`)
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new Error(`${label}超过 ${limit} 字节`)
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const bytes = await readBoundedBytes(response, limit, 'Skill 目录响应')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Skill 目录响应不是合法 UTF-8 JSON')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('Skill 目录响应不是合法 JSON')
  }
}

async function readSkillDirectoryFile(
  response: Response,
  limit: number
): Promise<{ content: Uint8Array; sha256: string }> {
  const content = await readBoundedBytes(response, limit, 'Skill 文件')
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new Error('Skill 文件不是合法 UTF-8 文本')
  }
  if (content.byteLength === 0 || new TextDecoder().decode(content).trim().length === 0) {
    throw new Error('Skill 文件为空')
  }
  return { content, sha256: createHash('sha256').update(content).digest('hex') }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

function skillMdDetailUrl(directoryUrl: string, rawUrl: string): string | undefined {
  try {
    const directory = new URL(directoryUrl)
    const raw = new URL(rawUrl)
    if (directory.origin !== raw.origin) return undefined
    const marker = '/api/skills/'
    const markerAt = raw.pathname.indexOf(marker)
    if (markerAt < 0 || !raw.pathname.endsWith('/raw')) return undefined
    const slugPath = raw.pathname.slice(markerAt + marker.length, -'/raw'.length)
    const parts = slugPath.split('/').filter(Boolean)
    if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) return undefined
    return `${directory.origin}/v1/skills/${parts.map((part) => encodeURIComponent(part)).join('/')}`
  } catch {
    return undefined
  }
}

async function skillMdCandidateOf(
  raw: unknown,
  directoryUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  discoveredAt: string
): Promise<CapabilityCandidate | null> {
  const listed = raw as Record<string, unknown> | null
  if (!listed || typeof listed !== 'object') return null
  const listedRawUrl = safeSourceUrl(listed.raw_url)
  if (!listedRawUrl || !sameOrigin(listedRawUrl, directoryUrl)) return null
  let entry = listed
  if (!str(entry.commit_sha)) {
    const detailUrl = skillMdDetailUrl(directoryUrl, listedRawUrl)
    if (!detailUrl) return null
    const detailResponse = await fetchImpl(detailUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: { accept: 'application/json' }
    })
    if (!detailResponse.ok) throw new Error(`Skill 详情返回 HTTP ${detailResponse.status}`)
    const actualDetailUrl = detailResponse.url || detailUrl
    if (!sameOrigin(actualDetailUrl, detailUrl)) throw new Error('Skill 详情跳转到了未登记来源')
    const detail = await readBoundedJson(detailResponse, 512 * 1024)
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
    if (str((detail as Record<string, unknown>).slug) !== str(listed.slug)) return null
    const detailRawUrl = safeSourceUrl((detail as Record<string, unknown>).raw_url)
    if (detailRawUrl && detailRawUrl !== listedRawUrl) return null
    entry = { ...listed, ...(detail as Record<string, unknown>) }
  }

  const slug = str(entry.slug)
  const commit = str(entry.commit_sha)
  const rawUrl = listedRawUrl
  const skillName = slug?.split('/').at(-1)
  if (!slug || !commit || !/^[a-f0-9]{7,64}$/i.test(commit) || !rawUrl || !skillName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(skillName)) return null

  const response = await fetchImpl(rawUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
    headers: { accept: 'text/markdown, text/plain;q=0.9, application/octet-stream;q=0.5' }
  })
  if (!response.ok) throw new Error(`Skill 文件返回 HTTP ${response.status}`)
  const actualUrl = response.url || rawUrl
  if (!sameOrigin(actualUrl, rawUrl)) throw new Error('Skill 文件跳转到了未登记来源')
  const { sha256 } = await readSkillDirectoryFile(response, 512 * 1024)
  const owner = slug.includes('/') ? slug.split('/')[0] : undefined
  const candidate = skillDirectoryCandidateOf(
    {
      id: slug,
      title: entry.title,
      description: entry.description,
      commit,
      publisher: owner,
      repository: entry.source_repo,
      sourceUrls: [rawUrl],
      files: [{ path: `skills/${skillName}/SKILL.md`, url: rawUrl, sha256 }]
    },
    directoryUrl,
    discoveredAt
  )
  return candidate
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
      redirect: 'error',
      headers: { accept: 'application/json' }
    })
    if (!response.ok) throw new Error(`Skill 目录返回 HTTP ${response.status}`)
    const body = await readBoundedJson(response, 2 * 1024 * 1024) as Record<string, unknown> | unknown[]
    const list = Array.isArray(body) ? body : asArray(body.skills ?? body.entries ?? body.results ?? body.items)
    pages++
    const pageCandidates: Array<CapabilityCandidate | null> = []
    for (let start = 0; start < Math.min(list.length, 60); start += 4) {
      const batch = list.slice(start, start + 4)
      pageCandidates.push(...await Promise.all(batch.map(async (entry) => {
        try {
          return skillDirectoryCandidateOf(entry, SKILL_DIRECTORY_URL, discoveredAt)
            ?? await skillMdCandidateOf(entry, SKILL_DIRECTORY_URL, fetchImpl, timeoutMs, discoveredAt)
        } catch { return null }
      })))
    }
    candidates.push(...pageCandidates.filter((candidate): candidate is CapabilityCandidate => candidate !== null))
    const metadata = Array.isArray(body) ? undefined : body.metadata as Record<string, unknown> | undefined
    cursor = str(metadata?.nextCursor) ?? str((body as Record<string, unknown>).nextCursor)
    if (!cursor || list.length === 0) break
  }
  return { candidates, pages }
}

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
  const remoteUrl = safeSourceUrl(remote?.url)
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
  const repository = safeSourceUrl((server.repository as Record<string, unknown> | undefined)?.url)
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
    installKind: remoteUrl ? 'remote' : pkg ? 'mcp-package' : 'unknown',
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
    const base = safeSourceUrl(MCP_REGISTRY_URL)
    if (!base) throw new Error('MCP_REGISTRY_URL 只允许 HTTPS（本机测试可用 localhost HTTP）')
    const urlObject = new URL(base)
    urlObject.searchParams.set('search', query)
    urlObject.searchParams.set('limit', '20')
    if (cursor) urlObject.searchParams.set('cursor', cursor)
    const url = urlObject.href
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' }
    })
    if (!res.ok) throw new Error(`MCP Registry 返回 HTTP ${res.status}`)
    const body = await readBoundedJson(res, 2 *  1024 * 1024) as { servers?: unknown[]; metadata?: Record<string, unknown> }
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

export async function discoverCapabilities(input: {
  queryText: string
  goalText?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
  now?: () => Date
  maxCandidates?: number
  platform?: string
  skillRepos?: string[]
}): Promise<DiscoveryOutcome> {
  const fetchImpl = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 12_000
  const now = input.now ?? (() => new Date())
  const query = sanitizeDiscoveryQuery(input.queryText)
  const sources: DiscoverySourceReport[] = []
  const candidates: CapabilityCandidate[] = []
  const namedRepos = input.skillRepos?.filter(Boolean) ?? []

  if (!discoveryQueryUsable(query) && namedRepos.length === 0) {
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

  const github = () => run('github-skills', 'github-skills', 'https://github.com', async () => {
    const result = await searchGithubSkills({
      query,
      ...(namedRepos.length > 0 ? { repos: namedRepos, listAll: true } : {}),
      fetchImpl,
      timeoutMs,
      discoveredAt: now().toISOString()
    })
    return { candidates: result.candidates, pages: result.pages }
  })

  await Promise.all(namedRepos.length > 0 ? [github()] : [
    github(),
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
    input.maxCandidates ?? (namedRepos.length > 0 ? 60 : MAX_CANDIDATES)
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
