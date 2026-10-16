import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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

export {
  CONTEXT_STATE_SCHEMA_VERSION,
  CONTEXT_ARCHIVE_SCHEMA_VERSION,
  emptyTaskState
} from '../shared/context-state'

export const CONTEXT_STATE_DIRNAME = 'context-state'

export function contextStateDir(dir?: string): string {
  return dir ?? join(YAN_DIR, CONTEXT_STATE_DIRNAME)
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/

async function quarantineInvalid(path: string): Promise<void> {
  try {
    await rename(path, `${path}.invalid-${Date.now()}-${randomUUID()}`)
  } catch {
  }
}

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

export class ContextStateError extends Error {
  readonly issues: ValidationIssue[]
  constructor(message: string, issues: ValidationIssue[] = []) {
    super(message)
    this.name = 'ContextStateError'
    this.issues = issues
  }
}

let tempSeq = 0

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

const fileOperations = new Map<string, Promise<unknown>>()
function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const previous = fileOperations.get(file) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(work)
  fileOperations.set(file, current)
  return current.finally(() => { if (fileOperations.get(file) === current) fileOperations.delete(file) })
}
function lockKey(sessionId: string, opts: StoreOptions, suffix: string): string {
  return `${contextStateDir(opts.dir)}\\0${sessionId}${suffix}`
}

export type ContextStateLoad =
  | { status: 'ok'; state: ContextStateFile; path: string }
  | { status: 'missing'; path: string }
  | { status: 'discarded'; reason: 'invalid' | 'incompatible'; issues: ValidationIssue[]; path: string }
  | { status: 'unreadable'; error: string; path: string }

export interface StoreOptions {
  dir?: string
  raw?: RawIndex
}

async function loadContextStateUnlocked(sessionId: string, opts: StoreOptions = {}): Promise<ContextStateLoad> {
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
    await quarantineInvalid(path)
    return {
      status: 'discarded',
      reason: 'invalid',
      issues: [{ path: '', code: 'not-object', message: `JSON 解析失败：${errorText(error)}` }],
      path
    }
  }

  const inspected = inspectContextStateFile(parsed, opts.raw ?? {})
  if (inspected.status === 'ok') {
    if (inspected.state.sessionId !== sessionId) {
      await quarantineInvalid(path)
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

  await quarantineInvalid(path)
  return {
    status: 'discarded',
    reason: inspected.status,
    issues: inspected.issues,
    path
  }
}

async function saveContextStateUnlocked(state: ContextStateFile, opts: StoreOptions = {}): Promise<void> {
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

export function loadContextState(sessionId: string, opts: StoreOptions = {}): Promise<ContextStateLoad> {
  return withFileLock(lockKey(sessionId, opts, ''), () => loadContextStateUnlocked(sessionId, opts))
}
export function saveContextState(state: ContextStateFile, opts: StoreOptions = {}): Promise<void> {
  return withFileLock(lockKey(state.sessionId, opts, ''), () => saveContextStateUnlocked(state, opts))
}

export type ArchiveLoad =
  | { status: 'ok'; archive: ArchiveFile; path: string }
  | { status: 'missing'; path: string }
  | { status: 'discarded'; reason: 'invalid' | 'incompatible'; issues: ValidationIssue[]; path: string }
  | { status: 'unreadable'; error: string; path: string }

async function loadArchiveUnlocked(sessionId: string, opts: StoreOptions = {}): Promise<ArchiveLoad> {
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
    await quarantineInvalid(path)
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
      await quarantineInvalid(path)
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

  await quarantineInvalid(path)
  return { status: 'discarded', reason: inspected.status, issues: inspected.issues, path }
}

async function saveArchiveUnlocked(archive: ArchiveFile, opts: StoreOptions = {}): Promise<void> {
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

export function loadArchive(sessionId: string, opts: StoreOptions = {}): Promise<ArchiveLoad> {
  return withFileLock(lockKey(sessionId, opts, ''), () => loadArchiveUnlocked(sessionId, opts))
}
export function saveArchive(archive: ArchiveFile, opts: StoreOptions = {}): Promise<void> {
  return withFileLock(lockKey(archive.sessionId, opts, ''), () => saveArchiveUnlocked(archive, opts))
}

async function deleteContextStatesUnlocked(sessionIds: readonly string[], opts: StoreOptions = {}): Promise<number> {
  const dir = contextStateDir(opts.dir)
  let removed = 0
  for (const sessionId of sessionIds) {
    if (!isSafeSessionId(sessionId)) continue
    const targets = [
      join(dir, `${sessionId}.json`),
      join(dir, `${sessionId}.archive.json`),
      join(dir, `${sessionId}.recall.json`),
      join(dir, `${sessionId}.recall.jsonl`)
    ]
    for (const target of targets) {
      if (await unlink(target).then(() => true).catch(() => false)) removed++
    }
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

export async function deleteContextStates(sessionIds: readonly string[], opts: StoreOptions = {}): Promise<number> {
  let removed = 0
  for (const id of [...new Set(sessionIds)].sort()) {
    if (!isSafeSessionId(id)) continue
    removed += await withFileLock(lockKey(id, opts, ''), () => deleteContextStatesUnlocked([id], opts))
  }
  return removed
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
