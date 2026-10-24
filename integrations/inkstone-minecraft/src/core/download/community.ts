import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskProgress } from '../../shared/api.ts'
import type { ContentCategory, ContentInstallResult, ContentInstallType, ContentProjectType, ContentSearchQuery } from '../../shared/download-api.ts'
import type { ModrinthHit, ModrinthProject, ModrinthSearchResult, ModrinthVersion } from '../../shared/mods-api.ts'
import { normalizeVersion } from '../mods/modrinth.ts'
import { downloadFiles } from './download.ts'
import { MODRINTH_API, USER_AGENT } from './sources.ts'

export const CONTENT_TIMEOUT_MS = 15_000
export const CONTENT_RETRIES = 2

const PROJECT_TYPES: readonly ContentProjectType[] = ['mod', 'resourcepack', 'shader', 'modpack']
const LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge'])

export interface CommunityClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  retries?: number
  apiBase?: string
  userAgent?: string
}

export interface ContentWorkOptions {
  signal?: AbortSignal
  onProgress?(progress: TaskProgress, detail?: string): void
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function projectTypeOf(value: unknown): ContentProjectType {
  return PROJECT_TYPES.find((item) => item === value) ?? 'mod'
}

export function installTypeOf(value: unknown): ContentInstallType {
  return value === 'shader' ? 'shader' : 'resourcepack'
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

export class CommunityClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly apiBase: string
  private readonly userAgent: string
  private categoriesCache: { at: number; value: ContentCategory[] } | null = null

  constructor(options: CommunityClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? CONTENT_TIMEOUT_MS
    this.retries = Math.max(0, options.retries ?? CONTENT_RETRIES)
    this.apiBase = (options.apiBase ?? MODRINTH_API).replace(/\/+$/, '')
    this.userAgent = options.userAgent ?? USER_AGENT
  }

  private async request(path: string, init: { signal?: AbortSignal } = {}): Promise<unknown> {
    const url = `${this.apiBase}${path}`
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (init.signal?.aborted) throw new Error('已取消')
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      try {
        const response = await this.fetchImpl(url, { headers: { 'user-agent': this.userAgent, accept: 'application/json' }, signal })
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

  async categories(projectType: ContentProjectType): Promise<ContentCategory[]> {
    if (!this.categoriesCache || Date.now() - this.categoriesCache.at > 10 * 60 * 1000) {
      const raw = await this.request('/tag/category')
      const list = Array.isArray(raw)
        ? raw
            .map((item) => {
              const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
              const name = text(record.name)
              const type = text(record.project_type)
              return name && type ? { name, projectType: type } : null
            })
            .filter((item): item is ContentCategory => !!item)
        : []
      this.categoriesCache = { at: Date.now(), value: list }
    }
    return this.categoriesCache.value.filter((item) => item.projectType === projectType)
  }

  async search(query: ContentSearchQuery): Promise<ModrinthSearchResult> {
    const projectType = projectTypeOf(query.projectType)
    const facets: string[][] = [[`project_type:${projectType}`]]
    if (projectType === 'mod' && query.loader && LOADERS.has(query.loader)) facets.push([`categories:${query.loader}`])
    if (query.category) facets.push([`categories:${query.category}`])
    if (query.minecraft) facets.push([`versions:${query.minecraft}`])
    const params = new URLSearchParams({
      query: query.query,
      facets: JSON.stringify(facets),
      index: query.sort,
      limit: String(query.limit),
      offset: String(query.offset)
    })
    const raw = (await this.request(`/search?${params.toString()}`)) as Record<string, unknown> | null
    const hits = Array.isArray(raw?.hits) ? raw.hits.map(normalizeHit).filter((hit): hit is ModrinthHit => !!hit) : []
    return { hits, totalHits: number(raw?.total_hits), offset: number(raw?.offset), limit: number(raw?.limit ?? query.limit) }
  }

  async versions(projectId: string, filter: { loader?: string | null; minecraft?: string | null } = {}): Promise<ModrinthVersion[]> {
    const params: string[] = []
    if (filter.loader && LOADERS.has(filter.loader)) params.push(`loaders=${encodeURIComponent(JSON.stringify([filter.loader]))}`)
    if (filter.minecraft) params.push(`game_versions=${encodeURIComponent(JSON.stringify([filter.minecraft]))}`)
    const suffix = params.length > 0 ? `?${params.join('&')}` : ''
    const raw = (await this.request(`/project/${encodeURIComponent(projectId)}/version${suffix}`)) as unknown
    if (!Array.isArray(raw)) return []
    return raw.map(normalizeVersion).filter((version): version is ModrinthVersion => !!version)
  }

  async version(id: string): Promise<ModrinthVersion | null> {
    return normalizeVersion(await this.request(`/version/${encodeURIComponent(id)}`))
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

  async installTo(dir: string, versionFileId: string, options: ContentWorkOptions = {}): Promise<ContentInstallResult> {
    const version = await this.version(versionFileId)
    if (!version) throw new Error('Modrinth 上没有这个版本')
    const dest = join(dir, version.file.fileName)
    let exists = false
    if (existsSync(dest)) {
      const info = await stat(dest).catch(() => null)
      exists = !!info?.isFile() && (version.file.size <= 0 || info.size === version.file.size)
    }
    if (exists) return { file: version.file.fileName, dir, skipped: true }
    await mkdir(dir, { recursive: true })
    options.onProgress?.({ done: 0, total: 1, unit: 'files' }, version.file.fileName)
    await downloadFiles([{ url: version.file.url, dest, sha1: version.file.sha1, size: version.file.size }], {
      source: 'official',
      ...(options.signal ? { signal: options.signal } : {}),
      fetchImpl: this.fetchImpl,
      onProgress: (progress, detail) => options.onProgress?.(progress, detail ?? version.file.fileName)
    })
    return { file: version.file.fileName, dir, skipped: false }
  }
}
