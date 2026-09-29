/**
 * 数据目录迁移：把 pi 的整个私有目录（会话、凭证、砚数据、语音模型、浏览器配置）
 * 搬到用户选的位置（通常是 D 盘等非系统盘），为 C 盘腾空间。
 *
 * ── 兼容旧记录 ──
 * 搬完在原位置留一个**目录联接**（junction）指向新位置：
 *   · 会话记录、任务日志、产物索引里写的绝对路径全部照常可用，不改写任何记录；
 *   · 终端里直接跑的 `pi`（默认读 ~/.pi/agent）也照常工作。
 * 所以应用内部的路径常量不变，只是物理位置换了。
 *
 * ── 为什么在下次启动时搬 ──
 * 运行中 pi 子进程与浏览器配置都开着文件句柄，Windows 下目录改名会失败。
 * 设置页只登记「待迁移」并重启应用；新进程在 import 阶段最先执行 `runPendingStorageMove`，
 * 那时还没有任何模块打开数据目录里的文件。
 *
 * ── 顺序（任何一步失败都不删原数据）──
 *   复制到新位置 → 核对文件数与总字节 → 原目录改名为「.迁移前备份」→ 原位置建联接
 *   → 删除备份。改名失败（文件被占用）时撤回：删掉新位置的副本、原目录不动。
 *   删除备份失败时保留它，并在结果里告诉用户可以手动删。
 *
 * 便携版（数据本来就在 EXE 旁）与测试用的 YAN_PI_DIR 覆盖不参与迁移。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { readdir, stat, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { PI_AGENT_DIR } from './paths'

/** 与应用数据无关的固定位置：迁移登记与结果不能放在要被搬走的目录里 */
function controlDir(): string {
  const base = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming')
  return join(base, 'yan-desktop')
}
const PENDING_FILE = (): string => join(controlDir(), 'storage-move.json')
const RESULT_FILE = (): string => join(controlDir(), 'storage-move-result.json')

export interface StorageMoveResult {
  ok: boolean
  at: number
  from: string
  to: string
  error?: string
  /** 备份没删掉时的位置（用户可以手动删） */
  leftover?: string
}

export interface StorageInfo {
  /** 应用使用的路径（迁移后仍是原路径，经联接指向新位置） */
  agentDir: string
  /** 实际存放位置 */
  realDir: string
  relocated: boolean
  /** 这个安装形态能不能迁移（便携版 / 测试覆盖不能） */
  movable: boolean
  pendingTarget?: string
  /** 原位置不在、但旁边留着迁移前备份：数据没丢，在这里 */
  strandedBackup?: string
  lastResult?: StorageMoveResult
}

function defaultAgentDir(): string {
  return join(homedir(), '.pi', 'agent')
}

/** 只有「默认位置 + 非便携 + 没有测试覆盖」才迁移 */
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

function tally(dir: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile()) {
        files++
        bytes += statSync(p).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

function isJunction(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** 目标位置校验：登记时与启动执行前共用（pending 文件可能残留、被改过或从别处拷来） */
function checkTarget(from: string, to: string): string | undefined {
  if (/^[\\/]{2}/.test(to)) return '不能迁移到网络共享路径，请选本机磁盘上的文件夹'
  const rel = relative(from, to)
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return '不能迁移到原数据目录里面'
  const back = relative(to, from)
  if (!back || (!back.startsWith('..') && !isAbsolute(back))) return '不能迁移到包含原数据目录的文件夹'
  if (existsSync(to) && readdirSync(to).length > 0) return '目标文件夹不是空的，请选一个空文件夹或新建一个'
  return undefined
}

/** 原位置旁边的迁移前备份（回滚失败或中途崩溃时数据在这里） */
function findBackup(from: string): string | undefined {
  try {
    const prefix = `${basename(from)}.迁移前备份-`
    const name = readdirSync(dirname(from)).filter((n) => n.startsWith(prefix)).sort().pop()
    return name ? join(dirname(from), name) : undefined
  } catch {
    return undefined
  }
}

/** 启动最早期调用（同步）：有待迁移登记就执行，结果写到固定位置供设置页读取 */
export function runPendingStorageMove(): void {
  const pending = readJson<{ target?: string }>(PENDING_FILE())
  if (!pending?.target) return
  rmSync(PENDING_FILE(), { force: true })
  if (!storageMovable()) return
  const from = defaultAgentDir()
  const to = resolve(pending.target)
  const write = (r: Omit<StorageMoveResult, 'at' | 'from' | 'to'>): void => {
    try {
      mkdirSync(controlDir(), { recursive: true })
      writeFileSync(RESULT_FILE(), JSON.stringify({ ...r, at: Date.now(), from, to }, null, 2))
    } catch {
      /* 写不了结果也不影响启动 */
    }
  }
  try {
    if (isJunction(from)) return write({ ok: false, error: '数据目录已经迁移过了' })
    if (!existsSync(from)) return write({ ok: false, error: '原数据目录不存在' })
    const bad = checkTarget(from, to)
    if (bad) return write({ ok: false, error: bad })
    const before = tally(from)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
    const after = tally(to)
    if (after.files !== before.files || after.bytes !== before.bytes) {
      rmSync(to, { recursive: true, force: true })
      return write({ ok: false, error: `复制核对不一致（${before.files} → ${after.files} 个文件），已撤回，原数据未动` })
    }
    const backup = `${from}.迁移前备份-${Date.now()}`
    try {
      renameSync(from, backup)
    } catch (e) {
      rmSync(to, { recursive: true, force: true })
      return write({ ok: false, error: `原目录被占用，无法切换（请关掉终端里的 pi 后重试）：${e instanceof Error ? e.message : String(e)}` })
    }
    try {
      symlinkSync(to, from, 'junction')
    } catch (e) {
      /* 建不了联接：把原目录放回去，新位置的副本删掉 */
      const why = e instanceof Error ? e.message : String(e)
      try {
        renameSync(backup, from)
      } catch (e2) {
        /* 放不回去：数据完整地在备份目录里，新位置的副本也留着，都告诉用户 */
        return write({ ok: false, leftover: backup, error: `无法建立联接，也无法自动恢复原目录。你的数据完整保存在：${backup}（把它改回「agent」即可恢复）。${why}；${e2 instanceof Error ? e2.message : String(e2)}` })
      }
      rmSync(to, { recursive: true, force: true })
      return write({ ok: false, error: `无法在原位置建立联接，已恢复原状：${why}` })
    }
    try {
      rmSync(backup, { recursive: true, force: true, maxRetries: 3 })
      write({ ok: true })
    } catch {
      write({ ok: true, leftover: backup })
    }
  } catch (e) {
    const stranded = !existsSync(from) ? findBackup(from) : undefined
    write({ ok: false, ...(stranded ? { leftover: stranded } : {}), error: e instanceof Error ? e.message : String(e) })
  }
}

export function storageInfo(): StorageInfo {
  /* 不可迁移（便携版 / 测试覆盖）时报告实际在用的目录，而不是默认位置 */
  const agentDir = storageMovable() ? defaultAgentDir() : PI_AGENT_DIR
  let realDir = agentDir
  try {
    realDir = realpathSync(agentDir)
  } catch {
    /* 目录还不存在 */
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

/** 数据目录总大小（异步，设置页显示用） */
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

/** 登记下次启动迁移；校验目标位置，给出可读错误 */
export async function scheduleStorageMove(target: string): Promise<{ ok: boolean; error?: string }> {
  if (!storageMovable()) return { ok: false, error: '便携版或测试环境的数据位置由启动方式决定，不能在这里迁移' }
  const from = defaultAgentDir()
  if (isJunction(from)) return { ok: false, error: '数据目录已经迁移过了' }
  if (/^[\\/]{2}/.test(target ?? '')) return { ok: false, error: checkTarget(from, target) }
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
    /* 取不到空间信息时不拦，迁移本身会在复制失败时撤回 */
  }
  mkdirSync(controlDir(), { recursive: true })
  writeFileSync(PENDING_FILE(), JSON.stringify({ target: to, at: Date.now() }, null, 2))
  return { ok: true }
}

export function cancelStorageMove(): void {
  rmSync(PENDING_FILE(), { force: true })
}
