/**
 * 项目知识的落盘层（实施-03 S2）。
 *
 * 位置：`YAN_DIR/project-knowledge/<projectId>/`（见 [paths.ts](./paths.ts)）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 文件布局与理由
 * ══════════════════════════════════════════════════════════════════
 * ```
 * <projectId>/
 *   manifest.json            当前指针集合（原子替换；索引，可重建）
 *   manifest.json.bak        上一版 manifest（崩溃恢复的兜底）
 *   lock.json                排他锁（跨进程；过期也要核实进程才回收）
 *   entries/<id>/r<rev>.json 不可变 revision（正文在这里；永不重写已发布的）
 * ```
 *
 * **① 正文与索引分开。** manifest 每次提交整份替换；正文一旦发布就不动。
 * 这样「写坏一次」最多影响一条索引，而不是把整个知识库重写一遍
 * （把正文塞进 manifest，等于每次提交都在赌全部内容）。
 *
 * **② 先写正文，后写 manifest。** 顺序反过来的话，manifest 会先指到一个
 * 还不存在的文件；而按这个顺序崩溃，最坏是多一个没人引用的 revision 文件。
 *
 * **③ 临时文件与目标同卷。** 原子替换靠 `rename`；跨卷 `rename` 在 Windows 上
 * 会失败（或退化成复制）。所以临时文件写在**目标同目录**
 * （[tempPathFor]），而不是系统临时目录。
 *
 * **④ 落盘失败保留上一 manifest。** 任何一步失败都不改 manifest：
 * 校验先跑（`write_failed` 在正文阶段就抛出），备份写完才 `rename`。
 * 报成功而文件没变，是这一层最坏的失败模式。
 *
 * **⑤ 崩溃恢复。** manifest 半写 / 被手改坏 → 退回 `manifest.json.bak`；
 * 连备份也没了 → 按 revision 文件**重建**索引（每个条目取最高的**可解析**
 * revision）。重建的是索引，正文一个字节都不猜。
 *
 * **⑥ 排他锁。** 多进程（桌面应用 + `yan` CLI）会同时写同一个项目。
 * 锁文件里记 `pid` 与主机名；**过期不等于可回收** —— 同机必须
 * `process.kill(pid, 0)` 确认那个进程真的不在了才能删（见 [canReclaim]）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 身份
 * ══════════════════════════════════════════════════════════════════
 * 每个入口只接受 [ProjectIdentity]（由 `resolveProjectIdentity` 从**项目登记**
 * 解析出来），不接受裸字符串，也不接受 `cwd`：模型 / CLI 自报的 projectId
 * 进不到这里（实施-03 §3 / §4）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 本片不做的事
 * ══════════════════════════════════════════════════════════════════
 * 不做检索（S3）、不做 CLI（S4）、不做 UI（S5），也**不读**旧的
 * `memory.json` / `soul.md`（实施-03 §9：不自动转换）。
 */
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PROJECT_KNOWLEDGE_ROOT, projectKnowledgeDir } from './paths'
import {
  applyKnowledgeCommit,
  applyKnowledgeDelete,
  digestIndex,
  emptyKnowledgeManifest,
  findKnowledgePointer,
  inspectKnowledgeManifest,
  isSafeKnowledgeId,
  isSafeProjectId,
  pointerOf,
  readKnowledgeFile,
  type KnowledgeCommitRequest,
  type KnowledgeDeleteRequest,
  type KnowledgeFailure,
  type KnowledgeHostCheck,
  type KnowledgePointer,
  type ProjectIdentity,
  type ProjectKnowledge,
  type ProjectKnowledgeManifest,
  PROJECT_KNOWLEDGE_SCHEMA_VERSION
} from '../shared/project-memory'

export const MANIFEST_FILE_NAME = 'manifest.json'
export const MANIFEST_BACKUP_FILE_NAME = 'manifest.json.bak'
export const LOCK_FILE_NAME = 'lock.json'
export const ENTRIES_DIR_NAME = 'entries'

/** 锁的存活时间：正常一次提交是毫秒级，30s 已经远远够。 */
export const DEFAULT_LOCK_TTL_MS = 30_000
/** 抢不到锁时的等待上限。 */
export const DEFAULT_LOCK_WAIT_MS = 5_000
/** 抢锁失败后的重试间隔。 */
const LOCK_RETRY_MS = 25
/** 认不出的锁文件（写了一半的）要等这么久才敢当垃圾收掉。 */
const UNPARSABLE_LOCK_GRACE_MS = 5_000
/**
 * 别的机器留下的过期锁：**没有办法核实进程**（`kill(pid,0)` 只对本机有效）。
 * 所以先等一段宽限期，再按「反正没人能证明它活着」回收 ——
 * 否则网络盘上的崩溃会把这个项目永久锁死。
 */
const FOREIGN_STALE_GRACE_MS = 10 * 60_000

/** 存储层错误（区别于「请求本身不合法」的 [KnowledgeFailure]）。 */
export class ProjectKnowledgeStoreError extends Error {
  constructor(
    readonly code: 'bad_project_id' | 'locked' | 'read_failed' | 'write_failed',
    message: string
  ) {
    super(message)
    this.name = 'ProjectKnowledgeStoreError'
  }
}

export interface ProjectKnowledgeStoreOptions {
  /** 根目录覆盖（测试 / live 隔离）；生产不传 = `YAN_DIR/project-knowledge`。 */
  root?: string
  lockWaitMs?: number
  lockTtlMs?: number
}

/* ---------------------------------------------------------------- 路径 */

export function projectMemoryRoot(root?: string): string {
  return root ?? PROJECT_KNOWLEDGE_ROOT
}

/** 单个项目的知识目录。`projectId` 先过形状校验，防止路径穿越。 */
export function projectMemoryDir(projectId: string, root?: string): string {
  assertSafeProjectId(projectId)
  return root ? join(root, projectId) : projectKnowledgeDir(projectId)
}

export function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILE_NAME)
}

export function manifestBackupPath(dir: string): string {
  return join(dir, MANIFEST_BACKUP_FILE_NAME)
}

export function lockPath(dir: string): string {
  return join(dir, LOCK_FILE_NAME)
}

export function entriesDir(dir: string): string {
  return join(dir, ENTRIES_DIR_NAME)
}

export function revisionPath(dir: string, id: string, revision: number): string {
  return join(entriesDir(dir), id, `r${revision}.json`)
}

/**
 * 临时文件路径：**与目标同目录**（同卷），否则 `rename` 不是原子的
 * （跨卷在 Windows 上直接失败）。
 */
export function tempPathFor(target: string, seq: number): string {
  return `${target}.${process.pid}.${seq}.tmp`
}

function assertSafeProjectId(projectId: unknown): asserts projectId is string {
  if (!isSafeProjectId(projectId)) {
    throw new ProjectKnowledgeStoreError(
      'bad_project_id',
      `projectId 不能用作目录名：${String(projectId)}（身份必须来自项目登记）`
    )
  }
}

let tempSeq = 0
function nextSeq(): number {
  return ++tempSeq
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 宿主生成的条目 id：模型没有发言权（`draft.id` 只用于更新既有条目）。 */
function newKnowledgeId(): string {
  return `k-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/* ---------------------------------------------------------------- 原子写 */

/** `write + fsync`：只写进 OS 缓存就当成功，掉电就丢（那仍然是「报成功」）。 */
async function writeFileDurable(path: string, text: string): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** 目录项的 fsync 是尽力而为：Windows 上打不开目录句柄，失败不影响正确性。 */
async function syncDirBestEffort(dir: string): Promise<void> {
  const handle = await open(dir, 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync()
  } catch {
    /* 平台不支持 */
  } finally {
    await handle.close()
  }
}

function serializeManifest(manifest: ProjectKnowledgeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/**
 * 原子替换 manifest：临时文件 → 回读校验 → 上一版进备份 → `rename`。
 *
 * 校验失败**绝不** `rename`：manifest 是索引，半份索引比旧索引危险得多
 * （它会少几条知识、还可能把状态写错）。备份在 `rename` **之前**写，
 * 所以「备份写不进去」时主 manifest 也还是上一版（见单测「磁盘写失败」）。
 *
 * `backupPrevious: false` 给**恢复路径**用：那一轮的「上一版」正是要扔掉的
 * 坏文件，拿它覆盖备份等于把唯一的完好副本也弄坏（第二轮再坏就没得恢复了）。
 */
async function writeManifestAtomic(
  dir: string,
  manifest: ProjectKnowledgeManifest,
  backupPrevious = true
): Promise<void> {
  const target = manifestPath(dir)
  const temp = tempPathFor(target, nextSeq())
  try {
    await writeFileDurable(temp, serializeManifest(manifest))
    const back = inspectKnowledgeManifest(JSON.parse(await readFile(temp, 'utf8')))
    if (back.status !== 'ok') {
      throw new ProjectKnowledgeStoreError('write_failed', `manifest 回读校验失败：${back.reason}`)
    }
    if (backupPrevious) {
      const previous = await readFile(target, 'utf8').catch(() => null)
      if (previous !== null) await writeFileDurable(manifestBackupPath(dir), previous)
    }
    await rename(temp, target)
    await syncDirBestEffort(dir)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    if (err instanceof ProjectKnowledgeStoreError) throw err
    throw new ProjectKnowledgeStoreError('write_failed', `manifest 写不进去：${describe(err)}`)
  }
}

/** 写一份不可变 revision 文件（含 fsync + 回读校验）。 */
async function writeRevisionFile(dir: string, entry: ProjectKnowledge): Promise<void> {
  const target = revisionPath(dir, entry.id, entry.revision)
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFileDurable(target, `${JSON.stringify(entry, null, 2)}\n`)
    const back = readKnowledgeFile(JSON.parse(await readFile(target, 'utf8')))
    if (!back || back.id !== entry.id || back.revision !== entry.revision) {
      throw new ProjectKnowledgeStoreError('write_failed', `revision 文件回读校验失败：${target}`)
    }
    await syncDirBestEffort(dirname(target))
  } catch (err) {
    if (err instanceof ProjectKnowledgeStoreError) throw err
    throw new ProjectKnowledgeStoreError('write_failed', `revision 写不进去（${target}）：${describe(err)}`)
  }
}

/* ---------------------------------------------------------------- 排他锁 */

export interface LockRecord {
  pid: number
  host: string
  at: string
  expiresAt: string
  token: string
}

/**
 * 进程是否还在。
 *
 * `kill(pid, 0)` 不发信号，只做存在性检查：`ESRCH` = 不在，
 * `EPERM` = 在（只是没权限发信号）。这是「过期锁必须核实进程」的核实手段。
 */
export function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

interface LockRead {
  record: LockRecord | null
  ageMs: number
  /** 文件不在（已被释放）：调用方立刻重试，不用等 */
  missing: boolean
}

async function readLockRecord(path: string): Promise<LockRead> {
  let text: string
  let mtime: number
  try {
    const handle = await open(path, 'r')
    try {
      text = await handle.readFile('utf8')
      mtime = (await handle.stat()).mtimeMs
    } finally {
      await handle.close()
    }
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT'
    /* 权威判据是「删不掉」：读不了时把年龄当 0，让下方回收失败后正常退避，绝不自旋 */
    return { record: null, ageMs: missing ? Number.POSITIVE_INFINITY : 0, missing }
  }
  try {
    const raw = JSON.parse(text) as Partial<LockRecord>
    if (
      typeof raw.pid === 'number' &&
      typeof raw.host === 'string' &&
      typeof raw.token === 'string' &&
      typeof raw.expiresAt === 'string'
    ) {
      return {
        record: {
          pid: raw.pid,
          host: raw.host,
          at: typeof raw.at === 'string' ? raw.at : '',
          expiresAt: raw.expiresAt,
          token: raw.token
        },
        ageMs: Date.now() - mtime,
        missing: false
      }
    }
  } catch {
    /* 半写的锁文件 */
  }
  return { record: null, ageMs: Date.now() - mtime, missing: false }
}

/**
 * 这把锁能不能回收。
 *
 * 顺序很重要：**先核实进程，再删文件**。
 *  · 同机：`pid` 还活着 → 一律不抢（哪怕 TTL 过期 —— TTL 只说明「可能卡住了」，
 *    不说明「可以抢」）；进程真的不在了 → 回收；
 *  · 认不出的锁文件：等 [UNPARSABLE_LOCK_GRACE_MS]，避免抢到别人刚创建
 *    还没写内容的锁；
 *  · 别的机器：无法核实 → 只有超过宽限期才回收（见 [FOREIGN_STALE_GRACE_MS]）。
 */
function canReclaim(held: LockRead, host: string): boolean {
  if (held.missing) return false
  if (!held.record) return held.ageMs > UNPARSABLE_LOCK_GRACE_MS
  if (held.record.host !== host) {
    const expiresAt = Date.parse(held.record.expiresAt)
    return Number.isFinite(expiresAt) && Date.now() > expiresAt + FOREIGN_STALE_GRACE_MS
  }
  return !isProcessAlive(held.record.pid)
}

function describeHolder(held: { record: LockRecord | null }): string {
  if (!held.record) return '锁文件认不出（可能是另一个进程刚创建）'
  return `pid=${held.record.pid} host=${held.record.host} at=${held.record.at}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 清掉崩溃留下的临时文件。
 *
 * 只在**拿到锁之后**做：没有别的写者时，任何 `*.pid.seq.tmp` 都是垃圾
 * （临时文件不跨进程共享，见 [tempPathFor]）。
 * 刻意只认我们自己生成的名字形状 —— 项目目录里不该有别人的 `.tmp`，
 * 但也不该把用户手放在这儿的东西当垃圾扫。
 */
async function sweepTempFiles(dir: string): Promise<void> {
  const ours = (name: string): boolean => /\.\d+\.\d+\.tmp$/.test(name)
  const sweep = async (d: string): Promise<void> => {
    for (const name of await readdir(d).catch(() => [] as string[])) {
      if (!ours(name)) continue
      await unlink(join(d, name)).catch(() => undefined)
    }
  }
  await sweep(dir)
  for (const id of await readdir(entriesDir(dir)).catch(() => [] as string[])) {
    if (isSafeKnowledgeId(id)) await sweep(join(entriesDir(dir), id))
  }
}

/**
 * 抢项目目录的排他锁。
 *
 * 等待上限内每 [LOCK_RETRY_MS] 试一次；超时报 `locked`（**不**静默继续写 ——
 * 两个写者同时提交正是「后写覆盖前写」的现场）。
 */
export async function acquireProjectKnowledgeLock(
  dir: string,
  opts: ProjectKnowledgeStoreOptions = {}
): Promise<{ release: () => Promise<void> }> {
  const path = lockPath(dir)
  const host = hostname()
  const ttlMs = opts.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
  const waitMs = opts.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS
  const token = randomUUID()
  const deadline = Date.now() + waitMs
  await mkdir(dir, { recursive: true })

  for (;;) {
    try {
      const handle = await open(path, 'wx')
      try {
        const record: LockRecord = {
          pid: process.pid,
          host,
          at: nowIso(),
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          token
        }
        await handle.writeFile(JSON.stringify(record), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      /* 现在只有我们持有目录：崩溃留下的半写文件可以收掉了 */
      await sweepTempFiles(dir)
      return {
        release: async () => {
          const held = await readLockRecord(path)
          /* 只删自己那把：别人回收过再重建的锁不能被我们误删 */
          if (held.record && held.record.token !== token) return
          await unlink(path).catch(() => undefined)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw new ProjectKnowledgeStoreError('write_failed', `锁文件建不了（${path}）：${describe(err)}`)
      }
    }

    const held = await readLockRecord(path)
    /* 文件刚好被释放：立刻重试，不等 */
    if (held.missing) continue
    if (canReclaim(held, host)) {
      /* 核实过进程已死（或超出宽限期）才删；删不掉就走正常退避，绝不自旋 */
      if (await unlink(path).then(() => true).catch(() => false)) continue
    }
    if (Date.now() >= deadline) {
      throw new ProjectKnowledgeStoreError('locked', `项目知识目录正被占用：${describeHolder(held)}`)
    }
    await sleep(LOCK_RETRY_MS)
  }
}

/* ---------------------------------------------------------------- 读 manifest */

export type ManifestLoad =
  | { status: 'ok'; manifest: ProjectKnowledgeManifest; path: string }
  /** 主文件坏了 / 不在，但从备份或 revision 文件恢复了（已写回主文件）。 */
  | { status: 'recovered'; manifest: ProjectKnowledgeManifest; path: string; reason: 'backup' | 'rebuild' }
  /** 这个项目还没有任何知识（首次使用）。 */
  | { status: 'missing'; path: string }
  /** manifest 与备份都坏，且重建不出任何条目 —— **不能**当成空库。 */
  | { status: 'unreadable'; path: string; error: string }

type ManifestFileRead =
  | { status: 'ok'; manifest: ProjectKnowledgeManifest }
  | { status: 'missing' }
  | { status: 'invalid'; reason: string }
  | { status: 'unreadable'; error: string }

async function readManifestFile(path: string, projectId: string): Promise<ManifestFileRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unreadable', error: describe(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { status: 'invalid', reason: `JSON 解析失败：${describe(err)}` }
  }
  const inspected = inspectKnowledgeManifest(parsed)
  if (inspected.status !== 'ok') return { status: 'invalid', reason: inspected.reason }
  /* 文件名与内容必须一致：错位的 manifest 会把 A 项目的知识挂到 B 项目下 */
  if (inspected.manifest.projectId !== projectId) {
    return { status: 'invalid', reason: `projectId 与目录不符（文件里是 ${inspected.manifest.projectId}）` }
  }
  return { status: 'ok', manifest: inspected.manifest }
}

/**
 * 从 revision 文件重建索引。
 *
 * 每个条目取**最高的、还能解析的** revision：崩溃可能留下一个写了一半的
 * 高 revision，取它会让整个条目读不出来 —— 退回上一份完好的才是对的。
 * 一条都重建不出来就回 `undefined`（调用方据此判 unreadable / missing）。
 */
async function rebuildManifest(
  projectId: string,
  dir: string
): Promise<ProjectKnowledgeManifest | undefined> {
  const ids = await readdir(entriesDir(dir)).catch(() => [] as string[])
  const pointers: KnowledgePointer[] = []
  let revisionSum = 0
  for (const id of ids) {
    if (!isSafeKnowledgeId(id)) continue
    const files = (await readdir(join(entriesDir(dir), id)).catch(() => [] as string[]))
      .filter((name) => /^r\d+\.json$/.test(name))
      .sort((a, b) => Number(b.slice(1, -5)) - Number(a.slice(1, -5)))
    for (const name of files) {
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(join(entriesDir(dir), id, name), 'utf8'))
      } catch {
        continue
      }
      const entry = readKnowledgeFile(parsed)
      if (entry && entry.id === id && entry.projectId === projectId) {
        pointers.push(pointerOf(entry))
        revisionSum += entry.revision
        break
      }
    }
  }
  if (pointers.length === 0) return undefined
  pointers.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return {
    schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
    projectId,
    revision: revisionSum,
    updatedAt: nowIso(),
    entries: pointers
  }
}

/**
 * 读 manifest，必要时恢复。
 *
 * 恢复顺序：主文件 → 备份 → 从 revision 重建。恢复成功会**写回主文件**，
 * 所以下一次读就是普通的 `ok`（否则每次启动都要重放一遍恢复逻辑）。
 */
export async function loadManifest(
  projectId: string,
  opts: ProjectKnowledgeStoreOptions = {}
): Promise<ManifestLoad> {
  const dir = projectMemoryDir(projectId, opts.root)
  const path = manifestPath(dir)
  const main = await readManifestFile(path, projectId)
  if (main.status === 'ok') return { status: 'ok', manifest: main.manifest, path }

  const backup = await readManifestFile(manifestBackupPath(dir), projectId)
  if (backup.status === 'ok') {
    /* 恢复时不动备份：备份里那份才是完好的，别拿坏掉的主文件把它盖了 */
    await writeManifestAtomic(dir, backup.manifest, false)
    return { status: 'recovered', manifest: backup.manifest, path, reason: 'backup' }
  }

  const rebuilt = await rebuildManifest(projectId, dir)
  if (rebuilt) {
    await writeManifestAtomic(dir, rebuilt, false)
    return { status: 'recovered', manifest: rebuilt, path, reason: 'rebuild' }
  }

  if (main.status === 'invalid' || main.status === 'unreadable' || backup.status === 'invalid') {
    return {
      status: 'unreadable',
      path,
      error: main.status === 'invalid' ? main.reason : main.status === 'unreadable' ? main.error : '备份也坏了'
    }
  }
  return { status: 'missing', path }
}

/* ---------------------------------------------------------------- 读条目 */

/**
 * 读一个条目的正文。
 *
 * `exact = true`（写入路径）要求指针指的那份 revision 必须读得出来 ——
 * CAS 必须对着**磁盘上的当前版本**做，读不到就报错，绝不拿猜的旧版本顶替。
 * `exact = false`（展示路径）允许退回更早的完好 revision。
 */
async function loadEntry(
  dir: string,
  pointer: KnowledgePointer | undefined,
  exact: boolean
): Promise<ProjectKnowledge | null> {
  if (!pointer) return null
  const read = async (revision: number): Promise<ProjectKnowledge | null> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(revisionPath(dir, pointer.id, revision), 'utf8'))
    } catch {
      return null
    }
    const entry = readKnowledgeFile(parsed)
    if (!entry || entry.id !== pointer.id || entry.revision !== revision) return null
    return entry
  }

  const direct = await read(pointer.revision)
  if (direct || exact) {
    if (!direct && exact) {
      throw new ProjectKnowledgeStoreError(
        'read_failed',
        `条目 ${pointer.id} 的 revision ${pointer.revision} 读不出来（拒绝在状态不明时写入）`
      )
    }
    return direct
  }

  const names = await readdir(join(entriesDir(dir), pointer.id)).catch(() => [] as string[])
  const revisions = names
    .filter((name) => /^r\d+\.json$/.test(name))
    .map((name) => Number(name.slice(1, -5)))
    .filter((revision) => revision < pointer.revision)
    .sort((a, b) => b - a)
  for (const revision of revisions) {
    const entry = await read(revision)
    if (entry) return entry
  }
  return null
}

function manifestOf(loaded: ManifestLoad, projectId: string): ProjectKnowledgeManifest {
  if (loaded.status === 'ok' || loaded.status === 'recovered') return loaded.manifest
  if (loaded.status === 'missing') return emptyKnowledgeManifest(projectId, nowIso())
  throw new ProjectKnowledgeStoreError(
    'read_failed',
    `manifest 读不了（${loaded.error}）：拒绝在「不知道当前状态」的情况下写入，以免覆盖已有知识`
  )
}

/* ---------------------------------------------------------------- 写入 */

export interface KnowledgeWriteOutcomeSuccess {
  ok: true
  entry: ProjectKnowledge
  manifest: ProjectKnowledgeManifest
  superseded: ProjectKnowledge[]
}

export type KnowledgeWriteOutcome =
  | KnowledgeWriteOutcomeSuccess
  | (KnowledgeFailure & { latest: ProjectKnowledge | null; latestManifest: ProjectKnowledgeManifest | null })

export interface CommitKnowledgeArgs {
  identity: ProjectIdentity
  request: KnowledgeCommitRequest
  /** 宿主侧核实（用户原话 / 证据存在）——模型构造不出来，只有主进程内部能给。 */
  hostCheck?: KnowledgeHostCheck
  opts?: ProjectKnowledgeStoreOptions
}

/**
 * 提交一条知识（新建或更新）。
 *
 * 全程在锁内：读回磁盘上的 manifest 与当前条目 → 纯函数算结果 →
 * 写正文 revision → 原子替换 manifest。任何一步失败都抛错（`write_failed` /
 * `read_failed`），**manifest 保持上一版**。
 *
 * 请求级失败（CAS 冲突、重复、越权置信类……）回 `ok:false + code`，
 * 并把**磁盘上的最新版本**一起交回（`latest` / `latestManifest`）——
 * 调用方据此合并，而不是被静默覆盖。
 */
export async function commitKnowledge(args: CommitKnowledgeArgs): Promise<KnowledgeWriteOutcome> {
  const { identity, request } = args
  const opts = args.opts ?? {}
  const dir = projectMemoryDir(identity.projectId, opts.root)
  await mkdir(dir, { recursive: true })
  const lock = await acquireProjectKnowledgeLock(dir, opts)
  try {
    const manifest = manifestOf(await loadManifest(identity.projectId, opts), identity.projectId)

    const requestedId = typeof request.id === 'string' && isSafeKnowledgeId(request.id) ? request.id : null
    const current = requestedId ? await loadEntry(dir, findKnowledgePointer(manifest, requestedId), true) : null

    const supersedesTargets = new Map<string, ProjectKnowledge>()
    if (Array.isArray(request.supersedes)) {
      for (const id of request.supersedes) {
        if (!isSafeKnowledgeId(id) || supersedesTargets.has(id)) continue
        const entry = await loadEntry(dir, findKnowledgePointer(manifest, id), true)
        if (entry) supersedesTargets.set(id, entry)
      }
    }

    const result = applyKnowledgeCommit(manifest, request, {
      newId: newKnowledgeId(),
      now: nowIso(),
      current,
      digests: digestIndex(manifest),
      supersedesTargets,
      hostCheck: args.hostCheck
    })
    if (!result.ok) {
      return { ...result, latest: current, latestManifest: manifest }
    }

    /* 先写正文（不可变），后写索引。顺序反了会让 manifest 指向不存在的文件。 */
    for (const entry of [...result.superseded, result.entry]) {
      await writeRevisionFile(dir, entry)
    }
    await writeManifestAtomic(dir, result.manifest)
    return { ok: true, entry: result.entry, manifest: result.manifest, superseded: result.superseded }
  } finally {
    await lock.release()
  }
}

export interface DeleteKnowledgeArgs {
  identity: ProjectIdentity
  request: KnowledgeDeleteRequest
  opts?: ProjectKnowledgeStoreOptions
}

export interface KnowledgeDeleteOutcomeSuccess {
  ok: true
  entry: ProjectKnowledge
  manifest: ProjectKnowledgeManifest
  /** 永久删除清掉的旧 revision 文件数（逻辑删除恒为 0）。 */
  purgedRevisions: number
  /** 正文没清干净的提示（墓碑仍然生效，所以这只是一个警告，不是失败）。 */
  purgeWarning?: string
}

export type KnowledgeDeleteOutcome =
  | KnowledgeDeleteOutcomeSuccess
  | (KnowledgeFailure & { latest: ProjectKnowledge | null; latestManifest: ProjectKnowledgeManifest | null })

/**
 * 删除一条知识。
 *
 * 逻辑删除 / 永久删除的判定在纯逻辑层（[applyKnowledgeDelete]），这里只负责：
 *  ① 锁内读到**磁盘上的当前版本**再 CAS；
 *  ② 写墓碑 revision + 原子替换 manifest（删完立刻从可检索集消失）；
 *  ③ 永久删除时清掉旧的正文 revision。
 *
 * 第三步**故意是尽力而为**：manifest 已经提交（墓碑生效），此时若因为
 * 文件被占用没删掉正文，报失败会让用户以为「没删掉」而重试 ——
 * 实际状态是「已删除但磁盘上还有正文」，所以如实回 `purgeWarning`。
 */
export async function deleteKnowledge(args: DeleteKnowledgeArgs): Promise<KnowledgeDeleteOutcome> {
  const { identity, request } = args
  const opts = args.opts ?? {}
  const dir = projectMemoryDir(identity.projectId, opts.root)
  await mkdir(dir, { recursive: true })
  const lock = await acquireProjectKnowledgeLock(dir, opts)
  try {
    const manifest = manifestOf(await loadManifest(identity.projectId, opts), identity.projectId)
    const id = typeof request.id === 'string' && isSafeKnowledgeId(request.id) ? request.id : null
    const current = id ? await loadEntry(dir, findKnowledgePointer(manifest, id), true) : null

    const result = applyKnowledgeDelete(manifest, request, { now: nowIso(), current })
    if (!result.ok) return { ...result, latest: current, latestManifest: manifest }

    await writeRevisionFile(dir, result.entry)
    await writeManifestAtomic(dir, result.manifest)

    let purgedRevisions = 0
    let purgeWarning: string | undefined
    if (result.purgePreviousRevisions) {
      try {
        purgedRevisions = await purgePreviousRevisions(dir, result.entry.id, result.entry.revision)
      } catch (err) {
        purgeWarning = `墓碑已生效，但旧正文没清干净：${describe(err)}`
      }
    }
    return { ok: true, entry: result.entry, manifest: result.manifest, purgedRevisions, ...(purgeWarning ? { purgeWarning } : {}) }
  } finally {
    await lock.release()
  }
}

/** 删掉某个条目除 `keepRevision` 之外的所有 revision 文件。 */
async function purgePreviousRevisions(dir: string, id: string, keepRevision: number): Promise<number> {
  const target = join(entriesDir(dir), id)
  const names = await readdir(target).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!/^r\d+\.json$/.test(name)) continue
    if (Number(name.slice(1, -5)) === keepRevision) continue
    if (await unlink(join(target, name)).then(() => true).catch(() => false)) removed++
  }
  return removed
}

/* ---------------------------------------------------------------- 读取 */

export interface ListKnowledgeOptions extends ProjectKnowledgeStoreOptions {
  /** 默认不含已删除（「立即从可检索集移除」）。 */
  includeDeleted?: boolean
}

/**
 * 列出项目的知识（**当前状态**，按创建时间）。
 *
 * 不含已删除条目是默认行为，也是「删除后立刻不可检索」的实现点。
 * 指针→正文读不出来时不抛错（展示路径宽容），只是这一条不出现 ——
 * 但 manifest 本身读不出来的**必须**抛错（那是整库状态不明，不能显示成空）。
 */
export async function listKnowledge(
  identity: ProjectIdentity,
  opts: ListKnowledgeOptions = {}
): Promise<ProjectKnowledge[]> {
  const dir = projectMemoryDir(identity.projectId, opts.root)
  const loaded = await loadManifest(identity.projectId, opts)
  if (loaded.status === 'unreadable') {
    throw new ProjectKnowledgeStoreError('read_failed', `manifest 读不了：${loaded.error}`)
  }
  if (loaded.status === 'missing') return []

  const out: ProjectKnowledge[] = []
  for (const pointer of loaded.manifest.entries) {
    if (!opts.includeDeleted && pointer.status === 'deleted') continue
    const entry = await loadEntry(dir, pointer, false)
    if (entry) out.push(entry)
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** 读一条（`undefined` = 没有这条 / 指针指不到正文）。 */
export async function readKnowledge(
  identity: ProjectIdentity,
  id: string,
  opts: ProjectKnowledgeStoreOptions = {}
): Promise<ProjectKnowledge | undefined> {
  if (!isSafeKnowledgeId(id)) {
    throw new ProjectKnowledgeStoreError('bad_project_id', `条目 id 非法：${String(id)}`)
  }
  const dir = projectMemoryDir(identity.projectId, opts.root)
  const loaded = await loadManifest(identity.projectId, opts)
  if (loaded.status === 'unreadable') {
    throw new ProjectKnowledgeStoreError('read_failed', `manifest 读不了：${loaded.error}`)
  }
  if (loaded.status === 'missing') return undefined
  return (await loadEntry(dir, findKnowledgePointer(loaded.manifest, id), false)) ?? undefined
}

/** 目录里有哪些条目 id（诊断 / 测试用；顺序不保证，含已删除的墓碑）。 */
export async function listKnowledgeIds(
  identity: ProjectIdentity,
  opts: ProjectKnowledgeStoreOptions = {}
): Promise<string[]> {
  const dir = projectMemoryDir(identity.projectId, opts.root)
  const names = await readdir(entriesDir(dir)).catch(() => [] as string[])
  return names.filter((name) => isSafeKnowledgeId(name)).sort()
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
