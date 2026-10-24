import { HttpStatusError, fetchJson, type DownloadOptions } from '../download/download.ts'
import { FABRIC_META, QUILT_META } from '../download/sources.ts'
import { fetchManifest, manifestEntries } from './meta.ts'
import type { LoaderVersion, LoaderVersions, MinecraftVersionEntry, MinecraftVersionList } from './types.ts'

export function versionGroup(type: string): MinecraftVersionEntry['group'] {
  if (type === 'release') return 'release'
  if (type === 'snapshot') return 'snapshot'
  return 'old'
}

export async function listMinecraftVersions(options: DownloadOptions = {}): Promise<MinecraftVersionList> {
  const manifest = await fetchManifest(options)
  const release = typeof manifest.latest?.release === 'string' ? manifest.latest.release : null
  const snapshot = typeof manifest.latest?.snapshot === 'string' ? manifest.latest.snapshot : null
  const versions: MinecraftVersionEntry[] = manifestEntries(manifest).map((entry) => ({
    id: entry.id,
    type: entry.type,
    group: versionGroup(entry.type),
    url: entry.url,
    sha1: entry.sha1,
    size: entry.size,
    releaseTime: entry.releaseTime,
    latest: entry.id === release
  }))
  return { latest: { release, snapshot }, versions }
}

export function compareLoaderVersions(a: string, b: string): number {
  const split = (value: string) => value.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const left = split(a)
  const right = split(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return 1
    if (typeof y === 'number') return -1
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

function newestFirst(loaders: LoaderVersion[]): LoaderVersion[] {
  return [...loaders].sort((a, b) => compareLoaderVersions(b.version, a.version))
}

export function isQuiltStable(version: string): boolean {
  return !/-(beta|alpha|pre|rc|snapshot)/i.test(version)
}

export function pickFabricLoader(loaders: LoaderVersion[]): string | null {
  const sorted = newestFirst(loaders)
  return (sorted.find((loader) => loader.stable) ?? sorted[0])?.version ?? null
}

export function pickQuiltLoader(loaders: LoaderVersion[]): string | null {
  const sorted = newestFirst(loaders)
  return (sorted.find((loader) => isQuiltStable(loader.version)) ?? sorted[0])?.version ?? null
}

interface RawFabricLoaderEntry {
  loader?: { version?: unknown; stable?: unknown }
}

interface RawQuiltLoaderEntry {
  loader?: { version?: unknown; stable?: unknown }
}

async function fetchLoaderMeta(url: string, options: DownloadOptions): Promise<unknown> {
  if (options.source !== 'bmclapi') {
    try {
      return await fetchJson(url, { ...options, source: 'official', retries: 0 })
    } catch (error) {
      if (options.signal?.aborted) throw error
    }
  }
  return fetchJson(url, options)
}

function reasonOf(kind: 'Fabric' | 'Quilt', minecraft: string): string {
  return `${minecraft} 没有 ${kind} 版本`
}

function statusReason(error: unknown): boolean {
  return error instanceof HttpStatusError && (error.status === 400 || error.status === 404)
}

function toLoaderVersions(minecraft: string, kind: 'Fabric' | 'Quilt', entries: unknown, pick: (loaders: LoaderVersion[]) => string | null): LoaderVersions {
  const list = Array.isArray(entries) ? (entries as Array<RawFabricLoaderEntry | RawQuiltLoaderEntry>) : []
  const loaders = newestFirst(
    list.flatMap((entry) => (typeof entry.loader?.version === 'string' ? [{ version: entry.loader.version, stable: entry.loader.stable === true }] : []))
  )
  if (!loaders.length) return { minecraft, loaders: [], recommended: null, reason: reasonOf(kind, minecraft) }
  return { minecraft, loaders, recommended: pick(loaders), reason: null }
}

export async function listFabricLoaders(minecraft: string, options: DownloadOptions = {}): Promise<LoaderVersions> {
  try {
    const entries = await fetchLoaderMeta(`${FABRIC_META}/versions/loader/${encodeURIComponent(minecraft)}`, options)
    return toLoaderVersions(minecraft, 'Fabric', entries, pickFabricLoader)
  } catch (error) {
    if (statusReason(error)) return { minecraft, loaders: [], recommended: null, reason: reasonOf('Fabric', minecraft) }
    throw error
  }
}

export async function listQuiltLoaders(minecraft: string, options: DownloadOptions = {}): Promise<LoaderVersions> {
  try {
    const entries = await fetchLoaderMeta(`${QUILT_META}/versions/loader/${encodeURIComponent(minecraft)}`, options)
    return toLoaderVersions(minecraft, 'Quilt', entries, pickQuiltLoader)
  } catch (error) {
    if (statusReason(error)) return { minecraft, loaders: [], recommended: null, reason: reasonOf('Quilt', minecraft) }
    throw error
  }
}
