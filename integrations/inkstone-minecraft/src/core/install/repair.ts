import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { DownloadOptions } from '../download/download.ts'
import { assetPlan, currentPlatform, dedupeFiles, libraryFiles, type RawVersion } from './meta.ts'
import { downloadPending, pendingFiles, toDownloadOptions } from './plan.ts'
import type { CheckReport, InstallFile, InstallOptions, RepairResult } from './types.ts'

interface ChainEntry {
  id: string
  version: RawVersion
}

async function readLocalVersion(folder: string, id: string): Promise<RawVersion> {
  const path = join(folder, 'versions', id, `${id}.json`)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(`没有找到实例「${id}」的版本 JSON`)
  }
  try {
    return JSON.parse(text) as RawVersion
  } catch {
    throw new Error(`实例「${id}」的版本 JSON 无法解析`)
  }
}

async function readChain(folder: string, name: string): Promise<ChainEntry[]> {
  const chain: ChainEntry[] = []
  const seen = new Set<string>()
  let id: string | undefined = name
  while (id && !seen.has(id)) {
    seen.add(id)
    const version = await readLocalVersion(folder, id)
    chain.unshift({ id, version })
    id = typeof version.inheritsFrom === 'string' && version.inheritsFrom ? version.inheritsFrom : undefined
  }
  return chain
}

function effectiveVersion(chain: ChainEntry[]): RawVersion {
  const version: RawVersion = {}
  const libraries: unknown[] = []
  for (const entry of chain) {
    if (Array.isArray(entry.version.libraries)) libraries.push(...entry.version.libraries)
    if (entry.version.assetIndex) version.assetIndex = entry.version.assetIndex
    if (entry.version.assets) version.assets = entry.version.assets
    if (entry.version.downloads?.client) version.downloads = { client: entry.version.downloads.client }
    if (entry.version.javaVersion) version.javaVersion = entry.version.javaVersion
    if (entry.version.mainClass) version.mainClass = entry.version.mainClass
  }
  version.libraries = libraries
  return version
}

function relativeName(folder: string, dest: string): string {
  return relative(folder, dest).split(sep).join('/')
}

async function expectedFiles(folder: string, name: string, options: DownloadOptions & { preferLocal?: boolean }): Promise<InstallFile[]> {
  const chain = await readChain(folder, name)
  const version = effectiveVersion(chain)
  const files = libraryFiles(folder, version.libraries, currentPlatform())
  const owner = chain.find((entry) => typeof entry.version.downloads?.client?.url === 'string') ?? chain[0]
  const client = owner.version.downloads?.client
  if (client && typeof client.url === 'string') {
    const ownJar = join(folder, 'versions', name, `${name}.jar`)
    files.unshift({
      url: client.url,
      dest: existsSync(ownJar) ? ownJar : join(folder, 'versions', owner.id, `${owner.id}.jar`),
      sha1: typeof client.sha1 === 'string' ? client.sha1 : null,
      size: typeof client.size === 'number' ? client.size : null
    })
  }
  const assets = await assetPlan(folder, version, options)
  if (assets) files.push(assets.index, ...assets.objects)
  return dedupeFiles(files)
}

export async function quickCheck(options: { folder: string; name: string; signal?: AbortSignal }): Promise<CheckReport> {
  const files = await expectedFiles(options.folder, options.name, { preferLocal: true, signal: options.signal })
  const pending = await pendingFiles(files, 'size', { signal: options.signal })
  return {
    name: options.name,
    total: files.length,
    missing: pending.length,
    files: pending.map((file) => relativeName(options.folder, file.dest))
  }
}

export async function repairInstance(options: InstallOptions & { name: string }): Promise<RepairResult> {
  const download = toDownloadOptions(options)
  const files = await expectedFiles(options.folder, options.name, download)
  const pending = await pendingFiles(files, 'sha1', { concurrency: options.concurrency, signal: options.signal, onProgress: options.onProgress })
  const report = await downloadPending(pending, download)
  return {
    name: options.name,
    total: files.length,
    missing: pending.length,
    files: pending.map((file) => relativeName(options.folder, file.dest)),
    repaired: pending.length,
    bytes: report.bytes
  }
}
