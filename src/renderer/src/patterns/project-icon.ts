import { useStore } from '../state/store'
import type { ProjectRecord } from '../../../shared/ipc'
import { AUTO_PROJECT_COLOR_COUNT as AUTO_COLOR_COUNT, hashedProjectTone, projectMonogram } from '../../../shared/project-monogram'

export { hashedProjectTone, projectMonogram }
export const PROJECT_ICON_COLORS = [1, 2, 3, 4, 5, 6, 7, 8] as const

export interface ProjectIconLook {
  tone: number
  text: string
  custom: boolean
}

export function normalizeIconText(value: string): string {
  return [...value.trim()].slice(0, 2).join('')
}

const toneCache = new WeakMap<readonly ProjectRecord[], Map<string, number>>()

export function assignProjectTones(projects: readonly ProjectRecord[]): Map<string, number> {
  const cached = toneCache.get(projects)
  if (cached) return cached
  const tones = new Map<string, number>()
  const used = new Set<number>()
  const ordered = [...projects].sort((a, b) => Number(a.archived) - Number(b.archived) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  for (const project of ordered) {
    if (project.iconColor) {
      tones.set(project.id, project.iconColor)
      if (!project.archived) used.add(project.iconColor)
    }
  }
  for (const project of ordered) {
    if (tones.has(project.id)) continue
    const preferred = hashedProjectTone(project.id)
    let tone = preferred
    for (let step = 0; step < AUTO_COLOR_COUNT; step++) {
      const candidate = ((preferred - 1 + step) % AUTO_COLOR_COUNT) + 1
      if (!used.has(candidate)) {
        tone = candidate
        break
      }
    }
    tones.set(project.id, tone)
    if (!project.archived) used.add(tone)
  }
  toneCache.set(projects, tones)
  return tones
}

export function projectIconLook(projects: readonly ProjectRecord[] | undefined, projectId: string | null | undefined, label: string): ProjectIconLook {
  const record = projectId ? projects?.find((project) => project.id === projectId) : undefined
  const tone = record && projects ? (assignProjectTones(projects).get(record.id) ?? hashedProjectTone(record.id)) : hashedProjectTone(projectId || label)
  const text = record?.iconText ? normalizeIconText(record.iconText) : projectMonogram(label)
  return { tone, text, custom: Boolean(record?.iconColor || record?.iconText) }
}

export function useProjectIconLook(projectId: string | null | undefined, label: string): ProjectIconLook {
  const projects = useStore((s) => s.settings?.projects)
  return projectIconLook(projects, projectId, label)
}
