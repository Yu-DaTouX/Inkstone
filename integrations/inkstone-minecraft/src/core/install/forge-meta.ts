import { fetchJson, fetchText, HttpStatusError, type DownloadOptions } from '../download/download.ts'
import { MIRROR_ORIGIN } from '../download/sources.ts'
import { compareLoaderVersions } from './list.ts'
import type { LoaderVersion, LoaderVersions } from './types.ts'

export const FORGE_MAVEN = 'https://maven.minecraftforge.net'
export const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases'
export const FORGE_PROMOTIONS_URL = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
export const FORGE_METADATA_URL = `${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`
export const NEOFORGE_METADATA_URL = `${NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`
export const NEOFORGE_LEGACY_METADATA_URL = `${NEOFORGE_MAVEN}/net/neoforged/forge/maven-metadata.xml`
export const FORGE_BUILDS_URL = `${MIRROR_ORIGIN}/forge/minecraft`

const FORGE_MAVEN_ORIGINS = [FORGE_MAVEN, NEOFORGE_MAVEN]

export function forgeMirrorUrl(url: string, mirrorOrigin = MIRROR_ORIGIN): string | null {
  for (const origin of FORGE_MAVEN_ORIGINS) {
    if (!url.startsWith(origin)) continue
    const rest = url.slice(origin.length)
    if (rest && !rest.startsWith('/')) continue
    return `${mirrorOrigin}/maven${rest}`
  }
  return null
}

export function isForgeMavenUrl(url: string): boolean {
  return forgeMirrorUrl(url) !== null
}

export interface MavenMetadata {
  latest: string | null
  release: string | null
  versions: string[]
}

export function parseMavenMetadata(xml: string): MavenMetadata {
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1].trim()).filter(Boolean)
  const latest = xml.match(/<latest>([^<]+)<\/latest>/)?.[1]?.trim() ?? null
  const release = xml.match(/<release>([^<]+)<\/release>/)?.[1]?.trim() ?? null
  return { latest, release, versions }
}

async function fetchMetadataXml(url: string, options: DownloadOptions): Promise<string> {
  if (options.source !== 'bmclapi') {
    try {
      return await fetchText(url, { ...options, source: 'official', retries: 0 })
    } catch (error) {
      if (options.signal?.aborted) throw error
    }
  }
  const mirrored = forgeMirrorUrl(url, options.mirrorOrigin) ?? url
  return fetchText(mirrored, { ...options, source: 'official', retries: 0 })
}

async function optionalMetadata(url: string, options: DownloadOptions): Promise<MavenMetadata | null> {
  try {
    return parseMavenMetadata(await fetchMetadataXml(url, options))
  } catch (error) {
    if (options.signal?.aborted) throw error
    return null
  }
}

export async function fetchForgeMetadata(options: DownloadOptions = {}): Promise<MavenMetadata> {
  return parseMavenMetadata(await fetchMetadataXml(FORGE_METADATA_URL, options))
}

export async function fetchNeoForgeMetadata(options: DownloadOptions = {}): Promise<MavenMetadata> {
  return parseMavenMetadata(await fetchMetadataXml(NEOFORGE_METADATA_URL, options))
}

export interface ForgePromotions {
  promos: Record<string, string>
}

export async function fetchForgePromotions(options: DownloadOptions = {}): Promise<ForgePromotions | null> {
  try {
    const raw = await fetchJson<{ promos?: unknown }>(FORGE_PROMOTIONS_URL, { ...options, source: 'official', retries: 0 })
    const promos: Record<string, string> = {}
    if (raw.promos && typeof raw.promos === 'object') {
      for (const [key, value] of Object.entries(raw.promos as Record<string, unknown>)) {
        if (typeof value === 'string') promos[key] = value
      }
    }
    return { promos }
  } catch (error) {
    if (options.signal?.aborted) throw error
    return null
  }
}

export function forgeArtifactsFor(versions: string[], minecraft: string): string[] {
  return versions.filter((version) => version.startsWith(`${minecraft}-`))
}

export function forgeLoaderVersion(minecraft: string, artifact: string): string {
  const prefix = `${minecraft}-`
  return artifact.startsWith(prefix) ? artifact.slice(prefix.length) : artifact
}

export function forgeArtifactVersion(minecraft: string, loader: string, artifacts: string[] = []): string {
  if (loader.startsWith(`${minecraft}-`)) return loader
  const plain = `${minecraft}-${loader}`
  const suffixed = `${minecraft}-${loader}-${minecraft}`
  if (artifacts.includes(plain)) return plain
  if (artifacts.includes(suffixed)) return suffixed
  const minor = Number(minecraft.split('.')[1])
  if (minor === 7 || minor === 8) return suffixed
  return plain
}

export function forgeInstallerUrl(artifact: string): string {
  return `${FORGE_MAVEN}/net/minecraftforge/forge/${artifact}/forge-${artifact}-installer.jar`
}

export function forgeCoordinate(artifact: string): string {
  return `net.minecraftforge:forge:${artifact}`
}

export function forgeSupported(minecraft: string): boolean {
  const parts = minecraft.split('.').map((part) => Number(part))
  if (!Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return false
  if (parts[0] !== 1) return true
  return parts[1] >= 6
}

function newestFirst(loaders: LoaderVersion[]): LoaderVersion[] {
  return [...loaders].sort((a, b) => compareLoaderVersions(b.version, a.version))
}

function forgeRecommendation(promos: Record<string, string> | null, minecraft: string): string | null {
  if (!promos) return null
  return promos[`${minecraft}-recommended`] ?? promos[`${minecraft}-latest`] ?? null
}

interface RawForgeBuild {
  version?: unknown
  mcversion?: unknown
}

export async function forgeBuildArtifacts(minecraft: string, options: DownloadOptions = {}): Promise<string[]> {
  const builds = await fetchJson<RawForgeBuild[]>(`${FORGE_BUILDS_URL}/${encodeURIComponent(minecraft)}`, { ...options, source: 'official', retries: 0 })
  if (!Array.isArray(builds)) return []
  const versions = builds.flatMap((build) => (typeof build.version === 'string' ? [build.version] : []))
  return forgeArtifactsFor(versions.map((version) => `${minecraft}-${version}`), minecraft)
}

export async function listForgeLoaders(minecraft: string, options: DownloadOptions = {}): Promise<LoaderVersions> {
  let artifacts: string[] = []
  let reason: string | null = null
  try {
    artifacts = forgeArtifactsFor((await fetchForgeMetadata(options)).versions, minecraft)
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error instanceof HttpStatusError && error.status === 404) {
      return { minecraft, loaders: [], recommended: null, reason: `${minecraft} 没有 Forge 版本` }
    }
    artifacts = await forgeBuildArtifacts(minecraft, options).catch(() => [])
    if (!artifacts.length) throw error
    reason = 'Forge 官方 maven 元数据不可用，版本列表取自 BMCLAPI 构建列表'
  }
  if (!artifacts.length) {
    const builds = await forgeBuildArtifacts(minecraft, options).catch(() => [])
    if (builds.length) {
      artifacts = builds
      reason = 'Forge 官方 maven 元数据里没有该版本，版本列表取自 BMCLAPI 构建列表'
    }
  }
  const promos = await fetchForgePromotions(options)
  const loaders = newestFirst(artifacts.map((artifact) => ({ version: forgeLoaderVersion(minecraft, artifact), stable: true })))
  if (!loaders.length) return { minecraft, loaders: [], recommended: null, reason: `${minecraft} 没有 Forge 版本` }
  const promotion = forgeRecommendation(promos?.promos ?? null, minecraft)
  const recommended = promotion && loaders.some((loader) => loader.version === promotion) ? promotion : loaders[0].version
  return { minecraft, loaders, recommended, reason }
}

export function legacyNeoForgeMinecraft(version: string): string | null {
  const match = version.match(/^(\d+\.\d+\.\d+)-(\d[\w.+]*)$/)
  return match ? match[1] : null
}

export function neoForgeProject(version: string): 'forge' | 'neoforge' {
  return legacyNeoForgeMinecraft(version) ? 'forge' : 'neoforge'
}

export function neoForgeMinecraft(version: string): string | null {
  const legacy = legacyNeoForgeMinecraft(version)
  if (legacy) return legacy
  const [body] = version.split('+')
  const parts = body.split('-')[0].split('.').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return null
  const [major, minor, patch] = parts
  if (major >= 26) return patch > 0 ? `${major}.${minor}.${patch}` : `${major}.${minor}`
  if (major < 20 || major > 25) return null
  return minor > 0 ? `1.${major}.${minor}` : `1.${major}`
}

export function isNeoForgeStable(version: string): boolean {
  return !/-(alpha|beta|pre|rc)/i.test(version) && !version.includes('snapshot')
}

export function neoForgeInstallerUrl(version: string): string {
  const project = neoForgeProject(version)
  return `${NEOFORGE_MAVEN}/net/neoforged/${project}/${version}/${project}-${version}-installer.jar`
}

export function neoForgeCoordinate(version: string): string {
  return `net.neoforged:${neoForgeProject(version)}:${version}`
}

export function neoForgeSupported(minecraft: string): boolean {
  return !/^\d+\.\d+\.\d+$/.test(minecraft) || minecraft.startsWith('26.')
}

export async function listNeoForgeLoaders(minecraft: string, options: DownloadOptions = {}): Promise<LoaderVersions> {
  const [main, legacy] = await Promise.all([optionalMetadata(NEOFORGE_METADATA_URL, options), optionalMetadata(NEOFORGE_LEGACY_METADATA_URL, options)])
  if (!main && !legacy) throw new Error('NeoForge maven 元数据不可用')
  const versions = [...(main?.versions ?? []), ...(legacy?.versions ?? [])].filter((version) => neoForgeMinecraft(version) === minecraft)
  if (!versions.length) return { minecraft, loaders: [], recommended: null, reason: `${minecraft} 没有 NeoForge 版本` }
  const loaders = newestFirst(versions.map((version) => ({ version, stable: isNeoForgeStable(version) })))
  const recommended = loaders.find((loader) => loader.stable)?.version ?? null
  if (!recommended) return { minecraft, loaders, recommended: null, reason: `${minecraft} 只有 NeoForge 测试版（alpha/beta/pre）` }
  return { minecraft, loaders, recommended, reason: null }
}
