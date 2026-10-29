import { parsePersistedDocument } from './persisted-document'
import { readFile, mkdir, writeFile, rename, copyFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  ProjectRecord,
  SessionLayoutDocument,
  SessionLayoutEntry,
  SessionMoveRecord,
  SessionScope,
  SessionSummary
} from '../shared/ipc'
import { YAN_DIR } from './paths'
import { normalizeLayoutPath } from '../shared/session-path'

export { normalizeLayoutPath }

export const SESSION_LAYOUT_FILE = join(YAN_DIR, 'session-layout.json')
const MAX_ENTRIES = 2000
const MAX_HISTORY = 20

export interface RememberSessionInput {
  sessionId: string
  sessionFile?: string
  cwd: string
  projectId?: string
  scope?: SessionScope
  opened?: boolean
  archived?: boolean
  pinned?: boolean
  snoozedUntil?: number | null
  markedUnread?: boolean
}

export interface MoveSessionInput {
  sessionId: string
  sessionFile?: string
  cwd: string
}

let cached: SessionLayoutDocument | null = null
let writeTail: Promise<void> = Promise.resolve()

function now(): number {
  return Date.now()
}

function scopeFor(projectId: string | undefined, scope: SessionScope | undefined): SessionScope {
  if (scope === 'pending') return 'pending'
  if (scope === 'project' && projectId) return 'project'
  return projectId ? 'project' : 'global'
}

function sanitizeMove(item: unknown): SessionMoveRecord | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Partial<SessionMoveRecord>
  if (!Number.isFinite(o.at)) return null
  const fromScope = o.fromScope === 'project' || o.fromScope === 'pending' ? o.fromScope : 'global'
  const toScope = o.toScope === 'project' || o.toScope === 'pending' ? o.toScope : 'global'
  return {
    at: Number(o.at),
    ...(typeof o.fromProjectId === 'string' && o.fromProjectId ? { fromProjectId: o.fromProjectId.slice(0, 80) } : {}),
    ...(typeof o.toProjectId === 'string' && o.toProjectId ? { toProjectId: o.toProjectId.slice(0, 80) } : {}),
    fromScope,
    toScope
  }
}

function sanitizeEntry(item: unknown): SessionLayoutEntry | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Partial<SessionLayoutEntry>
  if (typeof o.sessionId !== 'string' || !o.sessionId.trim() || typeof o.cwd !== 'string') return null
  const rawCandidates = Array.isArray(o.projectCandidates) ? o.projectCandidates : []
  const candidates = [...new Set(rawCandidates.filter((x): x is string => typeof x === 'string' && !!x.trim()))]
    .map((x) => x.slice(0, 80))
    .slice(0, 20)
  const projectId = typeof o.projectId === 'string' && o.projectId.trim() ? o.projectId.slice(0, 80) : undefined
  const scope: SessionScope = o.scope === 'project' || o.scope === 'pending' ? o.scope : 'global'
  const createdAt = Number.isFinite(o.createdAt) ? Number(o.createdAt) : now()
  const updatedAt = Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : createdAt
  const moveHistory = (Array.isArray(o.moveHistory) ? o.moveHistory : [])
    .map(sanitizeMove)
    .filter((x): x is SessionMoveRecord => x !== null)
    .slice(-MAX_HISTORY)
  return {
    sessionId: o.sessionId.trim().slice(0, 200),
    ...(typeof o.sessionFile === 'string' && o.sessionFile ? { sessionFile: o.sessionFile } : {}),
    cwd: o.cwd,
    scope,
    ...(projectId ? { projectId } : {}),
    ...(candidates.length ? { projectCandidates: candidates } : {}),
    createdAt,
    updatedAt,
    ...(Number.isFinite(o.lastOpenedAt) ? { lastOpenedAt: Number(o.lastOpenedAt) } : {}),
    ...(Number.isFinite(o.archivedAt) && Number(o.archivedAt) > 0 ? { archivedAt: Number(o.archivedAt) } : {}),
    ...(o.pinned === true ? { pinned: true } : {}),
    ...(Number.isFinite(o.snoozedUntil) && Number(o.snoozedUntil) > 0 ? { snoozedUntil: Number(o.snoozedUntil) } : {}),
    ...(o.markedUnread === true ? { markedUnread: true } : {}),
    moveHistory
  }
}

function sanitizeDocument(value: unknown): SessionLayoutDocument {
  const raw = value && typeof value === 'object' ? (value as Partial<SessionLayoutDocument>) : {}
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map(sanitizeEntry)
    .filter((x): x is SessionLayoutEntry => x !== null)
  const unique = new Map<string, SessionLayoutEntry>()
  for (const entry of entries) unique.set(entry.sessionId, entry)
  return { version: 1, entries: keepWithinLimit([...unique.values()]) }
}

function lastActivity(entry: SessionLayoutEntry): number {
  return Math.max(entry.updatedAt, entry.lastOpenedAt ?? 0, entry.archivedAt ?? 0)
}

function carriesUserState(entry: SessionLayoutEntry): boolean {
  return !!entry.archivedAt || !!entry.pinned || !!entry.snoozedUntil || !!entry.markedUnread || !!entry.projectId || entry.scope === 'pending'
}

function keepWithinLimit(entries: SessionLayoutEntry[]): SessionLayoutEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries
  const dropOrder = [...entries].sort((a, b) => Number(carriesUserState(a)) - Number(carriesUserState(b)) || lastActivity(a) - lastActivity(b))
  const dropped = new Set(dropOrder.slice(0, entries.length - MAX_ENTRIES))
  return entries.filter((entry) => !dropped.has(entry))
}

async function readFromDisk(): Promise<SessionLayoutDocument> {
  if (cached) return cached
  try {
    cached = sanitizeDocument(parsePersistedDocument(await readFile(SESSION_LAYOUT_FILE, 'utf8'), { entries: 'array' }))
    return cached
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      cached = { version: 1, entries: [] }
      return cached
    }
    if (error instanceof SyntaxError) {
      const backedUp = await copyFile(SESSION_LAYOUT_FILE, `${SESSION_LAYOUT_FILE}.corrupt-${Date.now()}-${randomUUID()}`).then(() => true, () => false)
      if (backedUp) {
        cached = { version: 1, entries: [] }
        return cached
      }
    }
    throw error
  }
}

async function persist(document: SessionLayoutDocument): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  const temp = `${SESSION_LAYOUT_FILE}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(document, null, 2), 'utf8')
    await rename(temp, SESSION_LAYOUT_FILE)
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(temp, { force: true })).catch(() => undefined)
    throw error
  }
}

async function update(mutator: (document: SessionLayoutDocument) => SessionLayoutDocument): Promise<SessionLayoutDocument> {
  const task = writeTail.then(async () => {
    const current = sanitizeDocument(await readFromDisk())
    const rawNext = mutator(current)
    const next = rawNext === current ? current : sanitizeDocument(rawNext)
    if (next !== current) await persist(next)
    cached = next
    return next
  })
  writeTail = task.then(() => undefined, () => undefined)
  return task
}

function cloneDocument(document: SessionLayoutDocument): SessionLayoutDocument {
  return JSON.parse(JSON.stringify(document)) as SessionLayoutDocument
}

export async function getSessionLayout(): Promise<SessionLayoutDocument> {
  return cloneDocument(await readFromDisk())
}

function findEntryIndex(entries: SessionLayoutEntry[], sessionId: string, sessionFile?: string): number {
  const byId = entries.findIndex((entry) => entry.sessionId === sessionId)
  if (byId >= 0) return byId
  if (!sessionFile) return -1
  return entries.findIndex(
    (entry) => entry.sessionFile && normalizeLayoutPath(entry.sessionFile) === normalizeLayoutPath(sessionFile)
  )
}

function projectCandidates(cwd: string, projects: ProjectRecord[]): ProjectRecord[] {
  const normalized = normalizeLayoutPath(cwd)
  return projects.filter((project) => normalizeLayoutPath(project.cwd) === normalized)
}

function migratedEntry(summary: SessionSummary, projects: ProjectRecord[], at: number): SessionLayoutEntry {
  const candidates = projectCandidates(summary.cwd, projects)
  const projectId = candidates.length === 1 ? candidates[0].id : undefined
  const scope: SessionScope = candidates.length > 1 ? 'pending' : projectId ? 'project' : 'global'
  return {
    sessionId: summary.id,
    sessionFile: summary.path,
    cwd: summary.cwd,
    scope,
    ...(projectId ? { projectId } : {}),
    ...(candidates.length > 1 ? { projectCandidates: candidates.map((x) => x.id) } : {}),
    createdAt: summary.createdAt || at,
    updatedAt: at,
    moveHistory: []
  }
}

export async function decorateSessions(
  summaries: SessionSummary[],
  projects: ProjectRecord[]
): Promise<SessionSummary[]> {
  if (!summaries.length) return summaries
  let projected: SessionSummary[] = summaries
  await update((document) => {
    let changed = false
    const entries = [...document.entries]
    const at = now()
    projected = summaries.map((summary) => {
      const index = findEntryIndex(entries, summary.id, summary.path)
      let entry = index >= 0 ? entries[index] : undefined
      if (!entry) {
        entry = migratedEntry(summary, projects, at)
        entries.push(entry)
        changed = true
      } else {
        const migratedId = entry.sessionId !== summary.id
        const nextFile = summary.path
        if (migratedId || entry.sessionFile !== nextFile || entry.cwd !== summary.cwd) {
          entry = { ...entry, sessionId: summary.id, sessionFile: nextFile, cwd: summary.cwd, updatedAt: at }
          entries[index] = entry
          changed = true
        }
      }
      return {
        ...summary,
        ...(entry.projectId ? { projectId: entry.projectId } : {}),
        scope: entry.scope,
        ...(entry.lastOpenedAt ? { lastOpenedAt: entry.lastOpenedAt } : {}),
        ...(entry.archivedAt ? { archivedAt: entry.archivedAt } : {}),
        ...(entry.pinned ? { pinned: true } : {}),
        ...(entry.snoozedUntil ? { snoozedUntil: entry.snoozedUntil } : {}),
        ...(entry.markedUnread ? { markedUnread: true } : {}),
        ...(entry.projectCandidates?.length ? { projectCandidates: entry.projectCandidates } : {})
      }
    })
    return changed ? { version: 1, entries } : document
  }).catch(() => undefined)
  return projected
}

export async function rememberSession(input: RememberSessionInput): Promise<SessionLayoutEntry> {
  if (!input.sessionId.trim()) throw new Error('缺少 sessionId')
  const result = await update((document) => {
    const entries = [...document.entries]
    const index = entries.findIndex((entry) => entry.sessionId === input.sessionId)
    const previous = index >= 0 ? entries[index] : undefined
    const nextScope = scopeFor(input.projectId, input.scope)
    const at = now()
    const history = previous?.moveHistory ? [...previous.moveHistory] : []
    const archivedAt = input.archived === undefined ? previous?.archivedAt : input.archived ? previous?.archivedAt ?? at : undefined
    const pinned = input.pinned === undefined ? previous?.pinned : input.pinned
    const snoozedUntil = input.snoozedUntil === undefined ? previous?.snoozedUntil : input.snoozedUntil ?? undefined
    const markedUnread = input.markedUnread === undefined ? previous?.markedUnread : input.markedUnread ? true : undefined
    if (previous && (previous.projectId !== input.projectId || previous.scope !== nextScope)) {
      history.push({
        at,
        ...(previous.projectId ? { fromProjectId: previous.projectId } : {}),
        ...(input.projectId ? { toProjectId: input.projectId } : {}),
        fromScope: previous.scope,
        toScope: nextScope
      })
    }
    const next: SessionLayoutEntry = {
      sessionId: input.sessionId,
      ...(input.sessionFile || previous?.sessionFile ? { sessionFile: input.sessionFile ?? previous?.sessionFile } : {}),
      cwd: input.cwd || previous?.cwd || '',
      scope: nextScope,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(nextScope === 'pending' && previous?.projectCandidates?.length
        ? { projectCandidates: previous.projectCandidates }
        : {}),
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
      ...(input.opened === false ? { lastOpenedAt: previous?.lastOpenedAt } : { lastOpenedAt: at }),
      ...(archivedAt ? { archivedAt } : {}),
      ...(pinned ? { pinned: true } : {}),
      ...(snoozedUntil ? { snoozedUntil } : {}),
      ...(markedUnread ? { markedUnread: true } : {}),
      moveHistory: history.slice(-MAX_HISTORY)
    }
    if (index >= 0) entries[index] = next
    else entries.push(next)
    return { version: 1, entries }
  })
  const entry = result.entries.find((item) => item.sessionId === input.sessionId)
  if (!entry) throw new Error('保存会话归属失败')
  return entry
}

export async function moveSessionLayout(input: MoveSessionInput, projectId: string | null): Promise<SessionLayoutEntry> {
  return rememberSession({
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    cwd: input.cwd,
    ...(projectId ? { projectId, scope: 'project' } : { scope: 'global' }),
    opened: false
  })
}


export async function setSessionFlags(
  input: MoveSessionInput,
  flags: { archived?: boolean; pinned?: boolean; snoozedUntil?: number | null; markedUnread?: boolean }
): Promise<SessionLayoutEntry> {
  const doc = await getSessionLayout()
  const index = findEntryIndex(doc.entries, input.sessionId, input.sessionFile)
  const previous = index >= 0 ? doc.entries[index] : undefined
  return rememberSession({
    sessionId: input.sessionId,
    ...(input.sessionFile || previous?.sessionFile ? { sessionFile: input.sessionFile ?? previous?.sessionFile } : {}),
    cwd: input.cwd || previous?.cwd || '',
    ...(previous?.projectId ? { projectId: previous.projectId, scope: previous.scope } : { scope: previous?.scope ?? 'global' }),
    ...flags,
    opened: false
  })
}

export async function archiveSessionsBatch(sessionIds: readonly string[]): Promise<number> {
  const ids = new Set(sessionIds)
  if (!ids.size) return 0
  let changed = 0
  const at = now()
  await update((document) => {
    const entries = document.entries.map((entry) => {
      if (!ids.has(entry.sessionId) || entry.archivedAt) return entry
      changed++
      return { ...entry, archivedAt: at }
    })
    return changed ? { version: 1, entries } : document
  })
  return changed
}
