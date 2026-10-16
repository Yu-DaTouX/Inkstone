import type { RunnerStatus, SessionSummary } from '../../../shared/ipc'

export function pickProjectSession(input: {
  cwd: string
  projectId?: string
  runners: Pick<RunnerStatus, 'cwd' | 'projectId' | 'sessionFile' | 'lastActiveAt'>[]
  sessions: Pick<
    SessionSummary,
    'path' | 'cwd' | 'projectId' | 'scope' | 'lastActivityAt' | 'lastOpenedAt' | 'updatedAt'
  >[]
}): string | undefined {
  const { cwd, projectId, runners, sessions } = input

  const runner = runners
    .filter(
      (r) =>
        !!r.sessionFile &&
        sameCwd(r.cwd, cwd) &&
        (!projectId || r.projectId === projectId)
    )
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
  if (runner?.sessionFile) return runner.sessionFile

  const recent = sessions
    .filter((x) => (projectId ? x.projectId === projectId : sameCwd(x.cwd, cwd)))
    .sort(compareRecency)[0]
  return recent?.path
}

function compareRecency(
  a: Pick<SessionSummary, 'lastActivityAt' | 'lastOpenedAt' | 'updatedAt'>,
  b: Pick<SessionSummary, 'lastActivityAt' | 'lastOpenedAt' | 'updatedAt'>
): number {
  const aOpened = a.lastOpenedAt ?? 0
  const bOpened = b.lastOpenedAt ?? 0
  if (aOpened > 0 !== bOpened > 0) return aOpened > 0 ? -1 : 1
  if (aOpened > 0 && bOpened > 0) return bOpened - aOpened
  return (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt)
}

export function sameCwd(a: string | undefined, b: string | undefined): boolean {
  const norm = (p: string | undefined): string =>
    (p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return !!a && !!b && norm(a) === norm(b)
}
