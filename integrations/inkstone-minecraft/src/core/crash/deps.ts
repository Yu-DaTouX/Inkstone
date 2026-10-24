import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoaderKind, TaskProgress } from '../../shared/api.ts'
import { downloadFiles, fetchJson } from '../download/download.ts'
import { MODRINTH_API } from '../download/sources.ts'
import { loaderTag } from './mods.ts'

interface ModrinthFile {
  url: string
  filename: string
  size: number
  primary: boolean
}

interface ModrinthVersion {
  id: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  files: ModrinthFile[]
}

interface ModrinthSearchHit {
  slug: string
  project_id: string
  title: string
}

interface ModrinthSearch {
  hits: ModrinthSearchHit[]
}

export interface DependencyInstallOptions {
  modsDir: string
  minecraftVersion: string | null
  loader: LoaderKind
  modIds: string[]
  signal?: AbortSignal
  onProgress?(progress: TaskProgress, detail?: string): void
  fetchImpl?: typeof fetch
}

export interface DependencyInstallResult {
  installed: string[]
  failed: Array<{ modId: string; reason: string }>
}

function versionQuery(options: DependencyInstallOptions): string {
  const query = new URLSearchParams()
  const loaders = loaderTag(options.loader)
  if (loaders.length > 0) query.set('loaders', JSON.stringify(loaders))
  if (options.minecraftVersion) query.set('game_versions', JSON.stringify([options.minecraftVersion]))
  return query.toString()
}

async function projectVersions(slug: string, options: DependencyInstallOptions): Promise<ModrinthVersion[]> {
  const base = { signal: options.signal, fetchImpl: options.fetchImpl }
  try {
    return await fetchJson<ModrinthVersion[]>(`${MODRINTH_API}/project/${encodeURIComponent(slug)}/version?${versionQuery(options)}`, base)
  } catch (error) {
    const facets = [['project_type:mod'], ...(loaderTag(options.loader).map((tag) => `categories:${tag}`) ?? []), ...(options.minecraftVersion ? [`versions:${options.minecraftVersion}`] : [])]
    const query = new URLSearchParams({ query: slug, limit: '5', facets: JSON.stringify(facets) })
    let search: ModrinthSearch
    try {
      search = await fetchJson<ModrinthSearch>(`${MODRINTH_API}/search?${query.toString()}`, base)
    } catch {
      throw error
    }
    const hit = search.hits[0]
    if (!hit) throw new Error(`Modrinth 上没找到 ${slug}`)
    return fetchJson<ModrinthVersion[]>(`${MODRINTH_API}/project/${encodeURIComponent(hit.slug)}/version?${versionQuery(options)}`, base)
  }
}

function primaryFile(version: ModrinthVersion): ModrinthFile | null {
  return version.files.find((file) => file.primary) ?? version.files[0] ?? null
}

export async function installMissingDependencies(options: DependencyInstallOptions): Promise<DependencyInstallResult> {
  const result: DependencyInstallResult = { installed: [], failed: [] }
  const modIds = [...new Set(options.modIds.map((id) => id.trim()).filter(Boolean))]
  if (modIds.length === 0) return result
  await mkdir(options.modsDir, { recursive: true })
  let done = 0
  for (const modId of modIds) {
    options.onProgress?.({ done, total: modIds.length, unit: 'steps' }, `查找 ${modId}`)
    try {
      const versions = await projectVersions(modId, options)
      const version = versions.find((item) => primaryFile(item)) ?? null
      const file = version ? primaryFile(version) : null
      if (!file) throw new Error(`Modrinth 上没有 ${modId} 适合 ${options.minecraftVersion ?? ''} 的版本`)
      const dest = join(options.modsDir, file.filename)
      if (existsSync(dest)) {
        result.installed.push(file.filename)
      } else {
        await downloadFiles([{ url: file.url, dest, size: file.size }], {
          signal: options.signal,
          fetchImpl: options.fetchImpl,
          onProgress: (progress, detail) => options.onProgress?.(progress, detail ?? `下载 ${file.filename}`)
        })
        result.installed.push(file.filename)
      }
    } catch (error) {
      result.failed.push({ modId, reason: error instanceof Error ? error.message : String(error) })
    }
    done += 1
    options.onProgress?.({ done, total: modIds.length, unit: 'steps' }, `${modId} 处理完成`)
  }
  return result
}
