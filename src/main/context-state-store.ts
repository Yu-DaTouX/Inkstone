/**
 * 上下文状态的落盘层（N21-4 / S1）。
 *
 * 位置：`YAN_DATA_DIR/context-state/<sessionId>.json`（方案 §13.5 第 3 点定的位置）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条必须守住的性质
 * ══════════════════════════════════════════════════════════════════
 * **① 派生物，丢了不心疼。**
 *   这里的东西全部可以从原始 session 重建（`src/shared/context-state.ts`
 *   的硬约束 ①）。所以「损坏 / 版本不认识 / 水位对不上」的正确处置是
 *   **安全丢弃**：删掉文件、返回原因、退回 pi 原生行为 ——
 *   而不是尽力解析半份状态喂给模型，也不是让读失败把主链路拖挂。
 *
 * **② 写入要么整份生效，要么一份都别动。**
 *   原子写：临时文件 → 回读校验 → `rename`。校验不通过时**绝不 rename**，
 *   上一份好的状态（last-known-good）原样保留。理由很实际：
 *   状态是给模型看的，半份/错误状态比没有状态危险得多（§12.0 的降级路径）。
 *
 * **③ 只有原始 session 是 source of truth。**
 *   这里不复制消息正文、不存历史；`ArchiveEntry.contentStored` 在 S1 恒为
 *   false（只有元数据）。删除会话时清掉派生状态，原始 JSONL 不受影响。
 *
 * ══════════════════════════════════════════════════════════════════
 * 本切片不做的事
 * ══════════════════════════════════════════════════════════════════
 * 不生成状态（谁生成由后续切片定：主进程或扩展提案都可以调这里的写入）、
 * 不读状态去改发给模型的消息、不调用模型。
 * `dir` 参数是为了让测试与 live 场景把文件写到隔离目录 —— 生产调用不传。
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  inspectArchiveFile,
  inspectContextStateFile,
  type ArchiveFile,
  type ContextStateFile,
  type RawIndex,
  type ValidationIssue
} from '../shared/context-state'
import { YAN_DIR } from './paths'

/**
 * 主进程侧调用者需要的 schema 构造器与版本号：从 store 再导出一次，
 * 免得调用方/脚本为了一个 `emptyTaskState` 去知道 shared 层的文件布局。
 * 校验与类型仍以 `shared/context-state.ts` 为唯一真源。
 */
export {
  CONTEXT_STATE_SCHEMA_VERSION,
  CONTEXT_ARCHIVE_SCHEMA_VERSION,
  emptyTaskState
} from '../shared/context-state'

export const CONTEXT_STATE_DIRNAME = 'context-state'

/** 派生状态目录（`dir` 覆盖只给测试 / 隔离场景用） */
export function contextStateDir(dir?: string): string {
  return dir ?? join(YAN_DIR, CONTEXT_STATE_DIRNAME)
}

/**
 * 会话 id 直接进文件名，所以必须先挡住路径穿越。
 *
 * 真实 pi 会话 id 是 `randomUUID().slice(0,8)`（8 位十六进制），
 * 这里放宽到 `[A-Za-z0-9._-]` 以免以后上游换 id 形状时误伤，
 * 但仍然排除分隔符与 `.` / `..`。
 */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/

export function isSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) && sessionId !== '.' && sessionId !== '..'
}

export function contextStatePath(sessionId: string, dir?: string): string {
  assertSafeSessionId(sessionId)
  return join(contextStateDir(dir), `${sessionId}.json`)
}

export function contextArchivePath(sessionId: string, dir?: string): string {
  assertSafeSessionId(sessionId)
  return join(contextStateDir(dir), `${sessionId}.archive.json`)
}

function assertSafeSessionId(sessionId: unknown): asserts sessionId is string {
  if (!isSafeSessionId(sessionId)) {
    throw new ContextStateError(`不安全的会话 id：${String(sessionId)}`, [])
  }
}

/** 状态层错误的统一形状：带上校验明细，调用方不必猜为什么失败 */
export class ContextStateError extends Error {
  readonly issues: ValidationIssue[]
  constructor(message: string, issues: ValidationIssue[] = []) {
    super(message)
    this.name = 'ContextStateError'
    this.issues = issues
  }
}

/* ---------------------------------------------------------------- 原子写 */

/** 临时文件序号：同一进程内多次写同一目标也不会撞名 */
let tempSeq = 0

/**
 * 原子写 JSON：临时文件 → 回读 + 校验 → rename。
 *
 * 为什么回读而不是「写完就当对」：写盘可能被截断（磁盘满、进程被杀、
 * 杀毒软件锁文件），而状态文件一旦半份就会污染推理。回读一次的成本
 * 与「让模型带着半份状态跑一轮」比可以忽略。
 * 为什么不用 fsync：这是派生物，断电丢一份可以重建；不值得为它付
 * 每次写入的 fsync 代价（Windows 上尤其明显）。
 */
async function writeJsonAtomic(
  target: string,
  value: unknown,
  verify: (parsed: unknown) => { ok: true } | { ok: false; issues: ValidationIssue[] }
): Promise<void> {
  const dir = dirname(target)
  await mkdir(dir, { recursive: true })
  const temp = `${target}.${process.pid}.${++tempSeq}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(temp, 'utf8'))
    } catch (error) {
      throw new ContextStateError(
        `临时状态文件回读失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
    const checked = verify(parsed)
    if (!checked.ok) throw new ContextStateError('状态校验未通过，已放弃写入（保留上一份）', checked.issues)
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/* ---------------------------------------------------------------- 状态读写 */

export type ContextStateLoad =
  | { status: 'ok'; state: ContextStateFile; path: string }
  | { status: 'missing'; path: string }
  /** 内容非法或版本不认识 —— 文件已被丢弃，调用方按「没有状态」处理 */
  | { status: 'discarded'; reason: 'invalid' | 'incompatible'; issues: ValidationIssue[]; path: string }
  /** 读不了（权限 / IO）—— 不丢弃，也不假装没有 */
  | { status: 'unreadable'; error: string; path: string }

export interface StoreOptions {
  /** 隔离目录（测试 / live 场景用）；生产不传 = `YAN_DATA_DIR/context-state` */
  dir?: string
  /** 原始条目索引；给了就能把「指向不存在/已裁剪条目」的状态判为非法 */
  raw?: RawIndex
}

/**
 * 读一份状态。
 *
 * `status: 'discarded'` 表示文件**已经被删掉**（损坏 / 版本不认识 /
 * 引用不存在的原始条目）。这是有意的破坏性修复：与其让下一轮再读到
 * 同一份坏状态，不如当场清掉，下一轮由生成侧重建。
 */
export async function loadContextState(sessionId: string, opts: StoreOptions = {}): Promise<ContextStateLoad> {
  const path = contextStatePath(sessionId, opts.dir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return { status: 'missing', path }
    return { status: 'unreadable', error: errorText(error), path }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    await unlink(path).catch(() => undefined)
    return {
      status: 'discarded',
      reason: 'invalid',
      issues: [{ path: '', code: 'not-object', message: `JSON 解析失败：${errorText(error)}` }],
      path
    }
  }

  const inspected = inspectContextStateFile(parsed, opts.raw ?? {})
  if (inspected.status === 'ok') {
    /* 文件里的 sessionId 必须就是我们要读的那一个 —— 防止文件名与内容对不上 */
    if (inspected.state.sessionId !== sessionId) {
      await unlink(path).catch(() => undefined)
      return {
        status: 'discarded',
        reason: 'invalid',
        issues: [
          {
            path: 'sessionId',
            code: 'type',
            message: `文件里的 sessionId（${inspected.state.sessionId}）与文件名（${sessionId}）不一致`
          }
        ],
        path
      }
    }
    return { status: 'ok', state: inspected.state, path }
  }

  await unlink(path).catch(() => undefined)
  return {
    status: 'discarded',
    reason: inspected.status,
    issues: inspected.issues,
    path
  }
}

/**
 * 保存一份状态。校验不通过时抛 `ContextStateError`，**不动**已有文件。
 *
 * 调用方应当传入 `raw`（原始条目索引）—— 没有它就只能做形状校验，
 * 无法发现「状态指向的 entry 已经不在原始会话里」。
 */
export async function saveContextState(state: ContextStateFile, opts: StoreOptions = {}): Promise<void> {
  assertSafeSessionId(state?.sessionId)
  const inspected = inspectContextStateFile(state, opts.raw ?? {})
  if (inspected.status !== 'ok') {
    throw new ContextStateError(`状态未通过校验（${inspected.status}），未写入`, inspected.issues)
  }
  await writeJsonAtomic(contextStatePath(state.sessionId, opts.dir), state, (parsed) => {
    const check = inspectContextStateFile(parsed, opts.raw ?? {})
    return check.status === 'ok' ? { ok: true } : { ok: false, issues: check.issues }
  })
}

/* ---------------------------------------------------------------- 归档读写 */

export type ArchiveLoad =
  | { status: 'ok'; archive: ArchiveFile; path: string }
  | { status: 'missing'; path: string }
  | { status: 'discarded'; reason: 'invalid' | 'incompatible'; issues: ValidationIssue[]; path: string }
  | { status: 'unreadable'; error: string; path: string }

export async function loadArchive(sessionId: string, opts: StoreOptions = {}): Promise<ArchiveLoad> {
  const path = contextArchivePath(sessionId, opts.dir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return { status: 'missing', path }
    return { status: 'unreadable', error: errorText(error), path }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    await unlink(path).catch(() => undefined)
    return {
      status: 'discarded',
      reason: 'invalid',
      issues: [{ path: '', code: 'not-object', message: `JSON 解析失败：${errorText(error)}` }],
      path
    }
  }

  const inspected = inspectArchiveFile(parsed, opts.raw ?? {})
  if (inspected.status === 'ok') {
    if (inspected.archive.sessionId !== sessionId) {
      await unlink(path).catch(() => undefined)
      return {
        status: 'discarded',
        reason: 'invalid',
        issues: [
          {
            path: 'sessionId',
            code: 'type',
            message: `文件里的 sessionId（${inspected.archive.sessionId}）与文件名（${sessionId}）不一致`
          }
        ],
        path
      }
    }
    return { status: 'ok', archive: inspected.archive, path }
  }

  await unlink(path).catch(() => undefined)
  return { status: 'discarded', reason: inspected.status, issues: inspected.issues, path }
}

export async function saveArchive(archive: ArchiveFile, opts: StoreOptions = {}): Promise<void> {
  assertSafeSessionId(archive?.sessionId)
  const inspected = inspectArchiveFile(archive, opts.raw ?? {})
  if (inspected.status !== 'ok') {
    throw new ContextStateError(`归档未通过校验（${inspected.status}），未写入`, inspected.issues)
  }
  await writeJsonAtomic(contextArchivePath(archive.sessionId, opts.dir), archive, (parsed) => {
    const check = inspectArchiveFile(parsed, opts.raw ?? {})
    return check.status === 'ok' ? { ok: true } : { ok: false, issues: check.issues }
  })
}

/* ---------------------------------------------------------------- 清理 */

/**
 * 删除一个会话的派生状态（状态 + 归档 + 可能残留的临时文件）。
 *
 * 用途：会话被删除时清理（`main/sessions.ts` 的 `deleteSession`）。
 * 删错了也不致命 —— 这些都是可重建的派生物，原始 JSONL 才是历史。
 * 返回是否真的删掉了东西。
 */
export async function deleteContextStates(sessionIds: readonly string[], opts: StoreOptions = {}): Promise<number> {
  const dir = contextStateDir(opts.dir)
  let removed = 0
  for (const sessionId of sessionIds) {
    if (!isSafeSessionId(sessionId)) continue
    const targets = [
      join(dir, `${sessionId}.json`),
      join(dir, `${sessionId}.archive.json`),
      /* N21-4 / S5 的召回账本与审计（扩展写的，同样按 sessionId 命名） */
      join(dir, `${sessionId}.recall.json`),
      join(dir, `${sessionId}.recall.jsonl`)
    ]
    for (const target of targets) {
      if (await unlink(target).then(() => true).catch(() => false)) removed++
    }
    /* 崩溃留下的临时文件也一并收掉，避免用户数据目录里攒垃圾 */
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (
        !name.startsWith(`${sessionId}.json.`) &&
        !name.startsWith(`${sessionId}.archive.json.`) &&
        !name.startsWith(`${sessionId}.recall.json.`)
      ) {
        continue
      }
      if (!name.endsWith('.tmp')) continue
      if (await unlink(join(dir, name)).then(() => true).catch(() => false)) removed++
    }
  }
  return removed
}

/** 目录里有哪些会话带了派生状态（诊断 / 测试用；顺序不保证） */
export async function listContextStateSessionIds(opts: StoreOptions = {}): Promise<string[]> {
  const dir = contextStateDir(opts.dir)
  const names = await readdir(dir).catch(() => [] as string[])
  const ids = new Set<string>()
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
    const id = name.endsWith('.archive.json')
      ? name.slice(0, -'.archive.json'.length)
      : name.endsWith('.recall.json')
        ? name.slice(0, -'.recall.json'.length)
        : name.slice(0, -'.json'.length)
    if (isSafeSessionId(id)) ids.add(id)
  }
  return [...ids]
}

/* ---------------------------------------------------------------- 小工具 */

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
