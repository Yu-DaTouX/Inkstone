import { useMemo } from 'react'
import type { ProjectRecord } from '../../../../shared/ipc'
import { useStore } from '../../state/store'
import { currentWorkspaceOwner, useWorkspaceOwner } from '../workbench/use-owner'
import { chooseProject, projectIdOfView } from './project-scripts'
import type { ProjectIdView } from './project-scripts'

export interface ProjectTarget {
  project: ProjectRecord | null
  ownerKey: string
  cwd: string
}

function viewInputOf(state: ReturnType<typeof useStore.getState>): ProjectIdView {
  return {
    peekedSessionId: state.peekedSessionId,
    peekedPath: state.peekedPath,
    sessions: state.sessions,
    runners: state.runners,
    activeRunnerId: state.activeRunnerId,
    pendingProjectId: state.pendingActivation?.projectId
  }
}

export function currentProjectTarget(): ProjectTarget {
  const state = useStore.getState()
  const owner = currentWorkspaceOwner()
  const project = chooseProject(state.settings?.projects ?? [], projectIdOfView(viewInputOf(state)), owner.cwd)
  return { project, ownerKey: owner.key, cwd: project?.cwd || owner.cwd }
}

export function useCurrentProject(): ProjectRecord | null {
  return useProjectTarget().project
}

export function useProjectTarget(): ProjectTarget {
  const settings = useStore((s) => s.settings)
  const sessions = useStore((s) => s.sessions)
  const runners = useStore((s) => s.runners)
  const activeRunnerId = useStore((s) => s.activeRunnerId)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const pendingProjectId = useStore((s) => s.pendingActivation?.projectId)
  const owner = useWorkspaceOwner()

  return useMemo(() => {
    const project = chooseProject(
      settings?.projects ?? [],
      projectIdOfView({ peekedSessionId, peekedPath, sessions, runners, activeRunnerId, pendingProjectId }),
      owner.cwd
    )
    return { project, ownerKey: owner.key, cwd: project?.cwd || owner.cwd }
  }, [settings, sessions, runners, activeRunnerId, peekedSessionId, peekedPath, pendingProjectId, owner])
}
