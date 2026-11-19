import { pick } from '../shared/ui-lang'
import {
  createReadStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, readlink, readdir, stat, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PI_AGENT_DIR } from './paths'

function controlDir(): string {
  const base = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming')
  return join(base, 'yan-desktop')
}
const PENDING_FILE = (): string => join(controlDir(), 'storage-move.json')
const RESULT_FILE = (): string => join(controlDir(), 'storage-move-result.json')
const LOCK_FILE = (): string => join(controlDir(), 'storage-move.lock')
const SWITCH_FILE = (): string => join(controlDir(), 'storage-move-switch.json')

export interface StorageMoveResult {
  ok: boolean
  at: number
  from: string
  to: string
  error?: string
  leftover?: string
}

export interface StorageInfo {
  agentDir: string
  realDir: string
  relocated: boolean
  movable: boolean
  pendingTarget?: string
  strandedBackup?: string
  oldCopy?: string
  lastResult?: StorageMoveResult
}

function defaultAgentDir(): string {
  return join(homedir(), '.pi', 'agent')
}

function abandonedMoveLock(lock: string): boolean {
  let owner: number
  try {
    owner = Number(readFileSync(lock, 'utf8').trim())
  } catch {
    return false
  }
  if (!Number.isSafeInteger(owner) || owner <= 0) return true
  if (owner === process.pid) return false
  try {
    process.kill(owner, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export function storageMovable(): boolean {
  return !process.env.PORTABLE_EXECUTABLE_DIR?.trim() && !process.env.YAN_PI_DIR?.trim() && !process.argv.some((a) => a.startsWith('--yan-pi-dir='))
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

export interface StorageMoveProgress {
  phase: 'scan' | 'copy' | 'verify' | 'cleanup'
  files: number
  bytes: number
  totalFiles: number
  totalBytes: number
}

async function tally(dir: string): Promise<{ files: number; bytes: number; latestMtime: number; content: string }> {
  const entries: Array<[string, string, string]> = []
  const hash = async (file: string): Promise<string> => {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(file)) digest.update(chunk)
    return digest.digest('hex')
  }
  let files = 0
  let bytes = 0
  let latestMtime = 0
  const walk = async (d: string): Promise<void> => {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) {
        entries.push([relative(dir, p), 'directory', ''])
        await walk(p)
      } else if (ent.isSymbolicLink()) {
        entries.push([relative(dir, p), 'link', await readlink(p)])
      } else if (ent.isFile()) {
        entries.push([relative(dir, p), 'file', await hash(p)])
        const info = await stat(p)
        files++
        bytes += info.size
        if (info.mtimeMs > latestMtime) latestMtime = info.mtimeMs
      }
    }
  }
  await walk(dir)
  return { files, bytes, latestMtime, content: JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }
}

function isJunction(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

const SYNC_FOLDER_NAMES: Array<[RegExp, string]> = [
  [/^onedrive( - .+)?$/i, 'OneDrive'],
  [/^dropbox( \(.+\))?$/i, 'Dropbox'],
  [/^google drive$|^我的云端硬盘$|^my drive$/i, 'Google Drive'],
  [/^icloud ?drive$|^iclouddrive$/i, 'iCloud Drive'],
  [/坚果云|^nutstore/i, '坚果云'],
  [/^百度网盘同步|^baidunetdisk.*sync/i, '百度网盘'],
  [/^syncthing$|^sync$/i, 'Syncthing']
]
const SYNC_FOLDER_MARKERS: Array<[string, string]> = [['.stfolder', 'Syncthing'], ['.dropbox', 'Dropbox'], ['.nutstore', '坚果云']]

export function syncFolderService(target: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const full = resolve(target)
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[key]
    if (!root) continue
    const rel = relative(resolve(root), full)
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return 'OneDrive'
  }
  let dir = full
  for (;;) {
    const name = basename(dir)
    for (const [pattern, service] of SYNC_FOLDER_NAMES) if (pattern.test(name)) return service
    for (const [marker, service] of SYNC_FOLDER_MARKERS) if (existsSync(join(dir, marker))) return service
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function checkTarget(from: string, to: string): string | undefined {
  if (/^[\\/]{2}/.test(to)) return pick('不能迁移到网络共享路径，请选本机磁盘上的文件夹', 'Cannot move to a network share. Choose a folder on a local disk')
  const rel = relative(from, to)

  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return pick('不能迁移到原数据目录里面', 'Cannot move into the original data folder')
  const back = relative(to, from)
  if (!back || (back !== '..' && !back.startsWith(`..${sep}`) && !isAbsolute(back))) return pick('不能迁移到包含原数据目录的文件夹', 'Cannot move into a folder that contains the original data folder')
  try {
    if (existsSync(to) && readdirSync(to).length > 0) return targetNotEmpty(to)
  } catch {
    return pick('无法读取目标文件夹（可能没有访问权限）', 'Cannot read the target folder (access may be denied)')
  }
  return undefined
}

function targetNotEmpty(to: string): string {
  return pick(`目标目录 ${to} 不是空文件夹，已有内容已保留。请另选一个空文件夹或新建一个。`, `The destination ${to} is not empty. Its existing contents were kept. Choose a different empty folder or create one.`)
}

function entry(path: string) {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

function directoryId(path: string): string | undefined {
  const info = entry(path)
  if (info?.isDirectory() && !info.isSymbolicLink() && info.ino !== 0n) return `${info.dev}:${info.ino}`
  return undefined
}

function canonicalPath(path: string): string {
  if (entry(path)) return realpathSync.native(path)
  const parent = dirname(path)
  if (parent === path) return realpathSync.native(path)
  return join(canonicalPath(parent), basename(path))
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function overlaps(a: string, b: string): boolean {
  return inside(a, b) || inside(b, a)
}

const backupPrefix = (from: string): string => `${basename(from)}.迁移前备份-`
const SWITCH_BACKUP_SUFFIX = /^\d{13}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function backupSuffix(from: string, name: string): string | undefined {
  const prefix = backupPrefix(from)
  return name.toLowerCase().startsWith(prefix.toLowerCase()) ? name.slice(prefix.length) : undefined
}

function backupPaths(from: string): string[] {
  const parent = dirname(from)
  if (!entry(parent)) return []
  return readdirSync(parent).sort().reverse().flatMap((name) => {
    const suffix = backupSuffix(from, name)
    if (!suffix || (!/^\d{13}$/.test(suffix) && !SWITCH_BACKUP_SUFFIX.test(suffix))) return []
    const path = join(parent, name)
    const info = entry(path)
    return info?.isDirectory() && !info.isSymbolicLink() ? [path] : []
  })
}

function findBackup(from: string, active?: string): string | undefined {
  try {
    return backupPaths(from).find((path) => !active || !overlaps(realpathSync.native(path), active))
  } catch {
    return undefined
  }
}

interface StorageSwitch {
  version: 1
  from: string
  parent: string
  to: string
  backup: string
  sourceId: string
  targetId: string
  digest: string
}

function switchBlocked(from: string, detail: string): Error {
  return new Error(pick(
    `无法确认数据迁移状态，已阻止启动。请保留原目录、迁移前备份和目标数据，不要覆盖或删除任何一份。\n原位置：${from}\n${detail}`,
    `Inkstone cannot verify the data move and will not start. Keep the original folder, backup and destination; do not overwrite or delete any copy.\nOriginal location: ${from}\n${detail}`
  ))
}

function validateTargetLocation(from: string, to: string): boolean {
  if (!isAbsolute(to) || /^[\\/]{2}/.test(to) || to !== resolve(to)) return false
  const actual = canonicalPath(to)
  const original = join(realpathSync.native(dirname(from)), basename(from))
  const control = canonicalPath(resolve(controlDir()))
  return !relative(actual, to) && !overlaps(original, actual) && !overlaps(control, actual) &&
    !isBackupLocation(original, actual)
}

function isBackupLocation(from: string, to: string): boolean {
  const rel = relative(dirname(from), to)
  return rel.split(sep)[0].toLowerCase().startsWith(backupPrefix(from).toLowerCase())
}

function publishSwitch(move: StorageSwitch): void {
  const file = SWITCH_FILE()
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(move), { flag: 'wx', flush: true })
  try {
    linkSync(temp, file)
  } finally {
    rmSync(temp, { force: true })
  }
}

const contentDigest = (content: string): string => createHash('sha256').update(content).digest('hex')

function expectSwitched(move: StorageSwitch): void {
  if (!entry(move.from)?.isSymbolicLink() || relative(realpathSync.native(move.from), move.to) ||
    directoryId(move.to) !== move.targetId || directoryId(move.backup) !== move.sourceId) {
    throw switchBlocked(move.from, `${move.backup}\n${move.to}\n${SWITCH_FILE()}`)
  }
}

async function recoverSwitch(from: string): Promise<StorageMoveResult> {
  const record = entry(SWITCH_FILE())?.isFile() ? readJson<Partial<StorageSwitch>>(SWITCH_FILE()) : undefined
  if (!record || record.version !== 1 || record.from !== from || record.parent !== realpathSync.native(dirname(from)) ||
    typeof record.backup !== 'string' || dirname(record.backup) !== dirname(from) ||
    !SWITCH_BACKUP_SUFFIX.test(backupSuffix(from, basename(record.backup)) ?? '') ||
    typeof record.to !== 'string' || !isAbsolute(record.to) ||
    typeof record.sourceId !== 'string' || typeof record.targetId !== 'string' || record.sourceId === record.targetId ||
    typeof record.digest !== 'string' || !/^[\da-f]{64}$/.test(record.digest)) {
    throw switchBlocked(from, SWITCH_FILE())
  }
  const move = record as StorageSwitch
  const fail = (): Error => switchBlocked(from, `${move.backup}\n${move.to}\n${SWITCH_FILE()}`)
  if (!entry(move.backup) && directoryId(from) === move.sourceId) {
    rmSync(SWITCH_FILE())
    return saveMoveResult(from, move.to, { ok: false, error: pick('迁移在切换前中断，仍使用原目录。目标副本已保留。', 'The move stopped before switching. The original folder is still in use, and the destination copy was kept.') })
  }
  const intactPaths = (): boolean => move.parent === realpathSync.native(dirname(from)) && validateTargetLocation(from, move.to) &&
    directoryId(move.backup) === move.sourceId && directoryId(move.to) === move.targetId
  if (!intactPaths()) throw fail()
  if (entry(from)) expectSwitched(move)
  const copies = await Promise.all([tally(move.backup), tally(move.to)])
  if (copies.some(({ content }) => contentDigest(content) !== move.digest) || !intactPaths()) throw fail()
  if (!entry(from)) symlinkSync(move.to, from, 'junction')
  expectSwitched(move)
  const result = saveMoveResult(from, move.to, { ok: true, leftover: move.backup })
  rmSync(SWITCH_FILE())
  return result
}

export function assertStorageStartupSafe(): void {
  if (!storageMovable()) return
  const from = defaultAgentDir()
  if (entry(SWITCH_FILE())) throw switchBlocked(from, SWITCH_FILE())
  const original = entry(from)
  if (original?.isSymbolicLink()) {
    if (!existsSync(from) || !directoryId(realpathSync.native(from))) throw switchBlocked(from, from)
  } else {
    if (original && !original.isDirectory()) throw switchBlocked(from, from)
    if (!original || !readdirSync(from).length) {
      const backups = backupPaths(from)
      if (backups.length) throw switchBlocked(from, backups.join('\n'))
    }
  }
}

export function hasPendingStorageMove(): boolean {
  return storageMovable() && (!!entry(SWITCH_FILE()) || !!readJson<{ target?: unknown }>(PENDING_FILE())?.target)
}

function saveMoveResult(from: string, to: string, result: Omit<StorageMoveResult, 'at' | 'from' | 'to'>): StorageMoveResult {
  const value = { ...result, at: Date.now(), from, to }
  try {
    mkdirSync(controlDir(), { recursive: true })
    writeFileSync(RESULT_FILE(), JSON.stringify(value, null, 2))
  } catch {
  }
  return value
}

export async function runPendingStorageMove(onProgress?: (progress: StorageMoveProgress) => void): Promise<StorageMoveResult | undefined> {
  if (!hasPendingStorageMove()) return undefined
  mkdirSync(controlDir(), { recursive: true })
  if (abandonedMoveLock(LOCK_FILE())) rmSync(LOCK_FILE(), { force: true })
  writeFileSync(LOCK_FILE(), String(process.pid), { flag: 'wx' })
  try {
    const from = defaultAgentDir()
    if (entry(SWITCH_FILE())) return await recoverSwitch(from)
    assertStorageStartupSafe()
    const pending = readJson<{ target?: unknown }>(PENDING_FILE())
    rmSync(PENDING_FILE(), { force: true })
    if (typeof pending?.target !== 'string' || !isAbsolute(pending.target)) return undefined
    return await copyAndSwitch(from, resolve(pending.target), onProgress)
  } finally {
    rmSync(LOCK_FILE(), { force: true })
  }
}

async function copyAndSwitch(from: string, to: string, onProgress?: (progress: StorageMoveProgress) => void): Promise<StorageMoveResult> {
  let copyStarted = false
  const write = (r: Omit<StorageMoveResult, 'at' | 'from' | 'to'>): StorageMoveResult => {
    const retained = !r.ok && copyStarted
      ? pick(` 目标目录 ${to} 的内容已保留；重试请选另一个空文件夹。`, ` Contents at ${to} were left in place. Choose a different empty folder to retry.`)
      : ''
    return saveMoveResult(from, to, { ...r, ...(retained ? { error: `${r.error ?? ''}${retained}` } : {}) })
  }
  try {
    if (isJunction(from)) return write({ ok: false, error: pick('数据目录已经迁移过了', 'The data folder has already been moved') })
    const sourceId = directoryId(from)
    if (!sourceId) return write({ ok: false, error: pick('原数据目录不存在或不是普通目录', 'The original data folder is missing or is not a regular directory') })
    const parent = realpathSync.native(dirname(from))
    const bad = checkTarget(from, to)
    if (bad) return write({ ok: false, error: bad })
    const badLocation = pick('无法确认目标是独立的普通文件夹，请另选位置', 'Cannot verify that the destination is a separate regular folder. Choose a different location.')
    if (!validateTargetLocation(from, to)) return write({ ok: false, error: badLocation })
    const progress: StorageMoveProgress = { phase: 'scan', files: 0, bytes: 0, totalFiles: 0, totalBytes: 0 }
    const report = (patch: Partial<StorageMoveProgress>): void => {
      Object.assign(progress, patch)
      onProgress?.({ ...progress })
    }
    report({})
    const before = await tally(from)
    report({ phase: 'copy', totalFiles: before.files, totalBytes: before.bytes })
    mkdirSync(to, { recursive: true })
    const targetId = directoryId(to)
    if (!targetId || targetId === sourceId || !validateTargetLocation(from, to)) return write({ ok: false, error: badLocation })
    if (readdirSync(to).length) return write({ ok: false, error: targetNotEmpty(to) })
    copyStarted = true
    for (const name of await readdir(from)) {
      await cp(join(from, name), join(to, name), {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        filter: async (source) => {
          const entry = await lstat(source)
          if (entry.isFile()) report({ files: progress.files + 1, bytes: progress.bytes + entry.size })
          return true
        }
      })
    }
    report({ phase: 'verify' })
    const [source, after] = await Promise.all([tally(from), tally(to)])
    if (after.content !== source.content || source.content !== before.content) {
      return write({ ok: false, error: pick(`复制核对不一致（${source.files} → ${after.files} 个文件），未切换数据目录`, `Copy check mismatch (${source.files} → ${after.files} files). The data location was not switched.`) })
    }
    const recheck = await tally(from)
    if (recheck.files !== before.files || recheck.bytes !== before.bytes || recheck.latestMtime !== before.latestMtime || recheck.content !== before.content) {
      return write({ ok: false, error: pick('迁移期间原目录仍在被写入（可能还有别的 pi 或砚在运行），未切换数据目录', 'The original data folder was still being written during the move (another pi or Inkstone may be running). The data location was not switched.') })
    }
    const backup = join(dirname(from), `${backupPrefix(from)}${Date.now()}-${randomUUID()}`)
    if (directoryId(from) !== sourceId || directoryId(to) !== targetId ||
      parent !== realpathSync.native(dirname(from)) || !validateTargetLocation(from, to) || entry(backup)) {
      return write({ ok: false, error: badLocation })
    }
    const move: StorageSwitch = { version: 1, from, parent, to, backup, sourceId, targetId, digest: contentDigest(after.content) }
    publishSwitch(move)
    try {
      if (entry(backup) || directoryId(from) !== sourceId || parent !== realpathSync.native(dirname(from))) throw new Error(badLocation)
      renameSync(from, backup)
    } catch (error) {
      if (!entry(backup) && directoryId(from) === sourceId) rmSync(SWITCH_FILE())
      throw error
    }
    if (directoryId(backup) !== sourceId || directoryId(to) !== targetId || !validateTargetLocation(from, to)) throw new Error(badLocation)
    symlinkSync(to, from, 'junction')
    expectSwitched(move)
    report({ phase: 'cleanup' })
    const result = write({ ok: true, leftover: backup })
    rmSync(SWITCH_FILE())
    return result
  } catch (error) {
    if (entry(SWITCH_FILE())) throw switchBlocked(from, `${SWITCH_FILE()}\n${to}\n${error instanceof Error ? error.message : String(error)}`)
    return write({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export function storageInfo(): StorageInfo {
  const agentDir = storageMovable() ? defaultAgentDir() : PI_AGENT_DIR
  let realDir = agentDir
  try {
    realDir = realpathSync.native(agentDir)
  } catch {
  }
  const relocated = isJunction(agentDir)
  const oldCopy = relocated && !entry(SWITCH_FILE()) && existsSync(agentDir) ? findBackup(agentDir, realDir) : undefined
  return {
    agentDir,
    realDir,
    relocated,
    ...(existsSync(agentDir) ? {} : { strandedBackup: findBackup(agentDir) }),
    ...(oldCopy ? { oldCopy } : {}),
    movable: storageMovable(),
    pendingTarget: readJson<{ target?: string }>(PENDING_FILE())?.target,
    lastResult: readJson<StorageMoveResult>(RESULT_FILE())
  }
}

export async function trashOldStorageCopy(path: string, trash: (path: string) => Promise<void>): Promise<{ ok: boolean; error?: string }> {
  const info = storageInfo()
  if (!info.oldCopy || !path || relative(info.oldCopy, resolve(path))) {
    return { ok: false, error: pick('这不是迁移前的旧数据目录', 'This is not the pre-move data folder') }
  }
  try {
    if (!directoryId(info.oldCopy) || overlaps(realpathSync.native(info.oldCopy), realpathSync.native(info.agentDir))) {
      return { ok: false, error: pick('无法确认这是独立的旧数据目录，已拒绝处理', 'Cannot verify that this is a separate old data folder; refused') }
    }
    await trash(info.oldCopy)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function storageSize(dir: string): Promise<number> {
  let bytes = 0
  const walk = async (d: string): Promise<void> => {
    let ents
    try {
      ents = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) await walk(p)
      else if (ent.isFile()) bytes += (await stat(p).catch(() => ({ size: 0 }))).size
    }
  }
  await walk(dir)
  return bytes
}

export async function scheduleStorageMove(target: string): Promise<{ ok: boolean; error?: string }> {
  if (!storageMovable()) return { ok: false, error: pick('便携版或测试环境的数据位置由启动方式决定，不能在这里迁移', 'The data location of portable or test builds is set by how they start. It cannot be moved here') }
  const from = defaultAgentDir()
  if (isJunction(from)) return { ok: false, error: pick('数据目录已经迁移过了', 'The data folder has already been moved') }
  if (!target || !isAbsolute(target)) return { ok: false, error: pick('请选择一个完整的文件夹路径', 'Choose a full folder path') }
  const to = resolve(target)
  const bad = checkTarget(from, to)
  if (bad) return { ok: false, error: bad }
  try {
    const need = await storageSize(from)
    const fsInfo = await statfs(existsSync(to) ? to : dirname(to))
    const free = Number(fsInfo.bavail) * Number(fsInfo.bsize)
    if (free < need * 1.1) {
      return { ok: false, error: pick(`目标磁盘空间不足：需要约 ${(need / 1024 ** 3).toFixed(1)} GB，可用 ${(free / 1024 ** 3).toFixed(1)} GB`, `Not enough disk space on the target: about ${(need / 1024 ** 3).toFixed(1)} GB needed, ${(free / 1024 ** 3).toFixed(1)} GB available`) }
    }
  } catch {
  }
  mkdirSync(controlDir(), { recursive: true })
  writeFileSync(PENDING_FILE(), JSON.stringify({ target: to, at: Date.now() }, null, 2))
  return { ok: true }
}

export function cancelStorageMove(): void {
  rmSync(PENDING_FILE(), { force: true })
}
