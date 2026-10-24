// Portions of this file are derived from @xmcl/installer (packages/installer/forge.ts,
// packages/installer/neoforge.ts, packages/installer/profile.ts),
// Copyright (c) 2023 CI010, licensed under the MIT License.
// Source: https://github.com/Voxelum/minecraft-launcher-core-node

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ZipReader } from '../dev/zip.ts'
import { downloadFiles, isAbortError, type DownloadOptions, type DownloadReport } from '../download/download.ts'
import { detectJava, pickJava, resolveJava } from '../java.ts'
import { forgeMirrorUrl, isForgeMavenUrl } from './forge-meta.ts'
import { assetPlan, currentPlatform, dedupeFiles, fetchVersion, libraryAllowed, libraryPath, nativeClassifier, type Platform, type RawLibrary, type RawVersion } from './meta.ts'
import { pendingFiles, sha1OfFile, toDownloadOptions } from './plan.ts'
import { libraryDiskPath, mavenFilePath, parseInstallProfile, parseMaven, resolveProcessors, runProcessors, type InstallProfile } from './processors.ts'
import type { InstallFile, InstallOptions } from './types.ts'
import { assertFreeName, instanceJsonPath, installVanilla, prepareInstance, writeInstanceJson } from './vanilla.ts'

export type ForgeProject = 'forge' | 'neoforge'

export interface ForgeInstallRequest extends InstallOptions {
  minecraft: string
  project: ForgeProject
  version: string
  artifact: string
  installerUrl: string
  coordinate: string
  name: string
  isolated?: boolean
  javaPath?: string
}

export interface ForgeInstallResult {
  name: string
  minecraft: string
  loader: ForgeProject
  loaderVersion: string
  isolated: boolean
  total: number
  downloaded: number
  skipped: number
  bytes: number
  mods: string[]
  note: string | null
  processors: number
  java: string | null
  legacy: boolean
  backfilled: number
}

const STEP_TOTAL = 6

function sha1Of(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex')
}

function sumReports(reports: DownloadReport[]): DownloadReport {
  return reports.reduce<DownloadReport>(
    (sum, report) => ({
      files: sum.files + report.files,
      downloaded: sum.downloaded + report.downloaded,
      bytes: sum.bytes + report.bytes,
      sources: {
        official: {
          ok: sum.sources.official.ok + report.sources.official.ok,
          failed: sum.sources.official.failed + report.sources.official.failed,
          rate: null
        },
        bmclapi: {
          ok: sum.sources.bmclapi.ok + report.sources.bmclapi.ok,
          failed: sum.sources.bmclapi.failed + report.sources.bmclapi.failed,
          rate: null
        }
      }
    }),
    { files: 0, downloaded: 0, bytes: 0, sources: { official: { ok: 0, failed: 0, rate: null }, bmclapi: { ok: 0, failed: 0, rate: null } } }
  )
}

async function complete(file: InstallFile): Promise<boolean> {
  try {
    const info = await stat(file.dest)
    if (!info.isFile() || info.size === 0) return false
    if (file.size != null && info.size !== file.size) return false
    return true
  } catch {
    return false
  }
}

async function downloadForgeMaven(files: InstallFile[], options: DownloadOptions): Promise<DownloadReport> {
  if (options.source === 'official') return downloadFiles(files, options)
  const mirrored = files.map((file) => ({ ...file, url: forgeMirrorUrl(file.url, options.mirrorOrigin) ?? file.url }))
  try {
    return await downloadFiles(mirrored, options)
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error) || options.source === 'bmclapi') throw error
    const remaining: InstallFile[] = []
    for (const file of files) if (!(await complete(file))) remaining.push(file)
    return downloadFiles(remaining, { ...options, source: 'official' })
  }
}

export async function downloadWithForgeMirror(files: InstallFile[], options: DownloadOptions): Promise<DownloadReport> {
  const forgeFiles: InstallFile[] = []
  const otherFiles: InstallFile[] = []
  for (const file of files) {
    if (file.url && isForgeMavenUrl(file.url)) forgeFiles.push(file)
    else otherFiles.push(file)
  }
  const reports: DownloadReport[] = []
  if (otherFiles.length) reports.push(await downloadFiles(otherFiles, options))
  if (forgeFiles.length) reports.push(await downloadForgeMaven(forgeFiles, options))
  return sumReports(reports)
}

function librariesOf(version: RawVersion): RawLibrary[] {
  return Array.isArray(version.libraries) ? (version.libraries as RawLibrary[]) : []
}


function argList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function mergeLoaderJson(base: RawVersion, loader: RawVersion, id: string): RawVersion {
  const merged: RawVersion = {
    ...base,
    id,
    mainClass: loader.mainClass ?? base.mainClass,
    libraries: [...librariesOf(base), ...librariesOf(loader)]
  }
  delete merged.inheritsFrom
  if (typeof base.id === 'string') merged.clientVersion = base.id
  if (loader.javaVersion ?? base.javaVersion) merged.javaVersion = loader.javaVersion ?? base.javaVersion
  if (!loader.arguments && typeof loader.minecraftArguments === 'string') {
    merged.minecraftArguments = loader.minecraftArguments
    delete merged.arguments
  } else {
    const baseArguments = base.arguments ?? {}
    const loaderArguments = loader.arguments ?? {}
    merged.arguments = {
      game: [...argList(baseArguments.game), ...argList(loaderArguments.game)],
      jvm: [...argList(baseArguments.jvm), ...argList(loaderArguments.jvm)]
    }
    delete merged.minecraftArguments
  }
  if (loader.releaseTime) merged.releaseTime = loader.releaseTime
  if (loader.time) merged.time = loader.time
  if (loader.assets && !merged.assets) merged.assets = loader.assets
  return merged
}

function declaredChecksums(libraries: unknown[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const library of libraries) {
    if (!library || typeof library !== 'object') continue
    const entry = library as RawLibrary
    const name = typeof entry.name === 'string' ? entry.name : ''
    const artifact = entry.downloads?.artifact
    const sha1 = artifact && typeof artifact.sha1 === 'string' ? artifact.sha1.toLowerCase() : ''
    if (!name || !sha1) continue
    try {
      result.set(mavenFilePath(name), sha1)
    } catch {
    }
  }
  return result
}

async function extractMavenEntries(zip: ZipReader, folder: string, libraries: unknown[]): Promise<string[]> {
  const checksums = declaredChecksums(libraries)
  const written: string[] = []
  await zip.readAll(
    (name) => name.startsWith('maven/') && !name.endsWith('/'),
    async (name, data) => {
      const relative = name.slice('maven/'.length)
      if (!relative) return
      const dest = join(folder, 'libraries', ...relative.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, data)
      const expected = checksums.get(relative)
      if (expected && sha1Of(data) !== expected) throw new Error(`安装器内嵌的 ${relative} sha1 不符（期望 ${expected}）`)
      written.push(dest)
    }
  )
  return written
}

async function extractClientLzma(zip: ZipReader, folder: string, coordinate: string): Promise<string | null> {
  const data = await zip.read('data/client.lzma')
  if (!data) return null
  const dest = libraryDiskPath(folder, `${coordinate}:clientdata@lzma`)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, data)
  return dest
}

async function extractLegacyUniversal(zip: ZipReader, folder: string, profile: InstallProfile, loaderJson: RawVersion): Promise<string[]> {
  const filePath = profile.filePath
  if (!filePath) throw new Error('旧式 install_profile.json 缺少 install.filePath')
  const data = await zip.read(filePath)
  if (!data) throw new Error(`安装器里没有 ${filePath}`)
  const forgeLibrary = librariesOf(loaderJson)
    .map((library) => (typeof library.name === 'string' ? library.name : ''))
    .find((name) => name.startsWith('net.minecraftforge:forge') || name.startsWith('net.minecraftforge:minecraftforge'))
  if (!forgeLibrary) throw new Error('旧式 install_profile.json 里没有 net.minecraftforge:forge 库')
  const dest = libraryDiskPath(folder, forgeLibrary)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, data)
  const coordinate = parseMaven(forgeLibrary)
  const relative = mavenFilePath(forgeLibrary)
  const entry = librariesOf(loaderJson).find((library) => library.name === forgeLibrary)
  if (entry) {
    const base = typeof (entry as { url?: unknown }).url === 'string' ? String((entry as { url?: unknown }).url).replace(/\/$/, '') : 'https://maven.minecraftforge.net'
    entry.downloads = {
      artifact: {
        url: `${base}/${relative.slice(0, relative.lastIndexOf('/'))}/${coordinate.artifact}-${coordinate.version}-universal.jar`,
        path: relative,
        sha1: sha1Of(data),
        size: data.length
      }
    }
  }
  return [dest]
}

async function backfillLegacyChecksums(folder: string, libraries: RawLibrary[]): Promise<number> {
  let filled = 0
  for (const library of libraries) {
    if (!library || typeof library !== 'object') continue
    const entry = library as RawLibrary & { url?: unknown }
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (!name) continue
    const artifact = entry.downloads?.artifact
    if (artifact && typeof artifact.sha1 === 'string' && artifact.sha1) continue
    const relative = artifact && typeof artifact.path === 'string' ? artifact.path : mavenFilePath(name)
    const dest = join(folder, 'libraries', ...relative.split('/'))
    if (!existsSync(dest)) continue
    const declared = typeof artifact?.url === 'string' && artifact.url ? artifact.url : ''
    const legacyBase = typeof entry.url === 'string' && entry.url ? entry.url.replace(/\/$/, '') : ''
    entry.downloads = {
      ...(entry.downloads ?? {}),
      artifact: {
        url: declared || (legacyBase ? `${legacyBase}/${relative}` : `https://libraries.minecraft.net/${relative}`),
        path: relative,
        sha1: await sha1OfFile(dest),
        size: (await stat(dest)).size
      }
    }
    filled += 1
  }
  return filled
}

export function libraryFilesExact(folder: string, libraries: unknown, platform: Platform): InstallFile[] {
  const files: InstallFile[] = []
  if (!Array.isArray(libraries)) return files
  for (const library of libraries as RawLibrary[]) {
    if (!library || typeof library !== 'object') continue
    if (!libraryAllowed(library, platform)) continue
    const name = typeof library.name === 'string' ? library.name : ''
    const artifact = library.downloads?.artifact
    if (name && artifact && typeof artifact.url === 'string' && artifact.url) {
      const relative = typeof artifact.path === 'string' ? artifact.path : mavenFilePath(name)
      files.push({
        url: artifact.url,
        dest: join(folder, 'libraries', ...relative.split('/')),
        sha1: typeof artifact.sha1 === 'string' ? artifact.sha1 : null,
        size: typeof artifact.size === 'number' ? artifact.size : null
      })
    } else if (name && typeof library.url === 'string' && library.url) {
      const relative = mavenFilePath(name)
      files.push({ url: `${library.url.replace(/\/$/, '')}/${relative}`, dest: join(folder, 'libraries', ...relative.split('/')), sha1: null, size: null })
    } else if (name && !library.downloads && !(typeof library.url === 'string' && library.url)) {
      const relative = mavenFilePath(name)
      files.push({ url: `https://libraries.minecraft.net/${relative}`, dest: join(folder, 'libraries', ...relative.split('/')), sha1: null, size: null })
    }
    const classifier = nativeClassifier(library, platform)
    const native = classifier ? library.downloads?.classifiers?.[classifier] : undefined
    if (name && classifier && native && typeof native.url === 'string' && native.url) {
      const relative = libraryPath(`${name}:${classifier}`)
      files.push({
        url: native.url,
        dest: join(folder, 'libraries', ...relative.split('/')),
        sha1: typeof native.sha1 === 'string' ? native.sha1 : null,
        size: typeof native.size === 'number' ? native.size : null
      })
    }
  }
  return dedupeFiles(files)
}

function clientJar(folder: string, version: RawVersion, name: string): InstallFile | null {
  const client = version.downloads?.client
  if (!client || typeof client.url !== 'string' || !client.url) return null
  return {
    url: client.url,
    dest: join(folder, 'versions', name, `${name}.jar`),
    sha1: typeof client.sha1 === 'string' ? client.sha1 : null,
    size: typeof client.size === 'number' ? client.size : null
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

export async function pickInstallerJava(paths: string[], requiredMajor: number, label: string): Promise<string> {
  const configured = paths.length > 0 ? pickJava(await detectJava(paths, false), requiredMajor, null) : undefined
  const picked = configured ?? pickJava(await detectJava([]), requiredMajor, null)
  if (!picked) throw new Error(`需要 Java ${requiredMajor} 来运行 ${label} 安装器，请在设置 → Java 里添加一个 Java ${requiredMajor}`)
  return picked.path
}

async function resolveInstallerJava(request: ForgeInstallRequest, requiredMajor: number, label: string): Promise<string> {
  if (request.javaPath) {
    const resolved = await resolveJava(request.javaPath)
    if (!resolved) throw new Error(`指定的 Java 不可用：${request.javaPath}`)
    if (resolved.majorVersion < requiredMajor) throw new Error(`需要 Java ${requiredMajor} 来运行 ${label} 安装器，指定的是 Java ${resolved.majorVersion}`)
    return resolved.path
  }
  return pickInstallerJava(request.installerJavaPaths ?? [], requiredMajor, label)
}

async function ensureVanilla(request: ForgeInstallRequest, label: string): Promise<void> {
  if (existsSync(instanceJsonPath(request.folder, request.minecraft))) return
  request.onProgress?.({ done: 1, total: STEP_TOTAL, unit: 'steps' }, `安装原版 ${request.minecraft}`)
  await installVanilla({
    folder: request.folder,
    version: request.minecraft,
    name: request.minecraft,
    signal: request.signal,
    source: request.source,
    concurrency: request.concurrency,
    fetchImpl: request.fetchImpl,
    mirrorOrigin: request.mirrorOrigin,
    stats: request.stats,
    onProgress: (progress, detail) => request.onProgress?.(progress, detail ? `${label}：原版 ${request.minecraft} ${detail}` : `${label}：原版 ${request.minecraft}`)
  })
}

export async function installForgeLoader(request: ForgeInstallRequest): Promise<ForgeInstallResult> {
  const label = request.project === 'forge' ? 'Forge' : 'NeoForge'
  const folder = request.folder
  const download = toDownloadOptions(request)
  const isolated = request.isolated ?? true
  assertFreeName(folder, request.name)
  await ensureVanilla(request, label)
  const base = await fetchVersion(folder, request.minecraft, { ...download, preferLocal: true })
  request.onProgress?.({ done: 2, total: STEP_TOTAL, unit: 'steps' }, `下载 ${label} 安装器 ${request.version}`)
  const installerPath = libraryDiskPath(folder, `${request.coordinate}:installer`)
  const installerReport = await downloadWithForgeMirror([{ url: request.installerUrl, dest: installerPath, sha1: null, size: null }], download)
  request.onProgress?.({ done: 3, total: STEP_TOTAL, unit: 'steps' }, '解析安装器')
  const zip = await ZipReader.open(installerPath)
  const profileRaw = await zip.read('install_profile.json')
  if (!profileRaw) throw new Error(`${label} 安装器里没有 install_profile.json`)
  const profile = parseInstallProfile(JSON.parse(profileRaw.toString('utf8')))
  let loaderJson: RawVersion
  const extracted: string[] = []
  if (profile.versionInfo) {
    loaderJson = profile.versionInfo
    extracted.push(...(await extractLegacyUniversal(zip, folder, profile, loaderJson)))
  } else {
    const versionRaw = await zip.read(profile.jsonPath)
    if (!versionRaw) throw new Error(`安装器里没有 ${profile.jsonPath}`)
    loaderJson = JSON.parse(versionRaw.toString('utf8')) as RawVersion
    extracted.push(...(await extractMavenEntries(zip, folder, [...librariesOf(loaderJson), ...(profile.libraries as unknown[])])))
  }
  const merged = mergeLoaderJson(base, loaderJson, request.name)
  const backfilled = await backfillLegacyChecksums(folder, librariesOf(merged))
  request.onProgress?.({ done: 4, total: STEP_TOTAL, unit: 'steps' }, '下载库文件')
  const platform = currentPlatform()
  const jar = clientJar(folder, merged, request.name)
  await reuseJar(folder, request.minecraft, jar)
  const assets = await assetPlan(folder, merged, download)
  const extractedPaths = new Set(extracted)
  const files = dedupeFiles([
    ...(jar ? [jar] : []),
    ...libraryFilesExact(folder, merged.libraries, platform),
    ...libraryFilesExact(folder, profile.libraries, platform),
    ...(assets ? [assets.index, ...assets.objects] : [])
  ]).filter((file) => Boolean(file.url) && !extractedPaths.has(file.dest))
  const pending = await pendingFiles(files, 'sha1', { concurrency: request.concurrency, signal: request.signal, onProgress: request.onProgress })
  const libraryReport = await downloadWithForgeMirror(pending, download)
  const clientLzma = profile.versionInfo ? null : await extractClientLzma(zip, folder, request.coordinate)
  let ranProcessors = 0
  let javaPath: string | null = null
  if (!profile.versionInfo && profile.processors.length) {
    request.onProgress?.({ done: 5, total: STEP_TOTAL, unit: 'steps' }, '运行安装处理器')
    const requiredMajor = typeof base.javaVersion?.majorVersion === 'number' ? base.javaVersion.majorVersion : 8
    javaPath = await resolveInstallerJava(request, requiredMajor, label)
    const resolved = resolveProcessors(profile, {
      folder,
      minecraft: request.minecraft,
      side: 'client',
      installer: installerPath,
      clientLzma
    })
    const result = await runProcessors(resolved, {
      javaPath,
      cwd: folder,
      signal: request.signal,
      onProgress: request.onProgress,
      verifyOutputs: true
    })
    ranProcessors = result.ran
  }
  request.onProgress?.({ done: 6, total: STEP_TOTAL, unit: 'steps' }, '写入版本')
  await prepareInstance(folder, request.name, isolated)
  await writeInstanceJson(folder, request.name, merged)
  const reports = sumReports([installerReport, libraryReport])
  return {
    name: request.name,
    minecraft: request.minecraft,
    loader: request.project,
    loaderVersion: request.version,
    isolated,
    total: files.length + extracted.length,
    downloaded: reports.downloaded + extracted.length,
    skipped: files.length - pending.length,
    bytes: reports.bytes,
    mods: [],
    note: null,
    processors: ranProcessors,
    java: javaPath,
    legacy: profile.versionInfo !== null,
    backfilled
  }
}
