import {
  existsSync,
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
import { cp, lstat, readdir, rm, stat, statfs } from 'node:fs/promises'
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

async function tally(dir: string): Promise<{ files: number; bytes: number; latestMtime: number }> {
  let files = 0
  let bytes = 0
  let latestMtime = 0
  const walk = async (d: string): Promise<void> => {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) await walk(p)
      else if (ent.isFile()) {
        const info = await stat(p)
        files++
        bytes += info.size
        if (info.mtimeMs > latestMtime) latestMtime = info.mtimeMs
      }
    }
  }
  await walk(dir)
  return { files, bytes, latestMtime }
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
  if (/^[\\/]{2}/.test(to)) return '不能迁移到网络共享路径，请选本机磁盘上的文件夹'
  const rel = relative(from, to)

  if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return '不能迁移到原数据目录里面'
  const back = relative(to, from)
  if (!back || (back !== '..' && !back.startsWith(`..${sep}`) && !isAbsolute(back))) return '不能迁移到包含原数据目录的文件夹'
  try {
    if (existsSync(to) && readdirSync(to).length > 0) return '目标文件夹不是空的，请选一个空文件夹或新建一个'
  } catch {
    return '无法读取目标文件夹（可能没有访问权限）'
  }
  return undefined
}

function findBackup(from: string): string | undefined {
  try {
    const prefix = `${basename(from)}.迁移前备份-`
    const name = readdirSync(dirname(from)).filter((n) => n.startsWith(prefix)).sort().pop()
    return name ? join(dirname(from), name) : undefined
  } catch {
    return undefined
  }
}

export function hasPendingStorageMove(): boolean {
  return !!readJson<{ target?: string }>(PENDING_FILE())?.target
}

export async function runPendingStorageMove(onProgress?: (progress: StorageMoveProgress) => void): Promise<StorageMoveResult | undefined> {
  const pending = readJson<{ target?: string }>(PENDING_FILE())
  if (!pending?.target) return undefined
  const from = defaultAgentDir()
  const to = resolve(pending.target)
  const write = (r: Omit<StorageMoveResult, 'at' | 'from' | 'to'>): StorageMoveResult => {
    const result = { ...r, at: Date.now(), from, to }
    try {
      mkdirSync(controlDir(), { recursive: true })
      writeFileSync(RESULT_FILE(), JSON.stringify(result, null, 2))
    } catch {
    }
    return result
  }
  if (!storageMovable()) {
    rmSync(PENDING_FILE(), { force: true })
    return write({ ok: false, error: '便携版或测试环境的数据位置由启动方式决定，不能在这里迁移' })
  }
  try {
    mkdirSync(controlDir(), { recursive: true })
    if (abandonedMoveLock(LOCK_FILE())) rmSync(LOCK_FILE(), { force: true })
    writeFileSync(LOCK_FILE(), String(process.pid), { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return write({ ok: false, error: '另一次数据位置迁移正在进行，请等它结束后重试' })
    }
    return write({ ok: false, error: `无法创建迁移标记文件：${error instanceof Error ? error.message : String(error)}` })
  }
  rmSync(PENDING_FILE(), { force: true })
  try {
    if (isJunction(from)) return write({ ok: false, error: '数据目录已经迁移过了' })
    if (!existsSync(from)) return write({ ok: false, error: '原数据目录不存在' })
    const bad = checkTarget(from, to)
    if (bad) return write({ ok: false, error: bad })
    const progress: StorageMoveProgress = { phase: 'scan', files: 0, bytes: 0, totalFiles: 0, totalBytes: 0 }
    const report = (patch: Partial<StorageMoveProgress>): void => {
      Object.assign(progress, patch)
      onProgress?.({ ...progress })
    }
    report({})
    const before = await tally(from)
    report({ phase: 'copy', totalFiles: before.files, totalBytes: before.bytes })
    const createdTarget = !existsSync(to)
    mkdirSync(to, { recursive: true })
    const discardTarget = async (): Promise<void> => {
      if (createdTarget) {
        await rm(to, { recursive: true, force: true })
        return
      }
      for (const name of await readdir(to).catch(() => [])) await rm(join(to, name), { recursive: true, force: true })
    }
    try {
      for (const name of await readdir(from)) {
        await cp(join(from, name), join(to, name), {
          recursive: true,
          preserveTimestamps: true,
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
      if (after.files !== source.files || after.bytes !== source.bytes) {
        await discardTarget()
        return write({ ok: false, error: `复制核对不一致（${source.files} → ${after.files} 个文件），已撤回，原数据未动` })
      }
      const recheck = await tally(from)
      if (recheck.files !== before.files || recheck.bytes !== before.bytes || recheck.latestMtime !== before.latestMtime) {
        await discardTarget()
        return write({ ok: false, error: '迁移期间数据目录仍在被写入（可能还有别的 pi 或砚在运行），已撤回，原数据未动' })
      }
    } catch (error) {
      await discardTarget()
      throw error
    }
    const backup = `${from}.迁移前备份-${Date.now()}`
    try {
      renameSync(from, backup)
    } catch (e) {
      await discardTarget()
      return write({ ok: false, error: `原目录被占用，无法切换（请关掉终端里的 pi 后重试）：${e instanceof Error ? e.message : String(e)}` })
    }
    try {
      symlinkSync(to, from, 'junction')
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      try {
        renameSync(backup, from)
      } catch (e2) {
        return write({ ok: false, leftover: backup, error: `无法建立联接，也无法自动恢复原目录。你的数据完整保存在：${backup}（把它改回「agent」即可恢复）。${why}；${e2 instanceof Error ? e2.message : String(e2)}` })
      }
      await discardTarget()
      return write({ ok: false, error: `无法在原位置建立联接，已恢复原状：${why}` })
    }
    report({ phase: 'cleanup' })
    try {
      await rm(backup, { recursive: true, force: true, maxRetries: 3 })
      return write({ ok: true })
    } catch {
      return write({ ok: true, leftover: backup })
    }
  } catch (e) {
    const stranded = !existsSync(from) ? findBackup(from) : undefined
    return write({ ok: false, ...(stranded ? { leftover: stranded } : {}), error: e instanceof Error ? e.message : String(e) })
  } finally {
    rmSync(LOCK_FILE(), { force: true })
  }
}

export function storageInfo(): StorageInfo {
  const agentDir = storageMovable() ? defaultAgentDir() : PI_AGENT_DIR
  let realDir = agentDir
  try {
    realDir = realpathSync(agentDir)
  } catch {
  }
  return {
    agentDir,
    realDir,
    relocated: isJunction(agentDir),
    ...(existsSync(agentDir) ? {} : { strandedBackup: findBackup(agentDir) }),
    movable: storageMovable(),
    pendingTarget: readJson<{ target?: string }>(PENDING_FILE())?.target,
    lastResult: readJson<StorageMoveResult>(RESULT_FILE())
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
  if (!storageMovable()) return { ok: false, error: '便携版或测试环境的数据位置由启动方式决定，不能在这里迁移' }
  const from = defaultAgentDir()
  if (isJunction(from)) return { ok: false, error: '数据目录已经迁移过了' }
  if (!target || !isAbsolute(target)) return { ok: false, error: '请选择一个完整的文件夹路径' }
  const to = resolve(target)
  const bad = checkTarget(from, to)
  if (bad) return { ok: false, error: bad }
  try {
    const need = await storageSize(from)
    const fsInfo = await statfs(existsSync(to) ? to : dirname(to))
    const free = Number(fsInfo.bavail) * Number(fsInfo.bsize)
    if (free < need * 1.1) {
      return { ok: false, error: `目标磁盘空间不足：需要约 ${(need / 1024 ** 3).toFixed(1)} GB，可用 ${(free / 1024 ** 3).toFixed(1)} GB` }
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
