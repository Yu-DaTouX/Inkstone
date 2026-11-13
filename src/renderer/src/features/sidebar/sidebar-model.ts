import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import type { RunSnapshot } from '../../../../shared/runs'
import { normalizeLayoutPath as normalizeCwd } from '../../../../shared/session-path'

export function sameCwd(a: string, b: string): boolean {
  return normalizeCwd(a) === normalizeCwd(b)
}

export function shortProject(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

function activityOf(session: SessionSummary): number {
  return session.lastActivityAt ?? session.updatedAt
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

export function projectMonogram(label: string): string {
  const words = label.trim().split(/[\s._\-/\\]+/).filter(Boolean)
  if (!words.length) return '?'
  const first = [...words[0]]
  if (/^[\x00-\x7f]+$/.test(words[0]) === false) return first[0]
  const digit = first.slice(1).find((char) => /\d/.test(char))
  const second = digit ?? (words.length > 1 ? [...words[words.length - 1]][0] : first[1] ?? '')
  return (first[0] + second).toUpperCase()
}

export function compactAgo(at: number, now: number, lang: 'zh-CN' | 'en-US'): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return '<1m'
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
