import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModEntry } from '../../shared/mods-api.ts'
import { ModStore } from './store.ts'

export const DISABLED_SUFFIX = '.disabled'

export interface ModFileInfo {
  file: string
  path: string
  enabled: boolean
  size: number
  modifiedAt: number
  sha1: string
}

export interface HashRecord {
  size: number
  modifiedAt: number
  sha1: string
}

export type HashCache = Map<string, HashRecord>

export function isModFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.jar') || lower.endsWith(`.jar${DISABLED_SUFFIX}`)
}

export function displayName(file: string): string {
  return file.replace(/\.jar(\.disabled)?$/i, '')
}

export function modsDir(gameDir: string): string {
  return join(gameDir, 'mods')
}

export async function sha1Of(path: string): Promise<string> {
  const hash = createHash('sha1')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

export async function scanModFiles(gameDir: string, hashCache: HashCache = new Map()): Promise<ModFileInfo[]> {
  let names: string[]
  try {
    names = await readdir(modsDir(gameDir))
  } catch {
    return []
  }
  const files: ModFileInfo[] = []
  for (const name of names) {
    if (!isModFileName(name)) continue
    const path = join(modsDir(gameDir), name)
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const cached = hashCache.get(path)
    const sha1 = cached && cached.size === info.size && cached.modifiedAt === info.mtimeMs ? cached.sha1 : await sha1Of(path)
    hashCache.set(path, { size: info.size, modifiedAt: info.mtimeMs, sha1 })
    files.push({
      file: name,
      path,
      enabled: !name.toLowerCase().endsWith(DISABLED_SUFFIX),
      size: info.size,
      modifiedAt: info.mtimeMs,
      sha1
    })
  }
  return files.sort((a, b) => a.file.localeCompare(b.file, 'zh-CN'))
}

export interface ReadModsOptions {
  gameDir: string
  store: ModStore
  hashCache?: HashCache
}

export async function readModEntries(options: ReadModsOptions): Promise<ModEntry[]> {
  const files = await scanModFiles(options.gameDir, options.hashCache)
  const entries: ModEntry[] = []
  for (const file of files) {
    const meta = await options.store.metaFor(file.sha1, file.path)
    const record = options.store.modrinthOf(file.sha1)
    entries.push({
      file: file.file,
      enabled: file.enabled,
      size: file.size,
      sha1: file.sha1,
      modifiedAt: file.modifiedAt,
      kind: meta.kind,
      modId: meta.modId,
      name: meta.name || displayName(file.file),
      version: meta.version,
      description: meta.description,
      icon: await options.store.iconDataUrl(meta.iconKey),
      remoteIconUrl: record?.iconUrl ?? null,
      projectId: record?.projectId ?? null,
      mcRange: meta.mcRange,
      dependencies: meta.dependencies,
      provides: meta.provides,
      nestedIds: meta.nestedIds,
      issues: []
    })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}
