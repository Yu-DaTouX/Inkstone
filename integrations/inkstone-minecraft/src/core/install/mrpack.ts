import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import type { ModpackInstallResult, ModpackLoader, ModpackSummary } from '../../shared/download-api.ts'
import { ZipReader } from '../dev/zip.ts'
import { downloadFiles } from '../download/download.ts'
import { installFabric, installQuilt } from './loaders.ts'
import { installForge } from './forge.ts'
import { installNeoForge } from './neoforge.ts'
import { pendingFiles } from './plan.ts'
import { installVanilla } from './vanilla.ts'
import type { InstallFile, InstallOptions, ProgressListener } from './types.ts'

export interface ModpackFile {
  path: string
  url: string
  sha1: string | null
  size: number | null
}

export interface ModpackIndex {
  formatVersion: number
  name: string | null
  versionId: string | null
  summary: string | null
  minecraft: string
  loader: ModpackLoader
  loaderVersion: string | null
  files: ModpackFile[]
  skippedFiles: number
}

export interface ModpackImportOptions extends InstallOptions {
  folder: string
  path: string
  name?: string
  isolated?: boolean
  installerJavaPaths?: string[]
}

const STEP_TOTAL = 4
const CLIENT_UNSUPPORTED = 'unsupported'

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function unsafeRelative(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) return true
  const normalized = posix.normalize(path.replace(/\\/g, '/'))
  return normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')
}

function loaderOf(dependencies: Record<string, unknown>): { loader: ModpackLoader; loaderVersion: string | null } {
  const fabric = text(dependencies['fabric-loader'])
  if (fabric) return { loader: 'fabric', loaderVersion: fabric }
  const quilt = text(dependencies['quilt-loader'])
  if (quilt) return { loader: 'quilt', loaderVersion: quilt }
  const forge = text(dependencies.forge)
  if (forge) return { loader: 'forge', loaderVersion: forge }
  const neoforge = text(dependencies.neoforge)
  if (neoforge) return { loader: 'neoforge', loaderVersion: neoforge }
  return { loader: 'vanilla', loaderVersion: null }
}

export function parseModpackIndex(raw: unknown): ModpackIndex {
  if (!raw || typeof raw !== 'object') throw new Error('modrinth.index.json 不是对象')
  const record = raw as Record<string, unknown>
  const formatVersion = Number(record.formatVersion)
  if (!Number.isFinite(formatVersion) || formatVersion !== 1) throw new Error(`不支持的整合包格式 version ${record.formatVersion ?? '?'}`)
  const game = typeof record.game === 'string' ? record.game : 'minecraft'
  if (game !== 'minecraft') throw new Error(`整合包目标不是 Minecraft：${game}`)
  const dependencies = record.dependencies && typeof record.dependencies === 'object' ? (record.dependencies as Record<string, unknown>) : {}
  const minecraft = text(dependencies.minecraft)
  if (!minecraft) throw new Error('整合包没有写 Minecraft 版本')
  const { loader, loaderVersion } = loaderOf(dependencies)
  const files: ModpackFile[] = []
  let skippedFiles = 0
  const list = Array.isArray(record.files) ? record.files : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const path = text(entry.path)
    if (!path) continue
    const env = entry.env && typeof entry.env === 'object' ? (entry.env as Record<string, unknown>) : {}
    if (env.client === CLIENT_UNSUPPORTED) {
      skippedFiles += 1
      continue
    }
    if (unsafeRelative(path)) throw new Error(`整合包里的文件路径不安全：${path}`)
    const downloads = Array.isArray(entry.downloads) ? entry.downloads.filter((url): url is string => typeof url === 'string' && url.startsWith('https://')) : []
    const url = downloads[0]
    if (!url) throw new Error(`${path} 没有可用的下载地址`)
    const hashes = entry.hashes && typeof entry.hashes === 'object' ? (entry.hashes as Record<string, unknown>) : {}
    const sha1 = text(hashes.sha1)
    const size = Number(entry.fileSize)
    files.push({ path: posix.normalize(path.replace(/\\/g, '/')), url, sha1, size: Number.isFinite(size) && size > 0 ? size : null })
  }
  return {
    formatVersion,
    name: text(record.name),
    versionId: text(record.versionId),
    summary: text(record.summary),
    minecraft,
    loader,
    loaderVersion,
    files,
    skippedFiles
  }
}

function overrideEntries(zip: ZipReader): string[] {
  return [...zip.entries.keys()].filter((name) => !name.endsWith('/') && (name.startsWith('overrides/') || name.startsWith('client-overrides/')))
}

function relativeOverride(name: string): string {
  return name.startsWith('client-overrides/') ? name.slice('client-overrides/'.length) : name.slice('overrides/'.length)
}

async function readIndex(path: string): Promise<{ zip: ZipReader; index: ModpackIndex }> {
  const zip = await ZipReader.open(path)
  const raw = await zip.read('modrinth.index.json')
  if (!raw) throw new Error('这个文件不是 Modrinth 整合包（缺少 modrinth.index.json）')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('modrinth.index.json 不是合法 JSON')
  }
  return { zip, index: parseModpackIndex(parsed) }
}

export function sanitizeVersionName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function defaultModpackName(path: string, index: { name: string | null; versionId: string | null }): string {
  const label = index.name ?? basename(path).replace(/\.mrpack$/i, '')
  return sanitizeVersionName(`${label}${index.versionId ? ` ${index.versionId}` : ''}`) || 'Modrinth 整合包'
}

export async function inspectModpack(path: string): Promise<ModpackSummary> {
  const { zip, index } = await readIndex(path)
  return {
    path,
    name: index.name,
    versionId: index.versionId,
    minecraft: index.minecraft,
    loader: index.loader,
    loaderVersion: index.loaderVersion,
    files: index.files.length,
    clientFiles: index.files.length,
    overrides: overrideEntries(zip).length
  }
}

async function installBase(options: ModpackImportOptions, index: ModpackIndex, name: string): Promise<void> {
  const shared = {
    folder: options.folder,
    name,
    isolated: options.isolated ?? true,
    source: options.source,
    concurrency: options.concurrency,
    fetchImpl: options.fetchImpl,
    mirrorOrigin: options.mirrorOrigin,
    stats: options.stats,
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: ((_progress, detail) => options.onProgress?.({ done: 2, total: STEP_TOTAL, unit: 'steps' }, detail ?? `安装 ${index.loader} 基础版本`)) as ProgressListener
  }
  if (index.loader === 'fabric') await installFabric({ ...shared, version: index.minecraft, loader: index.loaderVersion ?? undefined, companions: false })
  else if (index.loader === 'quilt') await installQuilt({ ...shared, version: index.minecraft, loader: index.loaderVersion ?? undefined, companions: false })
  else if (index.loader === 'forge') await installForge({ ...shared, minecraft: index.minecraft, loader: index.loaderVersion ?? undefined, ...(options.installerJavaPaths ? { installerJavaPaths: options.installerJavaPaths } : {}) })
  else if (index.loader === 'neoforge')
    await installNeoForge({ ...shared, minecraft: index.minecraft, loader: index.loaderVersion ?? undefined, ...(options.installerJavaPaths ? { installerJavaPaths: options.installerJavaPaths } : {}) })
  else await installVanilla({ ...shared, version: index.minecraft })
}

export async function importModpack(options: ModpackImportOptions): Promise<ModpackInstallResult> {
  const { zip, index } = await readIndex(options.path)
  const name = options.name?.trim() ? options.name.trim() : defaultModpackName(options.path, index)
  options.onProgress?.({ done: 1, total: STEP_TOTAL, unit: 'steps' }, `安装 ${index.minecraft} ${index.loader === 'vanilla' ? '' : index.loader} 基础版本`.trim())
  await installBase(options, index, name)
  const isolated = options.isolated ?? true
  const gameDir = isolated ? join(options.folder, 'versions', name) : options.folder
  const files: InstallFile[] = index.files.map((file) => ({ url: file.url, dest: join(gameDir, ...file.path.split('/')), sha1: file.sha1, size: file.size }))
  options.onProgress?.({ done: 3, total: STEP_TOTAL, unit: 'steps' }, '下载整合包文件')
  const pending = await pendingFiles(files, 'sha1', { concurrency: options.concurrency, signal: options.signal, onProgress: options.onProgress })
  let bytes = 0
  if (pending.length > 0) {
    const report = await downloadFiles(pending, {
      source: options.source,
      concurrency: options.concurrency,
      fetchImpl: options.fetchImpl,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: (progress, detail) => options.onProgress?.(progress, detail ?? '下载整合包文件')
    })
    bytes = report.bytes
  }
  options.onProgress?.({ done: 4, total: STEP_TOTAL, unit: 'steps' }, '解压整合包内的配置与文件')
  let overrides = 0
  const totalOverrides = overrideEntries(zip).length
  await zip.readAll(
    (entry) => entry.startsWith('overrides/') || entry.startsWith('client-overrides/'),
    async (entry, data) => {
      const relative = relativeOverride(entry)
      if (!relative || unsafeRelative(relative)) return
      const dest = join(gameDir, ...relative.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, data)
      overrides += 1
      options.onProgress?.({ done: overrides, total: totalOverrides, unit: 'files' }, relative)
    }
  )
  return {
    name,
    minecraft: index.minecraft,
    loader: index.loader,
    loaderVersion: index.loaderVersion,
    files: files.length,
    downloaded: pending.length,
    skipped: files.length - pending.length,
    overrides,
    bytes
  }
}
