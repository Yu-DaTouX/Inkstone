import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { open, readAllEntries, readEntry } from '@xmcl/unzip'
import { MAX_ICON_BYTES, isPng, jarIcon } from './jar-icon.ts'
import type { CopyInstanceResult, InstanceIconKind, InstanceIconOption, InstanceTrashRecord, ResourceKind, ResourcePackEntry, SaveEntry, ScreenshotEntry, ServerEntry, ShaderPackEntry, VersionResources } from '../shared/version-api.ts'

const TRASH_DIR = '.trash'
const OPTIONS_FILE = 'options.txt'
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
const MAX_SCREENSHOTS = 120
const MAX_CUSTOM_ICON_BYTES = 1024 * 1024
const MAX_PACK_ICON_BYTES = 128 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function validInstanceName(name: string): boolean {
  const text = name.trim()
  return !!text && text.length <= 120 && !/[\\/:*?"<>|]/.test(text) && text !== '.' && text !== '..'
}

export function validResourceName(name: string): boolean {
  return !!name && basename(name) === name && !name.startsWith('.') && !/[\\/]/.test(name)
}

async function versionIds(folder: string): Promise<string[]> {
  try {
    return (await readdir(join(folder, 'versions'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

export function uniqueInstanceName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((item) => item.toLowerCase()))
  const base = name.trim()
  if (!lower.has(base.toLowerCase())) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
  return `${base} ${Date.now()}`
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

export async function directorySize(dir: string, depth = 0): Promise<number> {
  if (depth > 6) return 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySize(path, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    total += await stat(path).then((info) => info.size, () => 0)
  }
  return total
}

interface RawVersionJson {
  id?: unknown
  [key: string]: unknown
}

async function renameVersionFiles(dir: string, from: string, to: string): Promise<{ json: string; jarRenamed: boolean }> {
  const jsonPath = join(dir, `${from}.json`)
  const text = await readFile(jsonPath, 'utf8')
  const parsed = JSON.parse(text) as RawVersionJson
  parsed.id = to
  const nextJson = join(dir, `${to}.json`)
  await rename(jsonPath, nextJson)
  await writeFile(nextJson, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  const jarPath = join(dir, `${from}.jar`)
  const jarRenamed = await pathExists(jarPath)
  if (jarRenamed) await rename(jarPath, join(dir, `${to}.jar`))
  return { json: nextJson, jarRenamed }
}

export interface RenameResult {
  id: string
  json: string
  jarRenamed: boolean
}

export async function renameInstance(folder: string, versionId: string, nextName: string): Promise<RenameResult> {
  const name = nextName.trim()
  if (!validInstanceName(name)) throw new Error('版本名不能为空，也不能包含 \\ / : * ? " < > | 这些字符')
  if (name.toLowerCase() === versionId.toLowerCase()) throw new Error('新名字和原来的名字一样')
  const taken = await versionIds(folder)
  if (taken.some((id) => id.toLowerCase() === name.toLowerCase())) throw new Error(`已经有叫 ${name} 的版本`)
  const root = join(folder, 'versions')
  const from = join(root, versionId)
  const to = join(root, name)
  const info = await stat(from).catch(() => null)
  if (!info?.isDirectory()) throw new Error('找不到这个版本的文件夹')
  const jsonInfo = await stat(join(from, `${versionId}.json`)).catch(() => null)
  if (!jsonInfo?.isFile()) throw new Error(`缺少 ${versionId}.json，先在修复页补全再重命名`)
  await rename(from, to)
  try {
    const result = await renameVersionFiles(to, versionId, name)
    return { id: name, json: result.json, jarRenamed: result.jarRenamed }
  } catch (error) {
    await rename(to, from).catch(() => undefined)
    throw error
  }
}

export async function copyInstance(folder: string, versionId: string, requestedName?: string): Promise<CopyInstanceResult> {
  const taken = await versionIds(folder)
  if (!taken.some((id) => id.toLowerCase() === versionId.toLowerCase())) throw new Error('找不到这个版本')
  const base = (requestedName ?? '').trim() || `${versionId}-副本`
  if (!validInstanceName(base)) throw new Error('版本名不能为空，也不能包含 \\ / : * ? " < > | 这些字符')
  const name = uniqueInstanceName(base, taken)
  const from = join(folder, 'versions', versionId)
  const to = join(folder, 'versions', name)
  const jsonInfo = await stat(join(from, `${versionId}.json`)).catch(() => null)
  if (!jsonInfo?.isFile()) throw new Error(`缺少 ${versionId}.json，先在修复页补全再复制`)
  await cp(from, to, { recursive: true, errorOnExist: true, force: false })
  try {
    const size = await directorySize(to)
    await renameVersionFiles(to, versionId, name)
    return { id: name, size }
  } catch (error) {
    await rm(to, { recursive: true, force: true })
    throw error
  }
}

function trashRoot(root: string, kind: string): string {
  return join(root, TRASH_DIR, kind)
}

function safeSegment(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'item'
}

interface TrashMeta {
  id: string
  kind: string
  name: string
  file: string
  at: number
  size: number
}

async function moveIntoTrash(root: string, kind: string, source: string, name: string, file: string, extra: Record<string, unknown> = {}): Promise<TrashMeta> {
  const size = await directorySize(source).then(
    (value) => value,
    () => 0
  )
  const at = Date.now()
  const id = `${at}-${safeSegment(name)}`
  const dir = join(trashRoot(root, kind), id)
  await mkdir(dir, { recursive: true })
  await moveEntry(source, join(dir, file))
  const meta: TrashMeta = { id, kind, name, file, at, size: size || (await stat(join(dir, file)).then((info) => info.size, () => 0)) }
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify({ ...meta, ...extra }, null, 2)}\n`, 'utf8')
  return meta
}

export async function trashInstance(folder: string, versionId: string): Promise<InstanceTrashRecord> {
  const from = join(folder, 'versions', versionId)
  const info = await stat(from).catch(() => null)
  if (!info?.isDirectory()) throw new Error('找不到这个版本的文件夹')
  const meta = await moveIntoTrash(folder, 'instances', from, versionId, 'instance', { versionId })
  return { id: meta.id, versionId, at: meta.at, size: meta.size }
}

export async function listTrashedInstances(folder: string): Promise<InstanceTrashRecord[]> {
  let names: string[]
  try {
    names = (await readdir(trashRoot(folder, 'instances'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  const records: InstanceTrashRecord[] = []
  for (const name of names) {
    const meta = await readFile(join(trashRoot(folder, 'instances'), name, 'meta.json'), 'utf8').catch(() => null)
    if (!meta) continue
    try {
      const parsed = JSON.parse(meta) as TrashMeta & { versionId?: string }
      const versionId = typeof parsed.versionId === 'string' && parsed.versionId ? parsed.versionId : parsed.name
      if (!versionId) continue
      records.push({ id: name, versionId, at: parsed.at ?? 0, size: parsed.size ?? 0 })
    } catch {
      continue
    }
  }
  return records.sort((a, b) => b.at - a.at)
}

export async function restoreTrashedInstance(folder: string, id: string): Promise<string> {
  if (!/^[0-9]+-[^\\/:*?"<>|]+$/.test(id)) throw new Error('回收站记录不合法')
  const dir = join(trashRoot(folder, 'instances'), id)
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as TrashMeta & { versionId?: string }
  const versionId = meta.versionId ?? meta.name
  if (!validInstanceName(versionId)) throw new Error('回收站记录里的版本名不合法')
  const target = join(folder, 'versions', versionId)
  if (await pathExists(target)) throw new Error(`${versionId} 已经回到版本列表里`)
  await mkdir(join(folder, 'versions'), { recursive: true })
  await moveEntry(join(dir, 'instance'), target)
  await rm(dir, { recursive: true, force: true })
  return versionId
}

function dataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

function pngFromDataUrl(value: string): Buffer | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value.trim())
  if (!match) return null
  const buffer = Buffer.from(match[1]!, 'base64')
  return buffer.subarray(0, 8).equals(PNG_SIGNATURE) ? buffer : null
}

function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

async function readSmallPng(path: string, limit = MAX_ICON_BYTES): Promise<Buffer | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size > limit) return null
  const buffer = await readFile(path).catch(() => null)
  return buffer && buffer.subarray(0, 8).equals(PNG_SIGNATURE) ? buffer : null
}

async function readZipEntries(path: string, wanted: string[], limit = MAX_ICON_BYTES): Promise<Map<string, Buffer>> {
  const zip = await open(path, { lazyEntries: true, autoClose: false })
  const found = new Map<string, Buffer>()
  try {
    const entries = await readAllEntries(zip)
    for (const name of wanted) {
      const entry = entries.find((item) => item.fileName === name)
      if (!entry || entry.uncompressedSize > limit) continue
      found.set(name, await readEntry(zip, entry))
    }
  } finally {
    zip.close()
  }
  return found
}

function packMeta(buffer: Buffer | undefined): { format: number | null; description: string | null } {
  if (!buffer) return { format: null, description: null }
  try {
    const parsed = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')) as { pack?: { pack_format?: unknown; description?: unknown } }
    const format = Number(parsed.pack?.pack_format)
    const description = typeof parsed.pack?.description === 'string' ? parsed.pack.description : null
    return { format: Number.isFinite(format) ? Math.round(format) : null, description }
  } catch {
    return { format: null, description: null }
  }
}

async function readPack(path: string, file: string, isDirectory: boolean): Promise<Omit<ResourcePackEntry, 'enabled'> | null> {
  const lower = file.toLowerCase()
  let meta: { format: number | null; description: string | null } = { format: null, description: null }
  let icon: Buffer | null = null
  let size = 0
  if (isDirectory) {
    const info = await stat(path).catch(() => null)
    if (!info) return null
    size = await directorySize(path)
    meta = packMeta(await readFile(join(path, 'pack.mcmeta')).catch(() => undefined))
    icon = await readSmallPng(join(path, 'pack.png'), MAX_PACK_ICON_BYTES)
  } else {
    if (!lower.endsWith('.zip')) return null
    const info = await stat(path).catch(() => null)
    if (!info) return null
    size = info.size
    const entries = await readZipEntries(path, ['pack.mcmeta', 'pack.png']).catch(() => new Map<string, Buffer>())
    meta = packMeta(entries.get('pack.mcmeta'))
    const packPng = entries.get('pack.png')
    icon = packPng && packPng.length <= MAX_PACK_ICON_BYTES && packPng.subarray(0, 8).equals(PNG_SIGNATURE) ? packPng : null
  }
  return { file, name: file.replace(/\.zip$/i, ''), size, format: meta.format, description: meta.description, icon: icon ? dataUrl(icon) : null }
}

export function parseResourcePackList(value: string | null): string[] {
  if (!value) return ['vanilla']
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return ['vanilla']
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return ['vanilla']
  }
}

export function formatResourcePackList(values: string[]): string {
  return `resourcePacks:${JSON.stringify(values)}`
}

async function readLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  if (!text) return []
  return text.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ''))
}

async function writeLines(path: string, lines: string[]): Promise<void> {
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
}

async function enabledPacks(gameDir: string): Promise<Set<string>> {
  const lines = await readLines(join(gameDir, OPTIONS_FILE))
  const line = lines.find((item) => item.startsWith('resourcePacks:'))
  return new Set(parseResourcePackList(line ? line.slice('resourcePacks:'.length) : null))
}

export async function listResourcePacks(gameDir: string): Promise<ResourcePackEntry[]> {
  const dir = join(gameDir, 'resourcepacks')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const enabled = await enabledPacks(gameDir)
  const packs: ResourcePackEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const pack = await readPack(join(dir, entry.name), entry.name, entry.isDirectory())
    if (!pack) continue
    packs.push({ ...pack, enabled: enabled.has(`file/${entry.name}`) })
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export async function toggleResourcePack(gameDir: string, file: string, enabled: boolean): Promise<ResourcePackEntry[]> {
  if (!validResourceName(file)) throw new Error('资源包文件名不合法')
  const info = await stat(join(gameDir, 'resourcepacks', file)).catch(() => null)
  if (!info) throw new Error('找不到这个资源包')
  const path = join(gameDir, OPTIONS_FILE)
  const lines = await readLines(path)
  const index = lines.findIndex((line) => line.startsWith('resourcePacks:'))
  const current = parseResourcePackList(index >= 0 ? lines[index]!.slice('resourcePacks:'.length) : null)
  const entry = `file/${file}`
  const rest = current.filter((item) => item !== entry)
  const base = rest.includes('vanilla') ? rest : ['vanilla', ...rest]
  const line = formatResourcePackList(enabled ? [...base, entry] : base)
  await writeLines(path, index >= 0 ? lines.map((item, at) => (at === index ? line : item)) : [...lines, line])
  return listResourcePacks(gameDir)
}

export async function trashResource(gameDir: string, kind: ResourceKind, file: string): Promise<void> {
  if (!validResourceName(file)) throw new Error('文件名不合法')
  const from = join(gameDir, kind, file)
  const info = await stat(from).catch(() => null)
  if (!info) throw new Error('找不到这个文件')
  await moveIntoTrash(gameDir, kind, from, file, file)
  const lines = await readLines(join(gameDir, OPTIONS_FILE))
  const index = lines.findIndex((line) => line.startsWith('resourcePacks:'))
  if (index < 0) return
  const current = parseResourcePackList(lines[index]!.slice('resourcePacks:'.length))
  const rest = current.filter((item) => item !== `file/${file}`)
  if (rest.length !== current.length) await writeLines(join(gameDir, OPTIONS_FILE), lines.map((item, at) => (at === index ? formatResourcePackList(rest) : item)))
}

export async function listShaderPacks(gameDir: string): Promise<ShaderPackEntry[]> {
  const dir = join(gameDir, 'shaderpacks')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const packs: ShaderPackEntry[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      packs.push({ file: entry.name, name: entry.name, size: await directorySize(path) })
      continue
    }
    if (!/\.(zip|jar)$/i.test(entry.name)) continue
    const info = await stat(path).catch(() => null)
    packs.push({ file: entry.name, name: entry.name.replace(/\.(zip|jar)$/i, ''), size: info?.size ?? 0 })
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

interface NbtReader {
  pos: number
  buffer: Buffer
}

function readNbtTag(reader: NbtReader, type: number): unknown {
  switch (type) {
    case 1:
      return reader.buffer.readInt8(reader.pos++)
    case 2: {
      const value = reader.buffer.readInt16BE(reader.pos)
      reader.pos += 2
      return value
    }
    case 3: {
      const value = reader.buffer.readInt32BE(reader.pos)
      reader.pos += 4
      return value
    }
    case 4: {
      const value = reader.buffer.readBigInt64BE(reader.pos)
      reader.pos += 8
      return Number(value)
    }
    case 5: {
      const value = reader.buffer.readFloatBE(reader.pos)
      reader.pos += 4
      return value
    }
    case 6: {
      const value = reader.buffer.readDoubleBE(reader.pos)
      reader.pos += 8
      return value
    }
    case 7: {
      const length = reader.buffer.readInt32BE(reader.pos)
      reader.pos += 4
      const value = reader.buffer.subarray(reader.pos, reader.pos + length)
      reader.pos += length
      return Buffer.from(value)
    }
    case 8: {
      const length = reader.buffer.readUInt16BE(reader.pos)
      reader.pos += 2
      const value = reader.buffer.toString('utf8', reader.pos, reader.pos + length)
      reader.pos += length
      return value
    }
    case 9: {
      const itemType = reader.buffer.readUInt8(reader.pos++)
      const length = reader.buffer.readInt32BE(reader.pos)
      reader.pos += 4
      const list: unknown[] = []
      for (let index = 0; index < length; index += 1) list.push(readNbtTag(reader, itemType))
      return list
    }
    case 10: {
      const compound: Record<string, unknown> = {}
      for (;;) {
        const itemType = reader.buffer.readUInt8(reader.pos++)
        if (itemType === 0) break
        const nameLength = reader.buffer.readUInt16BE(reader.pos)
        reader.pos += 2
        const name = reader.buffer.toString('utf8', reader.pos, reader.pos + nameLength)
        reader.pos += nameLength
        compound[name] = readNbtTag(reader, itemType)
      }
      return compound
    }
    case 11: {
      const length = reader.buffer.readInt32BE(reader.pos)
      reader.pos += 4
      reader.pos += length * 4
      return []
    }
    case 12: {
      const length = reader.buffer.readInt32BE(reader.pos)
      reader.pos += 4
      reader.pos += length * 8
      return []
    }
    default:
      throw new Error(`不认识的 NBT 类型 ${type}`)
  }
}

export function parseNbt(buffer: Buffer): Record<string, unknown> {
  const data = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer
  const reader: NbtReader = { pos: 0, buffer: data }
  const type = data.readUInt8(reader.pos++)
  if (type !== 10) throw new Error('不是 NBT 复合标签')
  const nameLength = data.readUInt16BE(reader.pos)
  reader.pos += 2 + nameLength
  return readNbtTag(reader, 10) as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asTime(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export async function readServers(gameDir: string): Promise<ServerEntry[]> {
  const buffer = await readFile(join(gameDir, 'servers.dat')).catch(() => null)
  if (!buffer) return []
  try {
    const root = parseNbt(buffer)
    const list = Array.isArray(root.servers) ? root.servers : []
    return list
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => !!item)
      .map((item) => ({
        name: asText(item.name) ?? asText(item.ip) ?? '服务器',
        ip: asText(item.ip) ?? '',
        icon: typeof item.icon === 'string' && item.icon.startsWith('data:image/png;base64,') ? item.icon : null
      }))
      .filter((item) => !!item.ip)
  } catch {
    return []
  }
}

async function readLevelData(path: string): Promise<Record<string, unknown> | null> {
  const buffer = await readFile(path).catch(() => null)
  if (!buffer) return null
  try {
    const root = parseNbt(buffer)
    return asRecord(root.Data) ?? null
  } catch {
    return null
  }
}

export async function listSaves(gameDir: string): Promise<SaveEntry[]> {
  const dir = join(gameDir, 'saves')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const saves: SaveEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    const level = await readLevelData(join(path, 'level.dat'))
    const info = await stat(join(path, 'level.dat')).catch(() => null)
    const icon = await readSmallPng(join(path, 'icon.png'))
    const version = asRecord(level?.Version)
    saves.push({
      folder: entry.name,
      name: asText(level?.LevelName) ?? entry.name,
      size: await directorySize(path),
      lastPlayed: asTime(level?.LastPlayed) ?? info?.mtimeMs ?? null,
      icon: icon ? dataUrl(icon) : null,
      gameVersion: asText(version?.Name)
    })
  }
  return saves.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
}

export async function listScreenshots(gameDir: string, limit = MAX_SCREENSHOTS): Promise<ScreenshotEntry[]> {
  const dir = join(gameDir, 'screenshots')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png') && !entry.name.startsWith('.'))
      .map(async (entry) => ({ name: entry.name, info: await stat(join(dir, entry.name)).catch(() => null) }))
  )
  const usable = files
    .filter((item): item is { name: string; info: NonNullable<typeof item.info> } => !!item.info && item.info.size <= MAX_SCREENSHOT_BYTES)
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
    .slice(0, limit)
  const shots: ScreenshotEntry[] = []
  for (const item of usable) {
    const buffer = await readFile(join(dir, item.name)).catch(() => null)
    if (!buffer) continue
    const size = pngSize(buffer)
    shots.push({ file: item.name, at: item.info.mtimeMs, size: buffer.length, width: size?.width ?? null, height: size?.height ?? null, dataUrl: dataUrl(buffer) })
  }
  return shots
}

export async function resourceList(gameDir: string): Promise<VersionResources> {
  return {
    resourcepacks: await listResourcePacks(gameDir),
    shaderpacks: await listShaderPacks(gameDir),
    saves: await listSaves(gameDir),
    servers: await readServers(gameDir)
  }
}

export type IconOptionKind = InstanceIconKind

export async function instanceIconOptions(gameDir: string): Promise<InstanceIconOption[]> {
  const options: InstanceIconOption[] = []
  const servers = await readServers(gameDir)
  for (const server of servers) {
    if (server.icon) options.push({ kind: 'server', ref: server.ip, label: `服务器 ${server.name}`, preview: server.icon })
  }
  const saves = await listSaves(gameDir)
  for (const save of saves) {
    if (save.icon) options.push({ kind: 'save', ref: save.folder, label: `存档 ${save.name}`, preview: save.icon })
  }
  const entries = await readdir(join(gameDir, 'mods'), { withFileTypes: true }).catch(() => [])
  const jars = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).slice(0, 24)
  for (const jar of jars) {
    const png = await jarIcon(join(gameDir, 'mods', jar.name))
    if (isPng(png)) options.push({ kind: 'mod', ref: jar.name, label: `Mod ${jar.name}`, preview: dataUrl(png) })
  }
  return options
}

export async function readIconOption(gameDir: string, kind: IconOptionKind, ref: string): Promise<Buffer | null> {
  if (!validResourceName(ref)) return null
  if (kind === 'mod') return jarIcon(join(gameDir, 'mods', ref))
  if (kind === 'save') return readSmallPng(join(gameDir, 'saves', ref, 'icon.png'))
  if (kind === 'server') {
    const servers = await readServers(gameDir)
    const hit = servers.find((item) => item.ip === ref)
    return hit?.icon ? pngFromDataUrl(hit.icon) : null
  }
  return null
}

export class InstanceIconStore {
  private readonly dir: string
  private readonly file: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'icons')
    this.file = join(this.dir, 'custom.json')
  }

  private key(folder: string, versionId: string): string {
    return `${folder.toLowerCase()}|${versionId}`
  }

  private async load(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>
      const map: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string' && value) map[key] = value
      return map
    } catch {
      return {}
    }
  }

  private async save(map: Record<string, string>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
  }

  async customPath(folder: string, versionId: string): Promise<string | null> {
    const map = await this.load()
    const value = map[this.key(folder, versionId)]
    if (!value) return null
    const path = join(this.dir, basename(value))
    return (await pathExists(path)) ? path : null
  }

  async set(folder: string, versionId: string, png: Buffer): Promise<string> {
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('图标必须是 PNG 图片')
    if (png.length > MAX_CUSTOM_ICON_BYTES) throw new Error('图标文件太大，最多 1 MB')
    const sha1 = createHash('sha1').update(png).digest('hex')
    await mkdir(this.dir, { recursive: true })
    const rel = `${sha1}.png`
    await writeFile(join(this.dir, rel), png)
    const map = await this.load()
    map[this.key(folder, versionId)] = rel
    await this.save(map)
    return join(this.dir, rel)
  }

  async clear(folder: string, versionId: string): Promise<void> {
    const map = await this.load()
    if (!(this.key(folder, versionId) in map)) return
    delete map[this.key(folder, versionId)]
    await this.save(map)
  }
}

export function parseMcVersion(version: string | null | undefined): [number, number, number] | null {
  if (!version) return null
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
}

export function normalizeServerAddress(text: string | null | undefined): string | null {
  const value = (text ?? '')
    .trim()
    .replace(/^minecraft:\/\//i, '')
    .replace(/\/+$/, '')
  if (!value || /[\s;]/.test(value)) return null
  return value
}

function splitHostPort(value: string): { host: string; port: string | null } {
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracket) return { host: bracket[1]!, port: bracket[2] ?? null }
  const index = value.lastIndexOf(':')
  if (index <= 0) return { host: value, port: null }
  const port = value.slice(index + 1)
  return /^\d{1,5}$/.test(port) ? { host: value.slice(0, index), port } : { host: value, port: null }
}

export function serverArgs(minecraftVersion: string | null | undefined, address: string | null | undefined): string[] {
  const value = normalizeServerAddress(address)
  if (!value) return []
  const parsed = parseMcVersion(minecraftVersion)
  const quickPlay = !!parsed && (parsed[0] > 1 || (parsed[0] === 1 && parsed[1] >= 20))
  if (quickPlay) return ['--quickPlayMultiplayer', value]
  const { host, port } = splitHostPort(value)
  return port ? ['--server', host, '--port', port] : ['--server', host]
}
