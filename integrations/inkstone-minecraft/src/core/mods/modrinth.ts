import type { ModrinthDependency, ModrinthHit, ModrinthProject, ModrinthSearchQuery, ModrinthSearchResult, ModrinthVersion, ModrinthVersionFile } from '../../shared/mods-api.ts'
import { MODRINTH_API, USER_AGENT } from '../download/sources.ts'

export const MODRINTH_TIMEOUT_MS = 15_000
export const MODRINTH_RETRIES = 2

export interface ModrinthClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  retries?: number
  apiBase?: string
  userAgent?: string
}

interface RawFile {
  url?: unknown
  filename?: unknown
  size?: unknown
  primary?: unknown
  hashes?: Record<string, unknown>
}

interface RawVersion {
  id?: unknown
  project_id?: unknown
  name?: unknown
  version_number?: unknown
  game_versions?: unknown
  loaders?: unknown
  date_published?: unknown
  downloads?: unknown
  files?: unknown
  dependencies?: unknown
}

interface RawSearchResponse {
  hits?: unknown
  total_hits?: unknown
  offset?: unknown
  limit?: unknown
}

const DEPENDENCY_KINDS = new Set(['required', 'optional', 'incompatible', 'embedded'])

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function primaryFile(files: unknown): ModrinthVersionFile | null {
  if (!Array.isArray(files)) return null
  const raw = files.map((item) => (item && typeof item === 'object' ? (item as RawFile) : null)).filter((item): item is RawFile => !!item)
  const chosen = raw.find((file) => file.primary === true) ?? raw[0]
  if (!chosen) return null
  const url = text(chosen.url)
  const fileName = text(chosen.filename)
  const sha1 = text((chosen.hashes ?? {}).sha1)
  if (!url || !fileName || !sha1) return null
  return { url, fileName, size: number(chosen.size), sha1 }
}

function dependencies(value: unknown): ModrinthDependency[] {
  if (!Array.isArray(value)) return []
  const out: ModrinthDependency[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const kind = text(record.dependency_type)
    if (!kind || !DEPENDENCY_KINDS.has(kind)) continue
    out.push({
      projectId: text(record.project_id),
      versionId: text(record.version_id),
      fileName: text(record.file_name),
      kind: kind as ModrinthDependency['kind']
    })
  }
  return out
}

export function normalizeVersion(raw: unknown): ModrinthVersion | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as RawVersion
  const id = text(record.id)
  const projectId = text(record.project_id)
  const file = primaryFile(record.files)
  if (!id || !projectId || !file) return null
  return {
    id,
    projectId,
    projectTitle: null,
    name: text(record.name) ?? file.fileName,
    versionNumber: text(record.version_number) ?? file.fileName,
    gameVersions: strings(record.game_versions),
    loaders: strings(record.loaders),
    publishedAt: text(record.date_published) ?? '',
    downloads: number(record.downloads),
    file,
    dependencies: dependencies(record.dependencies),
    existsLocally: false
  }
}

function normalizeHit(raw: unknown): ModrinthHit | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const projectId = text(record.project_id)
  if (!projectId) return null
  return {
    projectId,
    slug: text(record.slug) ?? '',
    title: text(record.title) ?? projectId,
    description: text(record.description) ?? '',
    author: text(record.author) ?? '',
    downloads: number(record.downloads),
    follows: number(record.follows),
    updated: text(record.date_modified) ?? '',
    categories: strings(record.categories),
    iconUrl: text(record.icon_url)
  }
}

export function facetLoader(loader: string): string | null {
  if (loader === 'fabric' || loader === 'quilt' || loader === 'forge' || loader === 'neoforge') return loader
  return null
}

export class ModrinthClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly apiBase: string
  private readonly userAgent: string

  constructor(options: ModrinthClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? MODRINTH_TIMEOUT_MS
    this.retries = Math.max(0, options.retries ?? MODRINTH_RETRIES)
    this.apiBase = (options.apiBase ?? MODRINTH_API).replace(/\/+$/, '')
    this.userAgent = options.userAgent ?? USER_AGENT
  }

  private async request(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    const url = `${this.apiBase}${path}`
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (init.signal?.aborted) throw new Error('已取消')
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      try {
        const response = await this.fetchImpl(url, {
          method: init.method ?? 'GET',
          headers: {
            'user-agent': this.userAgent,
            accept: 'application/json',
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal
        })
        if (!response.ok) {
          if (response.status === 404) return null
          throw new Error(`Modrinth 返回 HTTP ${response.status}`)
        }
        return (await response.json()) as unknown
      } catch (error) {
        if (init.signal?.aborted) throw new Error('已取消')
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  async search(query: ModrinthSearchQuery): Promise<ModrinthSearchResult> {
    const facets: string[][] = [['project_type:mod']]
    const loader = query.loader ? facetLoader(query.loader) : null
    if (loader) facets.push([`categories:${loader}`])
    if (query.minecraft) facets.push([`versions:${query.minecraft}`])
    const params = new URLSearchParams({
      query: query.query,
      facets: JSON.stringify(facets),
      index: query.sort,
      limit: String(query.limit),
      offset: String(query.offset)
    })
    const raw = (await this.request(`/search?${params.toString()}`)) as RawSearchResponse | null
    const hits = Array.isArray(raw?.hits) ? raw.hits.map(normalizeHit).filter((hit): hit is ModrinthHit => !!hit) : []
    return { hits, totalHits: number(raw?.total_hits), offset: number(raw?.offset), limit: number(raw?.limit ?? query.limit) }
  }

  async project(id: string): Promise<ModrinthProject | null> {
    const raw = (await this.request(`/project/${encodeURIComponent(id)}`)) as Record<string, unknown> | null
    if (!raw) return null
    const projectId = text(raw.id)
    if (!projectId) return null
    return {
      projectId,
      slug: text(raw.slug) ?? '',
      title: text(raw.title) ?? projectId,
      description: text(raw.description) ?? '',
      body: text(raw.body) ?? '',
      categories: strings(raw.categories),
      downloads: number(raw.downloads),
      iconUrl: text(raw.icon_url),
      sourceUrl: text(raw.source_url),
      issuesUrl: text(raw.issues_url)
    }
  }

  async versions(projectId: string, filter: { loader?: string | null; minecraft?: string | null } = {}): Promise<ModrinthVersion[]> {
    const params: string[] = []
    const loader = filter.loader ? facetLoader(filter.loader) : null
    if (loader) params.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`)
    if (filter.minecraft) params.push(`game_versions=${encodeURIComponent(JSON.stringify([filter.minecraft]))}`)
    const suffix = params.length > 0 ? `?${params.join('&')}` : ''
    const raw = (await this.request(`/project/${encodeURIComponent(projectId)}/version${suffix}`)) as unknown
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeVersion).filter((version): version is ModrinthVersion => !!version)
  }

  async versionById(id: string): Promise<ModrinthVersion | null> {
    return normalizeVersion(await this.request(`/version/${encodeURIComponent(id)}`))
  }

  async versionsByIds(ids: string[]): Promise<ModrinthVersion[]> {
    if (ids.length === 0) return []
    const raw = (await this.request('/versions', { method: 'POST', body: ids })) as unknown
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeVersion).filter((version): version is ModrinthVersion => !!version)
  }

  async byHashes(hashes: string[]): Promise<Map<string, ModrinthVersion>> {
    const out = new Map<string, ModrinthVersion>()
    if (hashes.length === 0) return out
    const raw = (await this.request('/version_files', { method: 'POST', body: { hashes, algorithm: 'sha1' } })) as Record<string, unknown> | null
    if (!raw) return out
    for (const [sha1, value] of Object.entries(raw)) {
      const version = normalizeVersion(value)
      if (version) out.set(sha1.toLowerCase(), version)
    }
    return out
  }

  async updates(hashes: string[], filter: { loader?: string | null; minecraft?: string | null }): Promise<Map<string, ModrinthVersion>> {
    const out = new Map<string, ModrinthVersion>()
    if (hashes.length === 0) return out
    const loader = filter.loader ? facetLoader(filter.loader) : null
    const body = {
      hashes,
      algorithm: 'sha1',
      loaders: loader ? [loader] : [],
      game_versions: filter.minecraft ? [filter.minecraft] : []
    }
    const raw = (await this.request('/version_files/update', { method: 'POST', body })) as Record<string, unknown> | null
    if (!raw) return out
    for (const [sha1, value] of Object.entries(raw)) {
      const version = normalizeVersion(value)
      if (version) out.set(sha1.toLowerCase(), version)
    }
    return out
  }
}
