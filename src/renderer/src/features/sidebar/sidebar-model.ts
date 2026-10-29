import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'

export interface SidebarGroup {
  key: string
  slot: string
  label: string
  projectId?: string
  cwd: string
  current: boolean
  list: SessionSummary[]
}

export function sameCwd(a: string, b: string): boolean {
  return normalizeCwd(a) === normalizeCwd(b)
}

function normalizeCwd(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function shortProject(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

export function compactCwd(cwd: string): string {
  const sep = cwd.includes('\\') ? '\\' : '/'
  const home = /^(?:[A-Za-z]:[\\/]Users[\\/][^\\/]+|\/(?:home|Users)\/[^/]+)(?=[\\/]|$)/.exec(cwd)
  const parts = (home ? cwd.slice(home[0].length) : cwd).split(/[\\/]+/).filter(Boolean)
  const head = home ? ['~'] : cwd.startsWith('/') ? [''] : []
  const full = [...head, ...parts]
  if (full.length <= 3) return full.join(sep) || cwd
  return [full[0], '\u2026', ...parts.slice(-2)].join(sep)
}

function pathParts(cwd: string): string[] {
  return cwd.split(/[\\/]+/).filter(Boolean)
}

const HINT_MAX = 16

function clipHint(hint: string): string {
  const chars = [...hint]
  return chars.length > HINT_MAX ? `\u2026${chars.slice(-(HINT_MAX - 2)).join('')}` : hint
}

function distinctTail(cwd: string, rivals: readonly string[], label: string, clip: boolean): string {
  const sep = cwd.includes('\\') ? '\\' : '/'
  const own = pathParts(cwd)
  const others = rivals.map(pathParts)
  for (let take = 1; take <= own.length; take++) {
    const tail = own.slice(-take).join('/').toLowerCase()
    if (others.every((parts) => parts.slice(-take).join('/').toLowerCase() !== tail)) {
      const parts = own.slice(-take)
      if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === label.toLowerCase()) parts.pop()
      return clip ? clipHint(parts.join(sep)) : parts.join(sep)
    }
  }
  return clip ? clipHint(compactCwd(cwd)) : compactCwd(cwd)
}

export function segmentPathHints(groups: readonly SidebarGroup[], options: { renamed?: boolean; clip?: boolean } = {}): Map<string, string> {
  const byLabel = new Map<string, Map<string, string>>()
  for (const group of groups) {
    if (!group.cwd || group.key === 'pinned') continue
    const label = group.label.toLowerCase()
    const keys = byLabel.get(label) ?? new Map<string, string>()
    keys.set(group.key, group.cwd)
    byLabel.set(label, keys)
  }
  const hints = new Map<string, string>()
  for (const group of groups) {
    if (!group.cwd || group.key === 'pinned' || hints.has(group.key)) continue
    const peers = byLabel.get(group.label.toLowerCase()) ?? new Map<string, string>()
    const rivals = [...peers].filter(([key, cwd]) => key !== group.key && !sameCwd(cwd, group.cwd)).map(([, cwd]) => cwd)
    if (rivals.length) hints.set(group.key, distinctTail(group.cwd, rivals, group.label, !!options.clip))
    else if (options.renamed && group.label.toLowerCase() !== shortProject(group.cwd).toLowerCase()) hints.set(group.key, compactCwd(group.cwd))
  }
  return hints
}

export type RecencyBucket = 'today' | 'yesterday' | 'week' | 'older'
export type RecencyTier = 'hot' | 'warm' | 'cool' | 'cold'

export const RECENCY_BUCKETS: readonly RecencyBucket[] = ['today', 'yesterday', 'week', 'older']

function dayStart(now: number, back = 0): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - back)
  return day.getTime()
}

export function recencyBucket(at: number, now: number): RecencyBucket {
  if (at >= dayStart(now)) return 'today'
  if (at >= dayStart(now, 1)) return 'yesterday'
  if (at >= dayStart(now, 6)) return 'week'
  return 'older'
}

export function recencyTier(at: number, now: number): RecencyTier {
  if (now - at < 3_600_000) return 'hot'
  const bucket = recencyBucket(at, now)
  if (bucket === 'today') return 'warm'
  return bucket === 'older' ? 'cold' : 'cool'
}

export interface RecencyRun<T> {
  bucket: RecencyBucket
  entries: T[]
}

export function bucketByRecency<T>(entries: readonly T[], activityAt: (entry: T) => number, now: number): RecencyRun<T>[] {
  const runs: RecencyRun<T>[] = []
  for (const entry of entries) {
    const bucket = recencyBucket(activityAt(entry), now)
    const last = runs[runs.length - 1]
    if (last && RECENCY_BUCKETS.indexOf(last.bucket) >= RECENCY_BUCKETS.indexOf(bucket)) last.entries.push(entry)
    else runs.push({ bucket, entries: [entry] })
  }
  return runs
}

function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.\u2026。]+$/, '')
}

export function titleTwins(items: readonly { id: string; title: string }[]): Set<string> {
  const byKey = new Map<string, string[]>()
  for (const item of items) {
    const key = titleKey(item.title)
    if (!key) continue
    const ids = byKey.get(key) ?? []
    ids.push(item.id)
    byKey.set(key, ids)
  }
  const twins = new Set<string>()
  for (const ids of byKey.values()) if (ids.length > 1) for (const id of ids) twins.add(id)
  return twins
}

export function sessionNote(session: Pick<SessionSummary, 'lastReply' | 'createdAt'>, lang: 'zh-CN' | 'en-US'): string {
  const reply = session.lastReply?.text
    ?.split('\n')
    .map((line) => line.replace(/^[\s#>*\-+`|]+/, '').replace(/[*`_]+/g, '').trim())
    .find(Boolean)
  if (reply) return reply.length > 120 ? `${reply.slice(0, 120)}\u2026` : reply
  return new Date(session.createdAt).toLocaleString(lang, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export interface SessionRowMeta {
  ago: string
  age: RecencyTier
  elapsed?: string
  note?: string
}

function elapsedLabel(since: number, now: number, lang: 'zh-CN' | 'en-US'): string {
  return now - since < 60_000 ? '<1m' : compactAgo(since, now, lang)
}

export function sessionRowMeta(
  session: SessionSummary,
  options: { now: number; lang: 'zh-CN' | 'en-US'; since?: number; live?: boolean; twin?: boolean }
): SessionRowMeta {
  const at = activityOf(session)
  return {
    ago: compactAgo(at, options.now, options.lang),
    age: options.live ? 'hot' : recencyTier(at, options.now),
    elapsed: options.live && options.since ? elapsedLabel(options.since, options.now, options.lang) : undefined,
    note: options.twin ? sessionNote(session, options.lang) : undefined
  }
}

export type AttentionKind = 'running' | 'awaiting' | 'unread'

export type AttentionTally = Record<AttentionKind, string[]>

export function tallyAttention(rows: readonly { path: string; status: string }[]): AttentionTally {
  const tally: AttentionTally = { running: [], awaiting: [], unread: [] }
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.path)) continue
    seen.add(row.path)
    if (row.status === 'running' || row.status === 'awaiting') tally[row.status].push(row.path)
    else if (row.status === 'unread') tally.unread.push(row.path)
  }
  return tally
}

export function nextAttentionPath(paths: readonly string[], after: string | null): string | null {
  if (!paths.length) return null
  const index = after ? paths.indexOf(after) : -1
  return paths[(index + 1) % paths.length]
}

function activityOf(session: SessionSummary): number {
  return session.lastActivityAt ?? session.updatedAt
}

export interface RunIndex {
  latest(session: { id?: string | null; path?: string | null }): RunSnapshot | null
}

export function indexRuns(runs: readonly RunSnapshot[]): RunIndex {
  const byId = new Map<string, RunSnapshot>()
  const byPath = new Map<string, RunSnapshot>()
  const keep = (map: Map<string, RunSnapshot>, key: string, run: RunSnapshot): void => {
    const previous = map.get(key)
    if (!previous || run.startedAt > previous.startedAt) map.set(key, run)
  }
  for (const run of runs) {
    if (run.sessionId) keep(byId, run.sessionId, run)
    if (run.sessionPath) keep(byPath, run.sessionPath, run)
  }
  return {
    latest(session) {
      const bySession = session.id ? byId.get(session.id) : undefined
      const byFile = session.path ? byPath.get(session.path) : undefined
      if (!bySession) return byFile ?? null
      if (!byFile) return bySession
      return byFile.startedAt > bySession.startedAt ? byFile : bySession
    }
  }
}

export function unreadRunIdsForSession(
  runs: readonly RunSnapshot[],
  session: { id?: string | null; path?: string | null }
): string[] {
  if (!session.id && !session.path) return []
  return runs
    .filter((run) => (!!session.id && run.sessionId === session.id) || (!!session.path && run.sessionPath === session.path))
    .filter((run) => (run.phase.kind === 'done' || run.phase.kind === 'failed') && !run.phase.seen)
    .map((run) => run.runId)
}

interface BuildOptions {
  sessions: readonly SessionSummary[]
  query: string
  projects: readonly ProjectRecord[]
  projectNames: Record<string, string>
  currentProjectId?: string
  currentCwd?: string
  titles: Record<string, string>
  manualTitles: Record<string, string>
  pinnedLabel?: string
}

export function buildSidebarGroups(options: BuildOptions): SidebarGroup[] {
  const { sessions, projects, projectNames, currentProjectId, currentCwd, titles, manualTitles } = options
  const query = options.query.trim().toLowerCase()
  const recordById = new Map(projects.map((project) => [project.id, project]))
  const recordByCwd = new Map<string, ProjectRecord>()
  for (const project of projects) {
    const key = normalizeCwd(project.cwd)
    if (!recordByCwd.has(key)) recordByCwd.set(key, project)
  }

  const labelFor = (session: SessionSummary): { key: string; slot: string; label: string; projectId?: string; cwd: string } => {
    const record =
      (session.projectId ? recordById.get(session.projectId) : undefined) ??
      (session.cwd ? recordByCwd.get(normalizeCwd(session.cwd)) : undefined)
    if (record) {
      return {
        key: `project:${record.id}`,
        slot: `cwd:${record.cwd.toLowerCase()}`,
        projectId: record.id,
        cwd: record.cwd,
        label: record.name || projectNames[record.cwd] || shortProject(record.cwd)
      }
    }
    const cwd = session.cwd || ''
    const label = (cwd && projectNames[cwd]) || (cwd ? shortProject(cwd) : '')
    return { key: `cwd:${cwd}`, slot: `cwd:${cwd.toLowerCase()}`, cwd, label }
  }

  const archivedIds = new Set(projects.filter((project) => project.archived).map((project) => project.id))
  const archivedCwds = new Set(projects.filter((project) => project.archived).map((project) => project.cwd.toLowerCase()))
  const inArchivedProject = (session: SessionSummary): boolean =>
    session.projectId ? archivedIds.has(session.projectId) : !!session.cwd && archivedCwds.has(session.cwd.toLowerCase())
  const active = sessions.filter((session) => !session.archivedAt && !inArchivedProject(session))
  const decorated = active.map((session) => {
    const group = labelFor(session)
    const title = manualTitles[session.id] ?? titles[session.id] ?? session.title
    return { session, group, title }
  })

  const matches = (item: (typeof decorated)[number]): boolean => {
    if (!query) return true
    const haystack = [item.title, item.session.cwd, item.group.label, item.session.path]
    return haystack.some((value) => value.toLowerCase().includes(query))
  }
  const groupLabels = new Map<string, string>()
  for (const item of decorated) {
    if (!groupLabels.has(item.group.key)) groupLabels.set(item.group.key, item.group.label)
  }
  const groupHit = (key: string): boolean => {
    if (!query) return false
    const label = groupLabels.get(key)
    return label ? label.toLowerCase().includes(query) : false
  }

  const byKey = new Map<string, SidebarGroup>()
  for (const item of decorated) {
    if (!matches(item) && !groupHit(item.group.key)) continue
    const existing = byKey.get(item.group.key)
    if (existing) existing.list.push(item.session)
    else
      byKey.set(item.group.key, {
        key: item.group.key,
        slot: item.group.slot,
        label: item.group.label,
        projectId: item.group.projectId,
        cwd: item.group.cwd,
        current: false,
        list: [item.session]
      })
  }

  const groups = [...byKey.values()]
  for (const group of groups) {
    group.list.sort((a, b) => activityOf(b) - activityOf(a))
    group.current =
      (!!group.projectId && group.projectId === currentProjectId) ||
      (!currentProjectId && !!currentCwd && group.cwd.toLowerCase() === currentCwd.toLowerCase())
  }
  groups.sort((a, b) => {
    const at = a.list[0] ? activityOf(a.list[0]) : 0
    const bt = b.list[0] ? activityOf(b.list[0]) : 0
    return bt - at
  })
  if (!options.pinnedLabel) return groups
  const pinned: SessionSummary[] = []
  for (const group of groups) {
    group.list = group.list.filter((session) => {
      if (!session.pinned) return true
      pinned.push(session)
      return false
    })
  }
  const rest = groups.filter((group) => group.list.length > 0)
  if (!pinned.length) return rest
  pinned.sort((a, b) => activityOf(b) - activityOf(a))
  return [{ key: 'pinned', slot: 'pinned', label: options.pinnedLabel, cwd: '', current: false, list: pinned }, ...rest]
}

export function withIdleProjects(
  groups: readonly SidebarGroup[],
  projects: readonly ProjectRecord[],
  projectNames: Record<string, string>
): SidebarGroup[] {
  const idle = projects
    .filter((project) => !project.archived && !groups.some((group) => group.projectId === project.id || (!!group.cwd && sameCwd(group.cwd, project.cwd))))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((project) => ({
      key: `project:${project.id}`,
      slot: `cwd:${project.cwd.toLowerCase()}`,
      label: project.name || projectNames[project.cwd] || shortProject(project.cwd),
      projectId: project.id,
      cwd: project.cwd,
      current: false,
      list: []
    }))
  return [...groups, ...idle]
}

export const GROUP_PAGE_SIZE = 10

export interface SidebarGroupPage {
  rows: SessionSummary[]
  hidden: number
  revealable: number
  expanded: boolean
}

export function groupPage(
  list: readonly SessionSummary[],
  revealed = 0,
  keep?: SessionSummary | null
): SidebarGroupPage {
  const limit = GROUP_PAGE_SIZE + Math.max(0, revealed)
  const expanded = list.length <= limit
  const rows = expanded ? [...list] : list.slice(0, limit)
  if (keep && !rows.includes(keep)) rows.push(keep)
  const hidden = expanded ? 0 : list.length - limit
  return { rows, hidden, revealable: Math.min(GROUP_PAGE_SIZE, hidden), expanded }
}

export interface FlatEntry {
  session: SessionSummary
  group: SidebarGroup
}

export interface FlatSidebar {
  pinned: FlatEntry[]
  rows: FlatEntry[]
}

export const FLAT_PAGE_SIZE = 30

export function buildFlatSidebar(groups: readonly SidebarGroup[], scopeKey: string | null): FlatSidebar {
  const entries: FlatEntry[] = []
  for (const group of groups) {
    if (scopeKey && group.key !== scopeKey) continue
    for (const session of group.list) entries.push({ session, group })
  }
  entries.sort((a, b) => activityOf(b.session) - activityOf(a.session))
  return {
    pinned: entries.filter((entry) => entry.session.pinned),
    rows: entries.filter((entry) => !entry.session.pinned)
  }
}

export function isGlobalGroup(group: SidebarGroup): boolean {
  return !group.projectId && group.list.length > 0 && group.list.every((session) => session.scope === 'global')
}

export function projectMonogram(label: string): string {
  const words = label.trim().split(/[\s._\-/\\]+/).filter(Boolean)
  if (!words.length) return '?'
  const first = [...words[0]]
  if (/^[\x00-\x7f]+$/.test(words[0]) === false) return first[0]
  const digit = first.slice(1).find((char) => /\d/.test(char))
  const second = digit ?? (words.length > 1 ? [...words[words.length - 1]][0] : first[1] ?? '')
  return (first[0] + second).toUpperCase()
}

export const PROJECT_TONES = 7

export function projectTone(label: string): number {
  let hash = 0
  for (const char of label.toLowerCase()) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  return (hash % PROJECT_TONES) + 1
}

export function compactAgo(at: number, now: number, lang: 'zh-CN' | 'en-US'): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return lang === 'en-US' ? 'now' : '刚刚'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  return new Date(at).toLocaleDateString(lang, { month: 'numeric', day: 'numeric' })
}

export function sessionActivityAt(session: SessionSummary): number {
  return activityOf(session)
}

export function sessionProjectLabel(session: SessionSummary, projects: readonly ProjectRecord[], projectNames: Record<string, string>): { label: string; cwd: string } {
  const record =
    (session.projectId ? projects.find((project) => project.id === session.projectId) : undefined) ??
    (session.cwd ? projects.find((project) => sameCwd(project.cwd, session.cwd)) : undefined)
  if (record) return { label: record.name || projectNames[record.cwd] || shortProject(record.cwd), cwd: record.cwd }
  const cwd = session.cwd || ''
  return { label: (cwd && projectNames[cwd]) || (cwd ? shortProject(cwd) : ''), cwd }
}

export interface ArchivedProject {
  record: ProjectRecord
  label: string
  sessionCount: number
}

export interface ArchivedView {
  projects: ArchivedProject[]
  sessions: SessionSummary[]
}

export function buildArchivedView(options: {
  sessions: readonly SessionSummary[]
  projects: readonly ProjectRecord[]
  projectNames: Record<string, string>
  titles: Record<string, string>
  manualTitles: Record<string, string>
  query: string
}): ArchivedView {
  const query = options.query.trim().toLowerCase()
  const archivedProjects = options.projects.filter((project) => project.archived)
  const idCounts = new Map<string, number>()
  const cwdCounts = new Map<string, number>()
  for (const session of options.sessions) {
    if (session.archivedAt) continue
    if (session.projectId) idCounts.set(session.projectId, (idCounts.get(session.projectId) ?? 0) + 1)
    else if (session.cwd) {
      const key = session.cwd.toLowerCase()
      cwdCounts.set(key, (cwdCounts.get(key) ?? 0) + 1)
    }
  }
  const labelOf = (record: ProjectRecord): string => record.name || options.projectNames[record.cwd] || shortProject(record.cwd)
  const titleOf = (session: SessionSummary): string =>
    options.manualTitles[session.id] ?? options.titles[session.id] ?? session.title

  const projects = archivedProjects
    .map((record) => ({
      record,
      label: labelOf(record),
      sessionCount: (idCounts.get(record.id) ?? 0) + (cwdCounts.get(record.cwd.toLowerCase()) ?? 0)
    }))
    .filter((item) => !query || item.label.toLowerCase().includes(query) || item.record.cwd.toLowerCase().includes(query))
    .sort((a, b) => b.record.updatedAt - a.record.updatedAt)

  const sessions = options.sessions
    .filter((session) => !!session.archivedAt)
    .filter((session) => {
      if (!query) return true
      return [titleOf(session), session.cwd, session.path].some((value) => value.toLowerCase().includes(query))
    })
    .sort((a, b) => activityOf(b) - activityOf(a))
  return { projects, sessions }
}
