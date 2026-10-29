import {
  MAX_PROJECT_SCRIPTS,
  sanitizeProjectScripts,
  type PackageScript,
  type ProjectScript
} from '../../../../shared/project-scripts'
import type { ProjectRecord } from '../../../../shared/ipc'

export function scriptsOfProject(
  all: Record<string, ProjectScript[]> | undefined,
  projectId: string | null | undefined
): ProjectScript[] {
  if (!projectId || !all) return []
  const list = all[projectId]
  return Array.isArray(list) ? list : []
}

export function primaryProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts[0] ?? null
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizePath(value: string): string {
  const slashed = value.replace(/[\\/]+/g, '/').toLowerCase()
  return slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normalizePath(a) === normalizePath(b)
}

export function importablePackageScripts(
  scripts: readonly ProjectScript[],
  available: readonly PackageScript[]
): PackageScript[] {
  return available.filter(
    (item) =>
      !scripts.some((script) => sameText(script.command, item.command) || sameText(script.name, item.name))
  )
}

export function addProjectScripts(
  scripts: readonly ProjectScript[],
  adds: readonly PackageScript[],
  createId: () => string
): ProjectScript[] {
  const next = [...scripts]
  for (const add of adds) {
    if (next.length >= MAX_PROJECT_SCRIPTS) break
    if (next.some((script) => sameText(script.command, add.command) || sameText(script.name, add.name))) continue
    next.push({ id: createId(), name: add.name, command: add.command, icon: 'play' })
  }
  return next
}

export function moveProjectScript(
  scripts: readonly ProjectScript[],
  id: string,
  offset: number
): ProjectScript[] {
  const index = scripts.findIndex((script) => script.id === id)
  if (index < 0) return [...scripts]
  const target = index + offset
  if (target < 0 || target >= scripts.length) return [...scripts]
  const next = [...scripts]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

export function replaceProjectScript(
  scripts: readonly ProjectScript[],
  id: string,
  patch: Partial<Omit<ProjectScript, 'id'>>
): ProjectScript[] {
  return scripts.map((script) => (script.id === id ? { ...script, ...patch } : script))
}

export function removeProjectScript(scripts: readonly ProjectScript[], id: string): ProjectScript[] {
  return scripts.filter((script) => script.id !== id)
}

export function normalizeProjectScripts(scripts: readonly Partial<ProjectScript>[]): ProjectScript[] {
  return sanitizeProjectScripts({ draft: scripts }).draft ?? []
}

export function chooseProject(
  projects: readonly ProjectRecord[],
  projectId: string | null | undefined,
  cwd: string | null | undefined
): ProjectRecord | null {
  if (projectId) {
    const byId = projects.find((project) => project.id === projectId)
    if (byId) return byId
  }
  if (!cwd) return null
  return projects.find((project) => samePath(project.cwd, cwd)) ?? null
}

export interface ProjectIdView {
  peekedSessionId: string | null
  peekedPath: string | null
  sessions: readonly { id: string; path: string; projectId?: string }[]
  runners: readonly { id?: string; runId: string; projectId?: string }[]
  activeRunnerId: string | null
  pendingProjectId?: string
}

export function projectIdOfView(view: ProjectIdView): string | null {
  const summary = view.sessions.find((item) =>
    view.peekedSessionId ? item.id === view.peekedSessionId : samePath(item.path, view.peekedPath)
  )
  if (summary?.projectId) return summary.projectId
  const runner = view.activeRunnerId
    ? view.runners.find((item) => (item.runId ?? item.id) === view.activeRunnerId)
    : undefined
  return runner?.projectId ?? view.pendingProjectId ?? null
}
