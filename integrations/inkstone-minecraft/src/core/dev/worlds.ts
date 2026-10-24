import { existsSync, type Dirent } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { readNbt, type NbtCompound, type NbtValue } from './nbt.ts'
import { readJson, writeJson } from './session.ts'

export const SNAPSHOT_DIR = join('.inkstone', 'dev', 'snapshots')
export const IMPORT_MARKER = '.inkstone-import.json'
export const DEFAULT_RUN_DIR = 'run'

export interface SaveVersion {
  dataVersion: number | null
  versionName: string | null
}

export interface LevelInfo extends SaveVersion {
  levelName: string | null
  lastPlayed: number | null
  gameType: number | null
  difficulty: number | null
  hardcore: boolean
}

export interface ImportMark {
  version: 1
  source: string
  importedAt: number
  versionName: string | null
  dataVersion: number | null
}

export interface WorldEntry {
  name: string
  dir: string
  level: LevelInfo | null
  error: string | null
  files: number
  bytes: number
  modifiedAt: number
  imported: ImportMark | null
  active: boolean
}

export interface SnapshotEntry {
  id: string
  dir: string
  world: string
  label: string | null
  at: number
  files: number
  bytes: number
  level: LevelInfo | null
}

export type VersionOrder = 'same' | 'newer' | 'older' | 'unknown'

export interface VersionCompare {
  order: VersionOrder
  basis: 'data-version' | 'name' | 'none'
  detail: string
  save: SaveVersion
  target: SaveVersion
}

export const MINECRAFT_DATA_VERSIONS: Record<string, number> = {
  '1.16.5': 2586,
  '1.17.1': 2730,
  '1.18.2': 2975,
  '1.19.2': 3120,
  '1.19.4': 3337,
  '1.20': 3463,
  '1.20.1': 3465,
  '1.20.2': 3578,
  '1.20.4': 3700,
  '1.20.6': 3839,
  '1.21': 3953,
  '1.21.1': 3955,
  '1.21.2': 4080,
  '1.21.3': 4082,
  '1.21.4': 4189,
  '1.21.5': 4325,
  '26.1.2': 4790
}

export function runDirOf(projectDir: string, workingDir?: string | null): string {
  const raw = workingDir?.trim()
  return raw ? resolve(raw) : join(resolve(projectDir), DEFAULT_RUN_DIR)
}

export function savesDirOf(runDir: string): string {
  return join(runDir, 'saves')
}

export function snapshotsRoot(projectDir: string): string {
  return join(projectDir, SNAPSHOT_DIR)
}

export function assertWorldName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/:*?"<>|]/.test(trimmed)) throw new Error(`存档名不合法：${name}`)
  return trimmed
}

export function assertSnapshotId(id: string): string {
  const trimmed = id.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/:*?"<>|]/.test(trimmed)) throw new Error(`快照 id 不合法：${id}`)
  return trimmed
}

export function worldPath(runDir: string, world: string): string {
  return join(savesDirOf(runDir), assertWorldName(world))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function describeVersion(info: SaveVersion): string {
  const version = info.versionName ?? '未知版本'
  return info.dataVersion === null ? version : `${version}（DataVersion ${info.dataVersion}）`
}

function pick(source: NbtCompound, key: string): NbtValue | undefined {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined
}

function numberField(source: NbtCompound, key: string): number | null {
  const found = pick(source, key)
  return typeof found === 'number' && Number.isFinite(found) ? found : null
}

function stringField(source: NbtCompound, key: string): string | null {
  const found = pick(source, key)
  return typeof found === 'string' && found ? found : null
}

function compoundField(source: NbtCompound, key: string): NbtCompound | null {
  const found = pick(source, key)
  return found && typeof found === 'object' && !Array.isArray(found) ? (found as NbtCompound) : null
}

export function levelFromNbt(root: NbtCompound): LevelInfo {
  const data = compoundField(root, 'Data') ?? root
  const version = compoundField(data, 'Version')
  return {
    dataVersion: numberField(data, 'DataVersion'),
    versionName: version ? stringField(version, 'Name') : null,
    levelName: stringField(data, 'LevelName'),
    lastPlayed: numberField(data, 'LastPlayed'),
    gameType: numberField(data, 'GameType'),
    difficulty: numberField(data, 'Difficulty'),
    hardcore: numberField(data, 'hardcore') === 1
  }
}

export async function readLevel(worldDir: string): Promise<LevelInfo> {
  const file = join(worldDir, 'level.dat')
  if (!existsSync(file)) throw new Error(`不是 Minecraft 存档（缺少 level.dat）：${worldDir}`)
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (error) {
    throw new Error(`读不了 ${file}：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return levelFromNbt(readNbt(bytes))
  } catch (error) {
    throw new Error(`level.dat 解析失败：${file}：${error instanceof Error ? error.message : String(error)}`)
  }
}

export function dataVersionFor(version: string | null | undefined): number | null {
  if (!version) return null
  return MINECRAFT_DATA_VERSIONS[version.trim().replace(/^v/i, '')] ?? null
}

function versionSegments(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map(Number)
    .filter((part) => Number.isFinite(part))
}

export function compareVersionNames(left: string, right: string): number | null {
  const a = versionSegments(left)
  const b = versionSegments(right)
  if (!a.length || !b.length) return null
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

export function compareSaveVersion(save: SaveVersion, target: SaveVersion): VersionCompare {
  if (save.dataVersion !== null && target.dataVersion !== null) {
    const order: VersionOrder = save.dataVersion === target.dataVersion ? 'same' : save.dataVersion > target.dataVersion ? 'newer' : 'older'
    return { order, basis: 'data-version', detail: `存档 ${describeVersion(save)}，项目 ${describeVersion(target)}`, save, target }
  }
  if (save.versionName && target.versionName) {
    const diff = compareVersionNames(save.versionName, target.versionName)
    if (diff !== null) {
      const order: VersionOrder = diff === 0 ? 'same' : diff > 0 ? 'newer' : 'older'
      return { order, basis: 'name', detail: `存档 ${describeVersion(save)}，项目 ${describeVersion(target)}（按版本号比较）`, save, target }
    }
  }
  return { order: 'unknown', basis: 'none', detail: `存档 ${describeVersion(save)}，项目 ${describeVersion(target)}（无法判断先后）`, save, target }
}

interface Measures {
  files: number
  bytes: number
  modifiedAt: number
}

async function measure(dir: string): Promise<Measures> {
  let files = 0
  let bytes = 0
  let modifiedAt = 0
  const walk = async (current: string): Promise<void> => {
    let entries: Dirent[] = []
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      try {
        const info = await stat(full)
        files += 1
        bytes += info.size
        modifiedAt = Math.max(modifiedAt, info.mtimeMs)
      } catch {
      }
    }
  }
  await walk(dir)
  return { files, bytes, modifiedAt }
}

function inside(parent: string, child: string): boolean {
  const related = relative(resolve(parent), resolve(child))
  return related === '' || (!related.startsWith('..') && !isAbsolute(related))
}

function withoutSessionLock(path: string): boolean {
  return basename(path).toLowerCase() !== 'session.lock'
}

export async function listWorlds(runDir: string, active: string | null = null): Promise<WorldEntry[]> {
  const root = savesDirOf(runDir)
  let names: string[] = []
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  const entries: WorldEntry[] = []
  for (const name of names) {
    const dir = join(root, name)
    let level: LevelInfo | null = null
    let error: string | null = null
    try {
      level = await readLevel(dir)
    } catch (failure) {
      error = (failure instanceof Error ? failure.message : String(failure)).replace(`：${dir}`, '').replace(dir, name)
    }
    const sizes = await measure(dir)
    entries.push({
      name,
      dir,
      level,
      error,
      files: sizes.files,
      bytes: sizes.bytes,
      modifiedAt: sizes.modifiedAt,
      imported: await readJson<ImportMark>(join(dir, IMPORT_MARKER)),
      active: active === name
    })
  }
  return entries.sort((left, right) => Number(right.active) - Number(left.active) || right.modifiedAt - left.modifiedAt)
}

export interface ImportRequest {
  runDir: string
  source: string
  name?: string | null
  projectVersion: string | null
  projectDataVersion?: number | null
}

export interface ImportResult {
  world: string
  dir: string
  source: string
  level: LevelInfo
  compare: VersionCompare
  warnings: string[]
  files: number
  bytes: number
  renamedFrom: string | null
}

function uniqueWorldName(savesDir: string, wanted: string): string {
  if (!existsSync(join(savesDir, wanted))) return wanted
  for (let index = 2; index < 1000; index++) {
    const candidate = `${wanted}-${index}`
    if (!existsSync(join(savesDir, candidate))) return candidate
  }
  throw new Error(`存档名 ${wanted} 的重名太多，请用 name 参数指定一个新名字`)
}

export async function importWorld(request: ImportRequest): Promise<ImportResult> {
  const source = resolve(request.source)
  if (!existsSync(source)) throw new Error(`源存档不存在：${source}`)
  const sourceStat = await stat(source)
  if (!sourceStat.isDirectory()) throw new Error(`源存档必须是世界文件夹，不是文件：${source}`)
  const savesDir = savesDirOf(request.runDir)
  if (inside(savesDir, source)) throw new Error(`源存档已经在开发存档目录里，不需要导入：${source}`)
  if (!existsSync(join(source, 'level.dat'))) {
    const children = (await readdir(source, { withFileTypes: true })).filter((entry) => entry.isDirectory() && existsSync(join(source, entry.name, 'level.dat')))
    if (children.length) throw new Error(`这是 saves 目录，请指向其中某个存档：${children.map((entry) => join(source, entry.name)).join('、')}`)
    throw new Error(`不是 Minecraft 存档（缺少 level.dat）：${source}`)
  }
  const level = await readLevel(source)
  const target: SaveVersion = { dataVersion: request.projectDataVersion ?? dataVersionFor(request.projectVersion), versionName: request.projectVersion }
  const compare = compareSaveVersion(level, target)
  if (compare.order === 'newer') {
    throw new Error(`已拒绝导入：存档比项目版本新，降级会损坏存档数据。${compare.detail}。原存档没有被改动；要用 ${target.versionName ?? '项目版本'} 打不开的内容，请改用相同版本的开发项目。`)
  }
  const warnings: string[] = []
  if (compare.order === 'older') warnings.push(`存档更旧：${compare.detail}，进入游戏时会被升级为新版本；原存档不受影响（只复制、不写入）`)
  if (compare.order === 'unknown') warnings.push(`无法判断版本先后：${compare.detail}，进不去或卡在加载界面就换用匹配的版本`)
  const wanted = assertWorldName(request.name?.trim() || basename(source))
  await mkdir(savesDir, { recursive: true })
  const world = uniqueWorldName(savesDir, wanted)
  const dir = join(savesDir, world)
  try {
    await cp(source, dir, { recursive: true, force: false, errorOnExist: false, filter: withoutSessionLock })
    const copied = await readLevel(dir)
    if (copied.dataVersion !== level.dataVersion) warnings.push(`复制后的 level.dat DataVersion 与原存档不一致（${copied.dataVersion} ≠ ${level.dataVersion}），请检查磁盘`)
    await writeJson(join(dir, IMPORT_MARKER), { version: 1, source, importedAt: Date.now(), versionName: level.versionName, dataVersion: level.dataVersion } satisfies ImportMark)
  } catch (failure) {
    await rm(dir, { recursive: true, force: true })
    const reason = failure instanceof Error ? failure.message : String(failure)
    if (/EBUSY|resource busy or locked/i.test(reason)) throw new Error(`复制存档失败（已清理半成品副本）：${source} 正被游戏占用（关掉打开它的游戏再导入）：${reason}`)
    throw new Error(`复制存档失败（已清理半成品副本）：${reason}`)
  }
  const sizes = await measure(dir)
  return { world, dir, source, level, compare, warnings, files: sizes.files, bytes: sizes.bytes, renamedFrom: world === wanted ? null : wanted }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

export function snapshotStamp(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function snapshotId(at: number, label?: string | null): string {
  const clean = (label ?? '')
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
  return clean ? `${snapshotStamp(at)}-${clean}` : snapshotStamp(at)
}

export function snapshotLabel(id: string): string | null {
  const match = /^\d{8}-\d{6}-(.+)$/.exec(id)
  return match ? match[1] : null
}

export function snapshotTime(id: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime()
}

export interface SnapshotRequest {
  runDir: string
  projectDir: string
  world: string
  label?: string | null
  at?: number
}

export async function createSnapshot(request: SnapshotRequest): Promise<SnapshotEntry> {
  const world = assertWorldName(request.world)
  const source = worldPath(request.runDir, world)
  if (!existsSync(join(source, 'level.dat'))) throw new Error(`开发存档 ${world} 不存在：${source}`)
  const at = request.at ?? Date.now()
  const root = join(snapshotsRoot(request.projectDir), world)
  await mkdir(root, { recursive: true })
  const base = snapshotId(at, request.label)
  let id = base
  for (let index = 2; existsSync(join(root, id)); index++) id = `${base}-${index}`
  const dir = join(root, id)
  try {
    await cp(source, dir, { recursive: true, force: false, errorOnExist: false, filter: withoutSessionLock })
    const level = await readLevel(dir)
    const sizes = await measure(dir)
    return { id, dir, world, label: request.label?.trim() || null, at, files: sizes.files, bytes: sizes.bytes, level }
  } catch (failure) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`创建快照失败：${failure instanceof Error ? failure.message : String(failure)}`)
  }
}

export async function listSnapshots(projectDir: string, world?: string | null): Promise<SnapshotEntry[]> {
  const root = snapshotsRoot(projectDir)
  const worlds = world ? [assertWorldName(world)] : await readdir(root, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).catch(() => [])
  const snapshots: SnapshotEntry[] = []
  for (const name of worlds) {
    const dir = join(root, name)
    const ids = await readdir(dir, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).catch(() => [])
    for (const id of ids) {
      const snapshotDir = join(dir, id)
      const level = await readLevel(snapshotDir).catch(() => null)
      const sizes = await measure(snapshotDir)
      snapshots.push({ id, dir: snapshotDir, world: name, label: snapshotLabel(id), at: snapshotTime(id) ?? sizes.modifiedAt, files: sizes.files, bytes: sizes.bytes, level })
    }
  }
  return snapshots.sort((left, right) => right.at - left.at)
}

export interface RestoreRequest {
  runDir: string
  projectDir: string
  world: string
  id: string
  backup?: boolean
}

export interface RestoreResult {
  world: string
  id: string
  dir: string
  files: number
  bytes: number
  backup: SnapshotEntry | null
  replaced: boolean
}

export async function restoreSnapshot(request: RestoreRequest): Promise<RestoreResult> {
  const world = assertWorldName(request.world)
  const id = assertSnapshotId(request.id)
  const snapshotDir = join(snapshotsRoot(request.projectDir), world, id)
  if (!inside(snapshotsRoot(request.projectDir), snapshotDir)) throw new Error(`快照路径不合法：${snapshotDir}`)
  if (!existsSync(join(snapshotDir, 'level.dat'))) throw new Error(`快照 ${id} 里没有 level.dat：${snapshotDir}`)
  const sizes = await measure(snapshotDir)
  const target = worldPath(request.runDir, world)
  const existed = existsSync(target)
  let backup: SnapshotEntry | null = null
  if (existed && request.backup !== false) backup = await createSnapshot({ runDir: request.runDir, projectDir: request.projectDir, world, label: 'before-restore' })
  const staging = `${target}.inkstone-restoring`
  await rm(staging, { recursive: true, force: true })
  try {
    await cp(snapshotDir, staging, { recursive: true, filter: withoutSessionLock })
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } catch (failure) {
    await rm(staging, { recursive: true, force: true })
    throw new Error(`恢复失败${backup ? `（恢复前的状态已存成快照 ${backup.id}）` : ''}：${failure instanceof Error ? failure.message : String(failure)}`)
  }
  if (!existsSync(join(target, 'level.dat'))) throw new Error(`恢复后 ${target} 里没有 level.dat`)
  return { world, id, dir: target, files: sizes.files, bytes: sizes.bytes, backup, replaced: existed }
}

export async function deleteSnapshot(projectDir: string, world: string, id: string): Promise<void> {
  const name = assertWorldName(world)
  const target = join(snapshotsRoot(projectDir), name, assertSnapshotId(id))
  if (!inside(snapshotsRoot(projectDir), target)) throw new Error(`快照路径不合法：${target}`)
  if (!existsSync(target)) throw new Error(`没有快照 ${id}（存档 ${name}）`)
  await rm(target, { recursive: true, force: true })
  const rest = await readdir(join(snapshotsRoot(projectDir), name)).catch(() => [name])
  if (!rest.length) await rm(join(snapshotsRoot(projectDir), name), { recursive: true, force: true })
}
