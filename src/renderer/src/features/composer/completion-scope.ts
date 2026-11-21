import type { Store } from '../../state/store'

type ScopeState = Pick<Store, 'activeRunnerId' | 'runners' | 'session' | 'sessions' | 'settings'>

export function sameFileCwd(a: string, b: string): boolean {
  const foldCase = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/, '')
    return /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('\\') ? trimmed.toLowerCase() : trimmed
  }
  return foldCase(a) === foldCase(b)
}

interface CompletionScope {
  activeCwd: string
  activeRunnerId: string
  activeSessionId: string
  activeGeneration: number
  activeProjectId: string | undefined
}

export function createCompletionScopeSelector() {
  let previous: {
    runners: ScopeState['runners']
    sessions: ScopeState['sessions']
    projects: NonNullable<ScopeState['settings']>['projects'] | undefined
    sessionFile: string | undefined
    scope: CompletionScope
  } | undefined
  return (state: ScopeState): CompletionScope => {
    const { runners, sessions, session, settings } = state
    const projects = settings?.projects
    const sessionFile = session?.sessionFile
    const activeSessionId = session?.sessionId ?? ''
    const activeRunnerId = state.activeRunnerId ?? ''
    const activeCwd = session?.cwd ?? settings?.cwd ?? ''
    const last = previous?.scope
    if (previous && last && previous.runners === runners && previous.sessions === sessions && previous.projects === projects && previous.sessionFile === sessionFile &&
        last.activeSessionId === activeSessionId && last.activeRunnerId === activeRunnerId && last.activeCwd === activeCwd) return last
    const runner = runners.find((item) => (item.runId ?? item.id) === state.activeRunnerId)
    const activeGeneration = runner?.generation ?? 0
    let activeProjectId = runner?.projectId || undefined
    if (!activeProjectId) {
      const summary = sessions.find((item) => item.id === session?.sessionId || item.path === sessionFile)
      if (summary?.scope !== 'global') activeProjectId = summary?.projectId ?? projects?.find((project) => sameFileCwd(project.cwd, activeCwd))?.id
    }
    const scope = last && last.activeSessionId === activeSessionId && last.activeRunnerId === activeRunnerId && last.activeCwd === activeCwd &&
      last.activeGeneration === activeGeneration && last.activeProjectId === activeProjectId
      ? last
      : { activeCwd, activeRunnerId, activeSessionId, activeGeneration, activeProjectId }
    previous = { runners, sessions, projects, sessionFile, scope }
    return scope
  }
}

export function completionRequestKey(scope: CompletionScope, query: string): string {
  return `${scope.activeRunnerId}\0${scope.activeSessionId}\0${scope.activeCwd}\0${scope.activeProjectId ?? ''}\0${scope.activeGeneration}\0${query}`
}
