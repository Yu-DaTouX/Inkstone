/**
 * 会话与项目的产品语义映射。
 *
 * pi 继续拥有 JSONL 会话文件及其目录结构；Yan 只在自己的数据目录维护
 * sessionId -> projectId / scope / 最近访问时间。这样“项目内会话”不等同于
 * 把隐藏文件写进仓库，也不会破坏 pi 或后续同步层读取会话。
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
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

/** Windows 路径比较只用于身份匹配，不改变展示和落盘的原始路径。 */
export function normalizeLayoutPath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
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
  return { version: 1, entries: [...unique.values()].slice(-MAX_ENTRIES) }
}

async function readFromDisk(): Promise<SessionLayoutDocument> {
  if (cached) return cached
  try {
    cached = sanitizeDocument(JSON.parse(await readFile(SESSION_LAYOUT_FILE, 'utf8')))
  } catch {
    cached = { version: 1, entries: [] }
  }
  return cached
}

async function persist(document: SessionLayoutDocument): Promise<void> {
  await mkdir(YAN_DIR, { recursive: true })
  await writeFile(SESSION_LAYOUT_FILE, JSON.stringify(document, null, 2), 'utf8')
}

async function update(mutator: (document: SessionLayoutDocument) => SessionLayoutDocument): Promise<SessionLayoutDocument> {
  const task = writeTail.then(async () => {
    const current = sanitizeDocument(await readFromDisk())
    const rawNext = mutator(current)
    const next = rawNext === current ? current : sanitizeDocument(rawNext)
    cached = next
    if (next !== current) await persist(next)
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

/**
 * 把旧会话迁移到 layout 索引并把归属投影回列表。
 * 精确 cwd 只有一个项目时可确定迁移；多个候选会保留 pending，不静默选项目。
 */
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
        ...(entry.projectCandidates?.length ? { projectCandidates: entry.projectCandidates } : {})
      }
    })
    return changed ? { version: 1, entries } : document
  })
  return projected
}

/** 记录新建/打开会话；只更新 Yan 索引，不移动 pi 的 JSONL 文件。 */
export async function rememberSession(input: RememberSessionInput): Promise<SessionLayoutEntry> {
  if (!input.sessionId.trim()) throw new Error('缺少 sessionId')
  const result = await update((document) => {
    const entries = [...document.entries]
    const index = entries.findIndex((entry) => entry.sessionId === input.sessionId)
    const previous = index >= 0 ? entries[index] : undefined
    const nextScope = scopeFor(input.projectId, input.scope)
    const at = now()
    const history = previous?.moveHistory ? [...previous.moveHistory] : []
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

/** 移动会话只改产品归属，不停止 runner，也不移动物理会话文件。 */
export async function moveSessionLayout(input: MoveSessionInput, projectId: string | null): Promise<SessionLayoutEntry> {
  return rememberSession({
    sessionId: input.sessionId,
    sessionFile: input.sessionFile,
    cwd: input.cwd,
    ...(projectId ? { projectId, scope: 'project' } : { scope: 'global' }),
    opened: false
  })
}
