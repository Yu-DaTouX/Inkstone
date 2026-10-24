import { existsSync } from 'node:fs'
import { release } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchJson, type DownloadOptions } from '../download/download.ts'
import { MANIFEST_URL } from '../download/sources.ts'
import type { InstallFile } from './types.ts'

export interface RawFile {
  url?: unknown
  sha1?: unknown
  size?: unknown
  path?: unknown
}

export interface RawDownloads {
  artifact?: RawFile
  classifiers?: Record<string, RawFile>
}

export interface RawRules {
  action?: unknown
  os?: { name?: unknown; arch?: unknown; version?: unknown }
  features?: Record<string, unknown>
}

export interface RawLibrary {
  name?: unknown
  url?: unknown
  downloads?: RawDownloads
  rules?: unknown
  natives?: unknown
  extract?: unknown
}

export interface RawVersion {
  id?: unknown
  inheritsFrom?: unknown
  clientVersion?: unknown
  mainClass?: unknown
  type?: unknown
  assets?: unknown
  assetIndex?: { id?: unknown; sha1?: unknown; size?: unknown; url?: unknown }
  downloads?: { client?: RawFile; server?: RawFile }
  libraries?: unknown
  arguments?: { game?: unknown; jvm?: unknown }
  minecraftArguments?: unknown
  javaVersion?: { majorVersion?: unknown }
  releaseTime?: unknown
  time?: unknown
}

export interface Platform {
  os: 'windows' | 'osx' | 'linux'
  arch: 'x86' | 'x64' | 'arm64'
  version: string
}

export function currentPlatform(): Platform {
  const name = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  const arch = process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'arm64' : 'x64'
  return { os: name, arch, version: release() }
}

export function libraryPath(name: string): string {
  const [group, artifact, version, classifier] = name.split(':')
  const file = classifier ? `${artifact}-${version}-${classifier}.jar` : `${artifact}-${version}.jar`
  return `${group.replaceAll('.', '/')}/${artifact}/${version}/${file}`
}

export function libraryAllowed(library: RawLibrary, platform: Platform): boolean {
  if (!Array.isArray(library.rules)) return true
  let allowed = false
  for (const rule of library.rules as RawRules[]) {
    if (!rule || typeof rule !== 'object') continue
    if (rule.features && Object.keys(rule.features).length > 0) continue
    if (rule.os) {
      const name = typeof rule.os.name === 'string' ? rule.os.name : ''
      if (name && name !== platform.os) continue
      const arch = typeof rule.os.arch === 'string' ? rule.os.arch : ''
      if (arch && !new RegExp(arch).test(platform.arch)) continue
      const version = typeof rule.os.version === 'string' ? rule.os.version : ''
      if (version && !new RegExp(version).test(platform.version)) continue
    }
    allowed = rule.action === 'allow'
  }
  return allowed
}

export function nativeClassifier(library: RawLibrary, platform: Platform): string | null {
  if (!library.natives || typeof library.natives !== 'object') return null
  const value = (library.natives as Record<string, unknown>)[platform.os]
  if (typeof value !== 'string') return null
  return value.replace('${arch}', platform.arch === 'x86' ? '32' : '64')
}

function fileOf(dest: string, file: RawFile | undefined): InstallFile | null {
  if (!file || typeof file.url !== 'string') return null
  return {
    url: file.url,
    dest,
    sha1: typeof file.sha1 === 'string' ? file.sha1 : null,
    size: typeof file.size === 'number' ? file.size : null
  }
}

export function libraryFiles(folder: string, libraries: unknown, platform: Platform): InstallFile[] {
  const files: InstallFile[] = []
  if (!Array.isArray(libraries)) return files
  for (const library of libraries as RawLibrary[]) {
    if (!library || typeof library !== 'object') continue
    if (!libraryAllowed(library, platform)) continue
    const name = typeof library.name === 'string' ? library.name : ''
    const artifact = library.downloads?.artifact
    if (name && artifact && typeof artifact.url === 'string') {
      files.push({ url: artifact.url, dest: join(folder, 'libraries', ...libraryPath(name).split('/')), sha1: typeof artifact.sha1 === 'string' ? artifact.sha1 : null, size: typeof artifact.size === 'number' ? artifact.size : null })
    } else if (name && typeof library.url === 'string') {
      files.push({ url: `${library.url.replace(/\/$/, '')}/${libraryPath(name)}`, dest: join(folder, 'libraries', ...libraryPath(name).split('/')), sha1: null, size: null })
    }
    const classifier = nativeClassifier(library, platform)
    if (name && classifier) {
      const native = fileOf(join(folder, 'libraries', ...libraryPath(`${name}:${classifier}`).split('/')), library.downloads?.classifiers?.[classifier])
      if (native) files.push(native)
    }
  }
  return dedupeFiles(files)
}

export function dedupeFiles(files: InstallFile[]): InstallFile[] {
  const seen = new Map<string, InstallFile>()
  for (const file of files) if (!seen.has(file.dest)) seen.set(file.dest, file)
  return [...seen.values()]
}

export interface AssetPlan {
  indexId: string
  index: InstallFile
  objects: InstallFile[]
}

interface RawAssetIndex {
  objects?: Record<string, { hash?: unknown; size?: unknown }>
  virtual?: unknown
  map_to_resources?: unknown
}

export async function assetPlan(folder: string, version: RawVersion, options: DownloadOptions & { preferLocal?: boolean } = {}): Promise<AssetPlan | null> {
  const raw = version.assetIndex
  if (!raw || typeof raw.id !== 'string' || typeof raw.url !== 'string') return null
  const index: InstallFile = {
    url: raw.url,
    dest: join(folder, 'assets', 'indexes', `${raw.id}.json`),
    sha1: typeof raw.sha1 === 'string' ? raw.sha1 : null,
    size: typeof raw.size === 'number' ? raw.size : null
  }
  let content: RawAssetIndex | null = null
  if (options.preferLocal && existsSync(index.dest)) {
    try {
      content = JSON.parse(await readFile(index.dest, 'utf8')) as RawAssetIndex
    } catch {
      content = null
    }
  }
  if (!content) {
    if (options.preferLocal) return { indexId: raw.id, index, objects: [] }
    content = await fetchJson<RawAssetIndex>(index.url, options)
  }
  const objects: InstallFile[] = []
  for (const entry of Object.values(content.objects ?? {})) {
    if (!entry || typeof entry.hash !== 'string') continue
    objects.push({
      url: `https://resources.download.minecraft.net/${entry.hash.slice(0, 2)}/${entry.hash}`,
      dest: join(folder, 'assets', 'objects', entry.hash.slice(0, 2), entry.hash),
      sha1: entry.hash,
      size: typeof entry.size === 'number' ? entry.size : null
    })
  }
  return { indexId: raw.id, index, objects: dedupeFiles(objects) }
}

export interface VersionPlan {
  files: InstallFile[]
  jar: InstallFile | null
  assetIndex: string | null
  libraries: number
  assets: number
}

export async function versionPlan(folder: string, version: RawVersion, name: string, options: DownloadOptions & { preferLocal?: boolean } = {}): Promise<VersionPlan> {
  const jar = fileOf(join(folder, 'versions', name, `${name}.jar`), version.downloads?.client)
  const libraries = libraryFiles(folder, version.libraries, currentPlatform())
  const assets = await assetPlan(folder, version, options)
  const files = [...(jar ? [jar] : []), ...libraries, ...(assets ? [assets.index, ...assets.objects] : [])]
  return {
    files: dedupeFiles(files),
    jar,
    assetIndex: assets?.indexId ?? null,
    libraries: libraries.length,
    assets: assets?.objects.length ?? 0
  }
}

export type ManifestVersion = { id: string; type: string; url: string; sha1: string | null; size: number | null; releaseTime: string | null }

export interface RawManifest {
  latest?: { release?: unknown; snapshot?: unknown }
  versions?: Array<{ id?: unknown; type?: unknown; url?: unknown; sha1?: unknown; size?: unknown; releaseTime?: unknown }>
}

export async function fetchManifest(options: DownloadOptions = {}): Promise<RawManifest> {
  return fetchJson<RawManifest>(MANIFEST_URL, options)
}

export function manifestEntries(manifest: RawManifest): ManifestVersion[] {
  return (manifest.versions ?? [])
    .filter((entry) => typeof entry.id === 'string' && typeof entry.url === 'string')
    .map((entry) => ({
      id: String(entry.id),
      type: typeof entry.type === 'string' ? entry.type : 'release',
      url: String(entry.url),
      sha1: typeof entry.sha1 === 'string' ? entry.sha1 : null,
      size: typeof entry.size === 'number' ? entry.size : null,
      releaseTime: typeof entry.releaseTime === 'string' ? entry.releaseTime : null
    }))
}

export async function fetchVersion(folder: string, id: string, options: DownloadOptions & { manifest?: RawManifest; preferLocal?: boolean } = {}): Promise<RawVersion> {
  const local = join(folder, 'versions', id, `${id}.json`)
  if (options.preferLocal && existsSync(local)) return JSON.parse(await readFile(local, 'utf8')) as RawVersion
  const manifest = options.manifest ?? (await fetchManifest(options))
  const entry = manifestEntries(manifest).find((item) => item.id === id)
  if (!entry) throw new Error(`版本清单里没有 ${id}`)
  return fetchJson<RawVersion>(entry.url, options)
}

function libraryList(version: RawVersion): RawLibrary[] {
  return Array.isArray(version.libraries) ? (version.libraries as RawLibrary[]) : []
}

export function mergeVersions(base: RawVersion, profile: RawVersion, id: string): RawVersion {
  const merged: RawVersion = { ...base, id, mainClass: profile.mainClass ?? base.mainClass, libraries: [...libraryList(base), ...libraryList(profile)] }
  delete merged.inheritsFrom
  if (typeof base.id === 'string') merged.clientVersion = base.id
  const baseArguments = base.arguments ?? {}
  const profileArguments = profile.arguments ?? {}
  merged.arguments = {
    game: [...(Array.isArray(baseArguments.game) ? baseArguments.game : []), ...(Array.isArray(profileArguments.game) ? profileArguments.game : [])],
    jvm: [...(Array.isArray(baseArguments.jvm) ? baseArguments.jvm : []), ...(Array.isArray(profileArguments.jvm) ? profileArguments.jvm : [])]
  }
  if (profile.minecraftArguments) merged.minecraftArguments = profile.minecraftArguments
  if (profile.releaseTime) merged.releaseTime = profile.releaseTime
  if (profile.time) merged.time = profile.time
  return merged
}
