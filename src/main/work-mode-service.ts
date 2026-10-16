import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SESSION_QUESTION_FREQUENCY,
  normalizeSessionQuestionFrequency,
  type SessionQuestionFrequency
} from '../shared/question-frequency'
import {
  DEFAULT_WORK_MODE,
  isWorkMode,
  normalizeWorkMode,
  type WorkMode,
  type WorkModeState
} from '../shared/work-mode'
import { YAN_DIR } from './paths'

export const WORK_MODE_FILE_NAME = 'work-modes.json'
export const WORK_MODE_SNAPSHOT_DIRNAME = 'work-mode'
export const WORK_MODE_MAX_ENTRIES = 2000

interface StoredWorkMode {
  mode: WorkMode
  revision: number
  updatedAt: number
  questionFrequency: SessionQuestionFrequency
  owner?: string
}

interface WorkModeDocument {
  version: 1
  entries: Record<string, StoredWorkMode>
}

export function workModeDocumentPath(root: string = YAN_DIR): string {
  return join(root, WORK_MODE_FILE_NAME)
}

export function sanitizeWorkModeKey(key: unknown): string | null {
  if (typeof key !== 'string') return null
  const trimmed = key.trim()
  if (!trimmed || trimmed.length > 400) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

export function normalizeSessionFileKey(file: unknown): string | null {
  if (typeof file !== 'string') return null
  const key = file.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!key) return null
  return sanitizeWorkModeKey(key)
}

export function cleanWorkModeOwner(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith('pending:')) return undefined
  return trimmed.slice(0, 200)
}

export function pendingWorkModeKey(runnerId: string): string {
  return `pending:${runnerId}`
}

export interface WorkModeIdentity {
  id: string
  generation?: number
  sessionId?: string
  sessionFile?: string
}

export function sameWorkModeIdentity(a: WorkModeIdentity | null, b: WorkModeIdentity | null): boolean {
  if (!a || !b) return false
  if (a.id !== b.id) return false
  if ((a.generation ?? 0) !== (b.generation ?? 0)) return false
  if ((a.sessionId ?? '') !== (b.sessionId ?? '')) return false
  return normalizeSessionFileKey(a.sessionFile) === normalizeSessionFileKey(b.sessionFile)
}

export function workModeSnapshotFileName(runtimeKey: string): string {
  const safe = runtimeKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `${safe || 'session'}.json`
}

export function workModeSnapshotPath(runtimeKey: string, root: string = YAN_DIR): string {
  return join(root, WORK_MODE_SNAPSHOT_DIRNAME, workModeSnapshotFileName(runtimeKey))
}

const snapshotWriteTails = new Map<string, Promise<unknown>>()

function withSnapshotWriteLock<T>(runtimeKey: string, job: () => Promise<T>): Promise<T> {
  const previous = snapshotWriteTails.get(runtimeKey) ?? Promise.resolve()
  const run = previous.then(job, job)
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  snapshotWriteTails.set(runtimeKey, tail)
  void tail.then(() => {
    if (snapshotWriteTails.get(runtimeKey) === tail) snapshotWriteTails.delete(runtimeKey)
  })
  return run
}

let snapshotTempSeq = 0
function snapshotTempPath(target: string): string {
  snapshotTempSeq = (snapshotTempSeq + 1) % Number.MAX_SAFE_INTEGER
  const nonce = Math.random().toString(36).slice(2, 8)
  return `${target}.${process.pid}.${snapshotTempSeq}.${nonce}.tmp`
}

function sanitizeEntry(raw: unknown): StoredWorkMode | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<StoredWorkMode>
  if (!isWorkMode(o.mode)) return null
  const revision = Number.isFinite(o.revision) && Number(o.revision) > 0 ? Math.floor(Number(o.revision)) : 1
  const updatedAt = Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : 0
  const owner = cleanWorkModeOwner(o.owner)
  return {
    mode: o.mode,
    revision,
    updatedAt,
    questionFrequency: normalizeSessionQuestionFrequency(o.questionFrequency),
    ...(owner ? { owner } : {})
  }
}

export function sanitizeWorkModeDocument(raw: unknown): WorkModeDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<WorkModeDocument>) : {}
  const rawEntries = source.entries && typeof source.entries === 'object' ? source.entries : {}
  const entries: Record<string, StoredWorkMode> = {}
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    const safe = sanitizeWorkModeKey(key)
    const entry = sanitizeEntry(value)
    if (!safe || !entry) continue
    entries[safe] = entry
  }
  const keys = Object.keys(entries)
  if (keys.length > WORK_MODE_MAX_ENTRIES) {
    const keep = keys
      .sort((a, b) => entries[b].updatedAt - entries[a].updatedAt)
      .slice(0, WORK_MODE_MAX_ENTRIES)
    const trimmed: Record<string, StoredWorkMode> = {}
    for (const key of keep) trimmed[key] = entries[key]
    return { version: 1, entries: trimmed }
  }
  return { version: 1, entries }
}

export function readWorkModeState(
  doc: WorkModeDocument,
  runtimeKey: string,
  fallback: WorkMode = DEFAULT_WORK_MODE
): WorkModeState {
  const entry = doc.entries[runtimeKey]
  if (!entry) {
    return {
      mode: normalizeWorkMode(fallback),
      revision: 0,
      questionFrequency: DEFAULT_SESSION_QUESTION_FREQUENCY
    }
  }
  return {
    mode: entry.mode,
    revision: entry.revision,
    questionFrequency: entry.questionFrequency
  }
}

export interface WorkModeSnapshotOwner {
  sessionId?: string
  sessionFile?: string
}

export async function writeWorkModeSnapshot(
  runtimeKey: string,
  state: WorkModeState & { planApprovalPending?: boolean },
  root: string = YAN_DIR,
  options: { guard?: () => boolean; owner?: WorkModeSnapshotOwner } = {}
): Promise<boolean> {
  const { guard, owner } = options
  return withSnapshotWriteLock(runtimeKey, async () => {
    if (guard && !guard()) return false
    const target = workModeSnapshotPath(runtimeKey, root)
    await mkdir(dirname(target), { recursive: true })
    const record = {
      version: 1,
      runtimeKey,
      mode: state.mode,
      revision: state.revision,
      questionFrequency: normalizeSessionQuestionFrequency(state.questionFrequency),
      ...(owner?.sessionId ? { sessionId: owner.sessionId } : {}),
      ...(owner?.sessionFile ? { sessionFile: owner.sessionFile } : {}),
      planApprovalPending: state.planApprovalPending === true,
      at: new Date().toISOString()
    }
    const body = JSON.stringify(record)
    const temp = snapshotTempPath(target)
    try {
      await writeFile(temp, body, 'utf8')
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    if (guard && !guard()) {
      await rm(temp, { force: true }).catch(() => {})
      return false
    }
    try {
      await rename(temp, target)
    } catch {
      try {
        await writeFile(target, body, 'utf8')
      } finally {
        await rm(temp, { force: true }).catch(() => {})
      }
    }
    return true
  })
}

export async function readWorkModeSnapshot(
  runtimeKey: string,
  root: string = YAN_DIR
): Promise<{
  mode?: WorkMode
  questionFrequency?: SessionQuestionFrequency
  planApprovalPending?: boolean
  sessionId?: string
  sessionFile?: string
} | null> {
  try {
    const raw = JSON.parse(await readFile(workModeSnapshotPath(runtimeKey, root), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const o = raw as Record<string, unknown>
    return {
      mode: isWorkMode(o.mode) ? o.mode : undefined,
      questionFrequency: normalizeSessionQuestionFrequency(o.questionFrequency),
      planApprovalPending: o.planApprovalPending === true,
      sessionId: typeof o.sessionId === 'string' && o.sessionId.trim() ? o.sessionId : undefined,
      sessionFile: typeof o.sessionFile === 'string' && o.sessionFile.trim() ? o.sessionFile : undefined
    }
  } catch {
    return null
  }
}

export interface WorkModeSetResult {
  ok: boolean
  state: WorkModeState
  error?: 'version-mismatch' | 'bad-key'
}

export type QuestionFrequencySetResult = WorkModeSetResult

export class WorkModeStore {
  private readonly root: string
  private readonly now: () => number
  private doc: WorkModeDocument = { version: 1, entries: {} }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: { root?: string; now?: () => number } = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = JSON.parse(await readFile(workModeDocumentPath(this.root), 'utf8'))
      this.doc = sanitizeWorkModeDocument(raw)
    } catch {
      this.doc = { version: 1, entries: {} }
    }
    this.loaded = true
  }

  state(runtimeKey: string, fallback: WorkMode = DEFAULT_WORK_MODE): WorkModeState {
    const key = sanitizeWorkModeKey(runtimeKey)
    if (!key) {
      return { mode: normalizeWorkMode(fallback), revision: 0, questionFrequency: DEFAULT_SESSION_QUESTION_FREQUENCY }
    }
    return readWorkModeState(this.doc, key, fallback)
  }

  async set(
    runtimeKey: string,
    mode: WorkMode,
    expectedRevision?: number,
    owner?: string
  ): Promise<WorkModeSetResult> {
    const key = sanitizeWorkModeKey(runtimeKey)
    if (!key) {
      return {
        ok: false,
        state: { mode: normalizeWorkMode(mode), revision: 0, questionFrequency: DEFAULT_SESSION_QUESTION_FREQUENCY },
        error: 'bad-key'
      }
    }
    return this.enqueue(async () => {
      const current = this.state(key)
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, state: current, error: 'version-mismatch' as const }
      }
      const previous = this.doc.entries[key]
      const nextOwner = cleanWorkModeOwner(owner) ?? previous?.owner
      const next: StoredWorkMode = {
        mode: normalizeWorkMode(mode),
        revision: current.revision + 1,
        updatedAt: this.now(),
        questionFrequency: normalizeSessionQuestionFrequency(current.questionFrequency),
        ...(nextOwner ? { owner: nextOwner } : {})
      }
      this.doc.entries[key] = next
      try {
        await this.persist()
      } catch (error) {
        if (previous) this.doc.entries[key] = previous
        else delete this.doc.entries[key]
        throw error
      }
      return { ok: true, state: { mode: next.mode, revision: next.revision, questionFrequency: next.questionFrequency } }
    })
  }

  async setQuestionFrequency(
    runtimeKey: string,
    preference: unknown,
    expectedRevision?: number,
    owner?: string
  ): Promise<QuestionFrequencySetResult> {
    const key = sanitizeWorkModeKey(runtimeKey)
    const freq = normalizeSessionQuestionFrequency(preference)
    if (!key) {
      return {
        ok: false,
        state: { mode: DEFAULT_WORK_MODE, revision: 0, questionFrequency: freq },
        error: 'bad-key'
      }
    }
    return this.enqueue(async () => {
      const current = this.state(key)
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, state: current, error: 'version-mismatch' as const }
      }
      const previous = this.doc.entries[key]
      if (!previous && freq === DEFAULT_SESSION_QUESTION_FREQUENCY) {
        return {
          ok: true,
          state: { mode: current.mode, revision: current.revision, questionFrequency: freq }
        }
      }
      const nextOwner = cleanWorkModeOwner(owner) ?? previous?.owner
      const next: StoredWorkMode = {
        mode: current.mode,
        revision: current.revision + 1,
        updatedAt: this.now(),
        questionFrequency: freq,
        ...(nextOwner ? { owner: nextOwner } : {})
      }
      this.doc.entries[key] = next
      try {
        await this.persist()
      } catch (error) {
        if (previous) this.doc.entries[key] = previous
        else delete this.doc.entries[key]
        throw error
      }
      return {
        ok: true,
        state: { mode: next.mode, revision: next.revision, questionFrequency: next.questionFrequency }
      }
    })
  }

  async adopt(fromKey: string, toKey: string, options: { requireOwner?: string } = {}): Promise<WorkModeState> {
    const from = sanitizeWorkModeKey(fromKey)
    const to = sanitizeWorkModeKey(toKey)
    if (!to || !from || from === to) return this.state(to ?? from ?? '')
    return this.enqueue(async () => {
      const source = this.doc.entries[from]
      if (options.requireOwner !== undefined && source && source.owner !== options.requireOwner) {
        return this.state(to)
      }
      const existing = this.doc.entries[to]
      if (!existing && source) {
        this.doc.entries[to] = { ...source }
        delete this.doc.entries[from]
        await this.persist()
      } else if (existing && source) {
        delete this.doc.entries[from]
        await this.persist()
      }
      return this.state(to)
    })
  }

  snapshot(): WorkModeDocument {
    return { version: 1, entries: { ...this.doc.entries } }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.catch(() => {})
    return run
  }

  private async persist(): Promise<void> {
    const file = workModeDocumentPath(this.root)
    await mkdir(this.root, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(this.doc, null, 2), 'utf8')
    try {
      await rename(temp, file)
    } catch {
      await writeFile(file, JSON.stringify(this.doc, null, 2), 'utf8')
      await rm(temp, { force: true }).catch(() => {})
    }
  }
}

export async function adoptPendingWorkMode(
  store: WorkModeStore,
  runnerId: string,
  sessionId: string | undefined,
  targetKey: string
): Promise<void> {
  const pendingKey = pendingWorkModeKey(runnerId)
  if (targetKey === pendingKey) return
  const owner = cleanWorkModeOwner(sessionId)
  if (!owner) return
  await store.load()
  await store.adopt(pendingKey, targetKey, { requireOwner: owner })
}

export async function readLegacyAutonomous(root: string = YAN_DIR): Promise<unknown> {
  try {
    const parsed = JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8'))
    return parsed?.autonomous
  } catch {
    return undefined
  }
}
