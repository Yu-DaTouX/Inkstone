import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_AGENT_ACTIVITY,
  DEFAULT_AGENT_PROFILE,
  activityDeniedTools,
  agentRoleSection,
  isAgentActivity,
  isAgentProfileKind,
  validateAgentProfile,
  type AgentProfile,
  type AgentProfileKind,
  type AgentProfilePatch,
  type AgentProfileState
} from '../shared/agent-profile'
import { YAN_DIR } from './paths'
import { normalizeSessionFileKey, sanitizeWorkModeKey } from './work-mode-service'

export const AGENT_PROFILE_FILE_NAME = 'agent-profiles.json'
export const AGENT_PROFILE_SNAPSHOT_DIRNAME = 'agent-profile'
export const AGENT_PROFILE_MAX_ENTRIES = 2000

export type { AgentProfileState, AgentProfilePatch } from '../shared/agent-profile'

interface StoredAgentProfile extends AgentProfile {
  revision: number
  updatedAt: number
}

interface AgentProfileDocument {
  version: 1
  entries: Record<string, StoredAgentProfile>
}

export function agentProfileDocumentPath(root: string = YAN_DIR): string {
  return join(root, AGENT_PROFILE_FILE_NAME)
}

export function pendingAgentProfileKey(runnerId: string): string {
  return `pending:${runnerId}`
}

export function agentProfileSnapshotFileName(runtimeKey: string): string {
  const safe = runtimeKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return `${safe || 'session'}.json`
}

export function agentProfileSnapshotPath(runtimeKey: string, root: string = YAN_DIR): string {
  return join(root, AGENT_PROFILE_SNAPSHOT_DIRNAME, agentProfileSnapshotFileName(runtimeKey))
}

export function normalizeProfileSessionKey(file: unknown): string | null {
  const key = normalizeSessionFileKey(file)
  if (!key) return null
  return sanitizeWorkModeKey(key)
}

function sanitizeEntry(raw: unknown): StoredAgentProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!isAgentProfileKind(o.profile) || !isAgentActivity(o.activity)) return null
  const revision =
    Number.isFinite(o.revision) && Number(o.revision) > 0 ? Math.floor(Number(o.revision)) : 1
  const updatedAt = Number.isFinite(o.updatedAt) ? Number(o.updatedAt) : 0
  const entry: StoredAgentProfile = {
    profile: o.profile,
    activity: o.activity,
    revision,
    updatedAt
  }
  for (const key of ['spaceId', 'taskId', 'courseId'] as const) {
    const value = o[key]
    if (typeof value === 'string' && value.trim()) entry[key] = value.trim()
  }
  return entry
}

export function sanitizeAgentProfileDocument(raw: unknown): AgentProfileDocument {
  const source = raw && typeof raw === 'object' ? (raw as Partial<AgentProfileDocument>) : {}
  const rawEntries = source.entries && typeof source.entries === 'object' ? source.entries : {}
  const entries: Record<string, StoredAgentProfile> = {}
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    const safe = sanitizeWorkModeKey(key)
    const entry = sanitizeEntry(value)
    if (!safe || !entry) continue
    entries[safe] = entry
  }
  const keys = Object.keys(entries)
  if (keys.length > AGENT_PROFILE_MAX_ENTRIES) {
    const keep = keys
      .sort((a, b) => entries[b].updatedAt - entries[a].updatedAt)
      .slice(0, AGENT_PROFILE_MAX_ENTRIES)
    const trimmed: Record<string, StoredAgentProfile> = {}
    for (const key of keep) trimmed[key] = entries[key]
    return { version: 1, entries: trimmed }
  }
  return { version: 1, entries }
}

export function readAgentProfileState(
  doc: AgentProfileDocument,
  runtimeKey: string,
  fallback: AgentProfileKind = DEFAULT_AGENT_PROFILE
): AgentProfileState {
  const entry = doc.entries[runtimeKey]
  if (!entry) {
    return { profile: isAgentProfileKind(fallback) ? fallback : DEFAULT_AGENT_PROFILE, activity: DEFAULT_AGENT_ACTIVITY, revision: 0 }
  }
  const state: AgentProfileState = { profile: entry.profile, activity: entry.activity, revision: entry.revision }
  if (entry.spaceId) state.spaceId = entry.spaceId
  if (entry.taskId) state.taskId = entry.taskId
  if (entry.courseId) state.courseId = entry.courseId
  return state
}

export async function writeAgentProfileSnapshot(
  runtimeKey: string,
  state: AgentProfileState,
  root: string = YAN_DIR
): Promise<void> {
  const target = agentProfileSnapshotPath(runtimeKey, root)
  await mkdir(dirname(target), { recursive: true })
  const record = {
    version: 1,
    runtimeKey,
    profile: state.profile,
    activity: state.activity,
    ...(state.spaceId ? { spaceId: state.spaceId } : {}),
    ...(state.taskId ? { taskId: state.taskId } : {}),
    ...(state.courseId ? { courseId: state.courseId } : {}),
    revision: state.revision,
    roleSection: agentRoleSection(state.profile, state.activity),
    deniedTools: state.profile === 'daily' ? [...activityDeniedTools(state.activity)] : [],
    at: new Date().toISOString()
  }
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(record), 'utf8')
  try {
    await rename(temp, target)
  } catch {
    await writeFile(target, JSON.stringify(record), 'utf8')
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

export interface AgentProfileSetResult {
  ok: boolean
  state: AgentProfileState
  error?: 'version-mismatch' | 'bad-key' | 'invalid-profile'
  detail?: string
}

const EMPTY_STATE: AgentProfileState = {
  profile: DEFAULT_AGENT_PROFILE,
  activity: DEFAULT_AGENT_ACTIVITY,
  revision: 0
}

export class AgentProfileStore {
  private readonly root: string
  private readonly now: () => number
  private doc: AgentProfileDocument = { version: 1, entries: {} }
  private loaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: { root?: string; now?: () => number } = {}) {
    this.root = options.root ?? YAN_DIR
    this.now = options.now ?? Date.now
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = JSON.parse(await readFile(agentProfileDocumentPath(this.root), 'utf8'))
      this.doc = sanitizeAgentProfileDocument(raw)
    } catch {
      this.doc = { version: 1, entries: {} }
    }
    this.loaded = true
  }

  state(runtimeKey: string, fallback: AgentProfileKind = DEFAULT_AGENT_PROFILE): AgentProfileState {
    if (!this.loaded) return { ...EMPTY_STATE, profile: fallback }
    return readAgentProfileState(this.doc, runtimeKey, fallback)
  }

  async set(runtimeKey: string, patch: AgentProfilePatch, expectedRevision?: number): Promise<AgentProfileSetResult> {
    return this.enqueue(async () => {
      const safe = sanitizeWorkModeKey(runtimeKey)
      if (!safe) return { ok: false, state: EMPTY_STATE, error: 'bad-key' as const }
      await this.load()
      const current = readAgentProfileState(this.doc, safe)
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, state: current, error: 'version-mismatch' as const }
      }

      const next: AgentProfile = {
        profile: patch.profile ?? current.profile,
        activity: patch.activity ?? current.activity
      }
      const carry = (key: 'spaceId' | 'taskId' | 'courseId'): void => {
        const incoming = patch[key]
        if (incoming === undefined) {
          if (current[key]) next[key] = current[key]
          return
        }
        if (incoming === null) return
        next[key] = incoming
      }
      carry('spaceId')
      carry('taskId')
      carry('courseId')

      const check = validateAgentProfile(next)
      if (!check.ok) {
        return { ok: false, state: current, error: 'invalid-profile' as const, detail: check.reason }
      }

      const entry: StoredAgentProfile = { ...check.profile, revision: current.revision + 1, updatedAt: this.now() }
      this.doc = {
        version: 1,
        entries: { ...this.doc.entries, [safe]: entry }
      }
      await this.flush()
      return { ok: true, state: readAgentProfileState(this.doc, safe) }
    })
  }

  async adopt(fromKey: string, toKey: string): Promise<AgentProfileState> {
    return this.enqueue(async () => {
      const from = sanitizeWorkModeKey(fromKey)
      const to = sanitizeWorkModeKey(toKey)
      await this.load()
      if (!from || !to || from === to) return readAgentProfileState(this.doc, to ?? from ?? '')
      const entry = this.doc.entries[from]
      if (!entry) return readAgentProfileState(this.doc, to)
      const entries = { ...this.doc.entries, [to]: entry }
      delete entries[from]
      this.doc = { version: 1, entries }
      await this.flush()
      return readAgentProfileState(this.doc, to)
    })
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.catch(() => undefined)
    return run
  }

  private async flush(): Promise<void> {
    const target = agentProfileDocumentPath(this.root)
    const temp = `${target}.${process.pid}.tmp`
    try {
      await mkdir(dirname(target), { recursive: true })
      const payload = JSON.stringify(this.doc)
      await writeFile(temp, payload, 'utf8')
      try {
        await rename(temp, target)
      } catch {
        await writeFile(target, payload, 'utf8')
        await rm(temp, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      try {
        this.doc = sanitizeAgentProfileDocument(JSON.parse(await readFile(agentProfileDocumentPath(this.root), 'utf8')))
      } catch {
        this.doc = { version: 1, entries: {} }
      }
      throw error
    }
  }
}
