import type { EnvironmentId } from './contracts'

export interface EnvironmentProject {
  readonly environmentId: EnvironmentId
  readonly projectId: string
  readonly projectKey: string
  readonly workspaceRoot: string
  readonly displayName: string
  readonly archived: boolean
  readonly updatedAt: string
}

export function findProjectByPath<T extends { workspaceRoot: string }>(
  projects: readonly T[],
  path: string | null | undefined
): T | undefined {
  if (!path) return undefined
  const target = normalizeProjectPath(path)
  return projects.find((project) => normalizeProjectPath(project.workspaceRoot) === target)
}

export function normalizeProjectPath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

export function hasTrailingPathSeparator(value: string): boolean {
  return /[\\/]$/.test(value)
}

export function inferProjectTitleFromPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || value
}
