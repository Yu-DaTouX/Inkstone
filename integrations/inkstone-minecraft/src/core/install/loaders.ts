import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { downloadFiles, fetchJson, type DownloadOptions } from '../download/download.ts'
import { FABRIC_META, MODRINTH_API, QUILT_META } from '../download/sources.ts'
import { listFabricLoaders, listQuiltLoaders } from './list.ts'
import { fetchManifest, fetchVersion, mergeVersions, versionPlan, type RawVersion } from './meta.ts'
import { downloadPending, pendingFiles, toDownloadOptions } from './plan.ts'
import type { InstallFile, InstallResult, LoaderInstallOptions } from './types.ts'
import { assertFreeName, prepareInstance, versionDir, writeInstanceJson } from './vanilla.ts'

interface RawModrinthFile {
  url?: unknown
  filename?: unknown
  size?: unknown
  primary?: unknown
  hashes?: { sha1?: unknown }
}

interface RawModrinthVersion {
  version_number?: unknown
  game_versions?: unknown
  date_published?: unknown
  files?: unknown
}

export interface CompanionMod {
  label: string
  project: string
  version: string
  file: InstallFile
}

interface CompanionRequest extends DownloadOptions {
  project: string
  label: string
  loader: string
  minecraft: string
  modsDir: string
}

function modrinthUrl(project: string, loader: string, minecraft?: string): string {
  const query = [`loaders=${encodeURIComponent(JSON.stringify([loader]))}`]
  if (minecraft) query.push(`game_versions=${encodeURIComponent(JSON.stringify([minecraft]))}`)
  return `${MODRINTH_API}/project/${encodeURIComponent(project)}/version?${query.join('&')}`
}

function gameVersionsOf(version: RawModrinthVersion): string[] {
  return Array.isArray(version.game_versions) ? version.game_versions.filter((item): item is string => typeof item === 'string') : []
}

function publishedOf(version: RawModrinthVersion): string {
  return typeof version.date_published === 'string' ? version.date_published : ''
}

export async function resolveCompanionMod(request: CompanionRequest): Promise<CompanionMod | null> {
  const pick = async (minecraft: string | undefined, options: DownloadOptions): Promise<RawModrinthVersion[]> => {
    const raw = await fetchJson<unknown>(modrinthUrl(request.project, request.loader, minecraft), options)
    return Array.isArray(raw) ? (raw as RawModrinthVersion[]) : []
  }
  const direct = await pick(request.minecraft, request)
  const versions = direct.length ? direct : (await pick(undefined, request)).filter((version) => gameVersionsOf(version).includes(request.minecraft))
  const version = [...versions].sort((a, b) => publishedOf(b).localeCompare(publishedOf(a)))[0]
  if (!version) return null
  const files = Array.isArray(version.files) ? (version.files as RawModrinthFile[]) : []
  const chosen = files.find((file) => file.primary === true) ?? files[0]
  if (!chosen || typeof chosen.url !== 'string' || typeof chosen.filename !== 'string') throw new Error(`${request.label} 的 ${String(version.version_number)} 没有可下载的文件`)
  return {
    label: request.label,
    project: request.project,
    version: typeof version.version_number === 'string' ? version.version_number : 'unknown',
    file: {
      url: chosen.url,
      dest: join(request.modsDir, chosen.filename),
      sha1: typeof chosen.hashes?.sha1 === 'string' ? chosen.hashes.sha1 : null,
      size: typeof chosen.size === 'number' ? chosen.size : null
    }
  }
}

async function reuseJar(folder: string, baseId: string, jar: InstallFile | null): Promise<void> {
  if (!jar || existsSync(jar.dest)) return
  const source = join(folder, 'versions', baseId, `${baseId}.jar`)
  if (!existsSync(source)) return
  if (jar.size != null && (await stat(source)).size !== jar.size) return
  await mkdir(dirname(jar.dest), { recursive: true })
  try {
    await link(source, jar.dest)
  } catch {
    await copyFile(source, jar.dest)
  }
}

async function installLoader(kind: 'fabric' | 'quilt', options: LoaderInstallOptions): Promise<InstallResult> {
  const folder = options.folder
  const download = toDownloadOptions(options)
  const listing = kind === 'fabric' ? await listFabricLoaders(options.version, download) : await listQuiltLoaders(options.version, download)
  if (!listing.loaders.length) throw new Error(listing.reason ?? `${options.version} 没有 ${kind} 版本`)
  const loaderVersion = options.loader ?? listing.recommended
  if (!loaderVersion) throw new Error(`没有可用的 ${kind} 加载器版本`)
  if (options.loader && !listing.loaders.some((entry) => entry.version === options.loader)) {
    throw new Error(`${options.version} 没有 ${kind} ${options.loader}`)
  }
  const label = kind === 'fabric' ? 'Fabric' : 'Quilt'
  const name = options.name ?? `${options.version}-${label} ${loaderVersion}`
  assertFreeName(folder, name)
  const manifest = await fetchManifest(download)
  const base = await fetchVersion(folder, options.version, { ...download, manifest })
  const meta = kind === 'fabric' ? FABRIC_META : QUILT_META
  const profile = await fetchJson<RawVersion>(`${meta}/versions/loader/${encodeURIComponent(options.version)}/${encodeURIComponent(loaderVersion)}/profile/json`, download)
  const merged = mergeVersions(base, profile, name)
  const plan = await versionPlan(folder, merged, name, download)
  await reuseJar(folder, options.version, plan.jar)
  const isolated = options.isolated ?? true
  const pending = await pendingFiles(plan.files, 'sha1', { concurrency: options.concurrency, signal: options.signal, onProgress: options.onProgress })
  const report = await downloadPending(pending, download)
  await prepareInstance(folder, name, isolated)
  const mods: string[] = []
  let note: string | null = null
  if (options.companions !== false) {
    const modsDir = join(versionDir(folder, name), 'mods')
    const companionLabel = kind === 'fabric' ? 'Fabric API' : 'QSL'
    const companion = await resolveCompanionMod({ ...download, project: kind === 'fabric' ? 'fabric-api' : 'qsl', label: companionLabel, loader: kind, minecraft: options.version, modsDir })
    if (companion) {
      await downloadFiles([companion.file], download)
      mods.push(basename(companion.file.dest))
    } else {
      note = `${companionLabel} 没有 ${options.version} 版本，已跳过`
    }
  }
  await writeInstanceJson(folder, name, merged)
  return {
    name,
    minecraft: options.version,
    loader: kind,
    loaderVersion,
    isolated,
    total: plan.files.length + mods.length,
    downloaded: pending.length + mods.length,
    skipped: plan.files.length - pending.length,
    bytes: report.bytes,
    mods,
    note
  }
}

export async function installFabric(options: LoaderInstallOptions): Promise<InstallResult> {
  return installLoader('fabric', options)
}

export async function installQuilt(options: LoaderInstallOptions): Promise<InstallResult> {
  return installLoader('quilt', options)
}
