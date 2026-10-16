/**
 * v3 侧栏的纯计算：搜索过滤、按项目分组、排序、状态点投影。
 *
 * 与 v2 左栏同样的理由把逻辑抽出来 —— 分组边界、当前项目置顶、搜索命中项目名
 * 这些能用单测钉死，组件只负责画。这里**不读 store**，入参全是普通数据。
 */
import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'

/** 侧栏一个项目分区。 */
export interface SidebarGroup {
  key: string
  label: string
  projectId?: string
  cwd: string
  /** 当前视图所在项目，排最前 */
  current: boolean
  list: SessionSummary[]
}

/** 路径最后一段；放不下完整路径时显示它。 */
export function shortProject(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

/** 一条会话的活动时间：只认消息时间戳，没有才退回 updatedAt（与 v2 口径一致）。 */
function activityOf(session: SessionSummary): number {
  return session.lastActivityAt ?? session.updatedAt
}

/**
 * 一条会话当前该显示哪个运行：取 `startedAt` 最新的那一个。
 *
 * 运行实例一轮一个（每轮一个 `runId`），所以「最新开始」才是这一轮的权威状态；
 * 按开始时间挑，而不是按阶段优先级，旧失败才不会把新完成覆盖掉。
 * 没有匹配的运行就返回 null —— 调用方显示空点，不伪造阶段。
 */
export function latestRunForSession(
  runs: readonly RunSnapshot[],
  session: { id?: string; path?: string }
): RunSnapshot | null {
  let found: RunSnapshot | null = null
  for (const run of runs) {
    const matches =
      (!!session.id && run.sessionId === session.id) || (!!session.path && run.sessionPath === session.path)
    if (!matches) continue
    if (!found || run.startedAt > found.startedAt) found = run
  }
  return found
}

interface BuildOptions {
  sessions: readonly SessionSummary[]
  query: string
  projects: readonly ProjectRecord[]
  projectNames: Record<string, string>
  /** 当前视图所在项目（来自运行实例优先，其次当前会话） */
  currentProjectId?: string
  currentCwd?: string
  titles: Record<string, string>
  manualTitles: Record<string, string>
  /** 给了就把置顶会话单独收进最前面的「置顶」分区（仍受搜索过滤） */
  pinnedLabel?: string
}

/**
 * 把会话整理成「按项目分组」。规则：
 *   · 归档会话、已归档项目里的会话不进列表；
 *   · 有 ProjectRecord 的按项目分区，其余按 cwd 分区；
 *   · 搜索命中标题、路径或项目名；命中项目名时该项目的会话全部保留；
 *   · 当前项目排最前，其余按最近活动排；
 *   · 分区内按最近活动从新到旧。
 */
export function buildSidebarGroups(options: BuildOptions): SidebarGroup[] {
  const { sessions, projects, projectNames, currentProjectId, currentCwd, titles, manualTitles } = options
  const query = options.query.trim().toLowerCase()
  const recordById = new Map(projects.map((project) => [project.id, project]))

  const labelFor = (session: SessionSummary): { key: string; label: string; projectId?: string; cwd: string } => {
    const record = session.projectId ? recordById.get(session.projectId) : undefined
    if (record) {
      return {
        key: `project:${record.id}`,
        projectId: record.id,
        cwd: record.cwd,
        label: record.name || projectNames[record.cwd] || shortProject(record.cwd)
      }
    }
    const cwd = session.cwd || ''
    const label = (cwd && projectNames[cwd]) || (cwd ? shortProject(cwd) : '')
    return { key: `cwd:${cwd}`, cwd, label }
  }

  /* 已归档的项目（移除项目 = 归档）：它的会话不进主列表，在归档视图里随项目恢复。 */
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
  /** 搜索命中项目名时，这个项目里所有会话都留下（否则搜项目名只能看到一个分区标题） */
  const groupHit = (key: string): boolean => {
    if (!query) return false
    const sample = decorated.find((item) => item.group.key === key)
    return sample ? sample.group.label.toLowerCase().includes(query) : false
  }

  const byKey = new Map<string, SidebarGroup>()
  for (const item of decorated) {
    if (!matches(item) && !groupHit(item.group.key)) continue
    const existing = byKey.get(item.group.key)
    if (existing) existing.list.push(item.session)
    else
      byKey.set(item.group.key, {
        key: item.group.key,
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
    group.current = group.projectId
      ? group.projectId === currentProjectId
      : !currentProjectId && !!currentCwd && group.cwd.toLowerCase() === currentCwd.toLowerCase()
  }
  groups.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
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
  return [{ key: 'pinned', label: options.pinnedLabel, cwd: '', current: false, list: pinned }, ...rest]
}

/** 归档视图里的一个项目：记录、显示名与它名下（未单独归档的）会话数。 */
export interface ArchivedProject {
  record: ProjectRecord
  label: string
  sessionCount: number
}

export interface ArchivedView {
  projects: ArchivedProject[]
  /** 单独归档的会话（不含「所在项目已归档」的那些），按最近活动从新到旧 */
  sessions: SessionSummary[]
}

/**
 * 归档视图：已归档的项目与单独归档的会话。搜索命中标题、路径或项目名。
 * 不读 store，入参全是普通数据，与 `buildSidebarGroups` 同一口径。
 */
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
  const labelOf = (record: ProjectRecord): string => record.name || options.projectNames[record.cwd] || shortProject(record.cwd)
  const titleOf = (session: SessionSummary): string =>
    options.manualTitles[session.id] ?? options.titles[session.id] ?? session.title

  const projects = archivedProjects
    .map((record) => ({
      record,
      label: labelOf(record),
      sessionCount: options.sessions.filter(
        (session) =>
          !session.archivedAt &&
          (session.projectId ? session.projectId === record.id : !!session.cwd && session.cwd.toLowerCase() === record.cwd.toLowerCase())
      ).length
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
