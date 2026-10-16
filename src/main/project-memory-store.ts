import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
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

export const DEFAULT_LOCK_TTL_MS = 30_000
export const DEFAULT_LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 25
const UNPARSABLE_LOCK_GRACE_MS = 5_000
const FOREIGN_STALE_GRACE_MS = 10 * 60_000

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
  root?: string
  lockWaitMs?: number
  lockTtlMs?: number
}

export function projectMemoryRoot(root?: string): string {
  return root ?? PROJECT_KNOWLEDGE_ROOT
}

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

function newKnowledgeId(): string {
  return `k-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

async function writeFileDurable(path: string, text: string): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirBestEffort(dir: string): Promise<void> {
  const handle = await open(dir, 'r').catch(() => null)
  if (!handle) return
  try {
    await handle.sync()
  } catch {
  } finally {
    await handle.close()
  }
}

function serializeManifest(manifest: ProjectKnowledgeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

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

export interface LockRecord {
  pid: number
  host: string
  at: string
  expiresAt: string
  token: string
}

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
  }
  return { record: null, ageMs: Date.now() - mtime, missing: false }
}

function canReclaim(held: LockRead, host: string): boolean {
  if (held.missing) return false
  if (!held.record) return held.ageMs > UNPARSABLE_LOCK_GRACE_MS
  if (held.record.host !== host) {
    const expiresAt = Date.parse(held.record.expiresAt)
    return Number.isFinite(expiresAt) && Date.now() > expiresAt + FOREIGN_STALE_GRACE_MS
  }
  const staleFor = Date.now() - Date.parse(held.record.at)
  return !isProcessAlive(held.record.pid) && Number.isFinite(staleFor) && staleFor > DEFAULT_LOCK_TTL_MS * 2
}

function describeHolder(held: { record: LockRecord | null }): string {
  if (!held.record) return '锁文件认不出（可能是另一个进程刚创建）'
  return `pid=${held.record.pid} host=${held.record.host} at=${held.record.at}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
      await sweepTempFiles(dir)
      return {
        release: async () => {
          const held = await readLockRecord(path)
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
    if (held.missing) continue
    if (canReclaim(held, host)) {
      const quarantine = `${path}.reap-${randomUUID()}`
      if (await rename(path, quarantine).then(() => true).catch(() => false)) {
        const moved = await readLockRecord(quarantine)
        if (moved.record?.token === held.record?.token || (!moved.record && !held.record && moved.ageMs >= UNPARSABLE_LOCK_GRACE_MS)) {
          await unlink(quarantine).catch(() => undefined)
          continue
        }
        const restored = await link(quarantine, path).then(() => true).catch(() => false)
        if (restored) await unlink(quarantine).catch(() => undefined)
      }
    }
    if (Date.now() >= deadline) {
      throw new ProjectKnowledgeStoreError('locked', `项目知识目录正被占用：${describeHolder(held)}`)
    }
    await sleep(LOCK_RETRY_MS)
  }
}

export type ManifestLoad =
  | { status: 'ok'; manifest: ProjectKnowledgeManifest; path: string }
  | { status: 'recovered'; manifest: ProjectKnowledgeManifest; path: string; reason: 'backup' | 'rebuild'; omitted?: string[] }
  | { status: 'missing'; path: string }
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
  if (inspected.manifest.projectId !== projectId) {
    return { status: 'invalid', reason: `projectId 与目录不符（文件里是 ${inspected.manifest.projectId}）` }
  }
  return { status: 'ok', manifest: inspected.manifest }
}

async function rebuildManifest(
  projectId: string,
  dir: string
): Promise<{ manifest: ProjectKnowledgeManifest; omitted: string[] } | undefined> {
  const ids = await readdir(entriesDir(dir)).catch(() => [] as string[])
  const pointers: KnowledgePointer[] = []
  const omitted: string[] = []
  let revisionSum = 0
  for (const id of ids) {
    if (!isSafeKnowledgeId(id)) continue
    const files = (await readdir(join(entriesDir(dir), id)).catch(() => [] as string[]))
      .filter((name) => /^r\d+\.json$/.test(name))
      .sort((a, b) => Number(b.slice(1, -5)) - Number(a.slice(1, -5)))
    let recovered = false
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
        recovered = true
        break
      }
    }
    if (!recovered) omitted.push(id)
  }
  if (pointers.length === 0) return undefined
  pointers.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return {
    manifest: {
      schemaVersion: PROJECT_KNOWLEDGE_SCHEMA_VERSION,
      projectId,
      revision: revisionSum,
      updatedAt: nowIso(),
      entries: pointers
    },
    omitted
  }
}

export async function loadManifest(
  projectId: string,
  opts: ProjectKnowledgeStoreOptions = {}
): Promise<ManifestLoad> {
  const dir = projectMemoryDir(projectId, opts.root)
  const path = manifestPath(dir)
  const main = await readManifestFile(path, projectId)
  if (main.status === 'ok') return { status: 'ok', manifest: main.manifest, path }
  if (main.status === 'unreadable') {
    return { status: 'unreadable', path, error: main.error }
  }

  const backup = await readManifestFile(manifestBackupPath(dir), projectId)
  if (backup.status === 'ok') {
    await writeManifestAtomic(dir, backup.manifest, false)
    return { status: 'recovered', manifest: backup.manifest, path, reason: 'backup' }
  }

  const rebuilt = await rebuildManifest(projectId, dir)
  if (rebuilt) {
    await writeManifestAtomic(dir, rebuilt.manifest, false)
    return { status: 'recovered', manifest: rebuilt.manifest, path, reason: 'rebuild', ...(rebuilt.omitted.length ? { omitted: rebuilt.omitted } : {}) }
  }

  if (main.status === 'invalid' || backup.status === 'invalid' || backup.status === 'unreadable') {
    return {
      status: 'unreadable',
      path,
      error: main.status === 'invalid' ? main.reason : backup.status === 'unreadable' ? backup.error : '备份也坏了'
    }
  }
  return { status: 'missing', path }
}

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
  hostCheck?: KnowledgeHostCheck
  opts?: ProjectKnowledgeStoreOptions
}

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
  purgedRevisions: number
  purgeWarning?: string
}

export type KnowledgeDeleteOutcome =
  | KnowledgeDeleteOutcomeSuccess
  | (KnowledgeFailure & { latest: ProjectKnowledge | null; latestManifest: ProjectKnowledgeManifest | null })

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

export interface ListKnowledgeOptions extends ProjectKnowledgeStoreOptions {
  includeDeleted?: boolean
}

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
