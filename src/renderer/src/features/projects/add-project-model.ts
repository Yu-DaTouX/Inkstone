import type { MessageKey } from '../../i18n'

export type AddProjectSource = 'new' | 'local' | 'url' | 'github'

export interface AddProjectSourceItem {
  id: AddProjectSource
  title: MessageKey
  description: MessageKey
}

export const ADD_PROJECT_SOURCES: readonly AddProjectSourceItem[] = [
  { id: 'new', title: 'project.add.new', description: 'project.add.new.desc' },
  { id: 'local', title: 'project.add.local', description: 'project.add.local.desc' },
  { id: 'url', title: 'project.add.url', description: 'project.add.url.desc' },
  { id: 'github', title: 'project.add.github', description: 'project.add.github.desc' }
]

export function filterSources(items: readonly AddProjectSourceItem[], query: string, label: (key: MessageKey) => string): AddProjectSourceItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...items]
  return items.filter((item) => `${label(item.title)} ${label(item.description)}`.toLowerCase().includes(needle))
}

export function repoNameOf(nameWithOwner: string): string {
  return nameWithOwner.split('/').pop() ?? nameWithOwner
}

export function urlNameOf(url: string): string {
  const last = url.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? ''
  return last || url
}

export function wrapIndex(index: number, count: number, delta: number): number {
  if (count <= 0) return -1
  return (index + delta + count) % count
}

export function formatStars(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0'
  if (count < 1000) return String(Math.floor(count))
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}
