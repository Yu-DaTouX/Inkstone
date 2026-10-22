import type { TFunc } from '../i18n'
import { useStore } from '../state/store'
import { warnIfWorkspaceUnfit } from './workspace-fit'

export async function newSessionInPickedFolder(t: TFunc): Promise<boolean> {
  const selected = await window.yan.pickCwd().catch(() => null)
  if (!selected) return false
  const store = useStore.getState()
  const result = await window.yan.setCwd(selected)
  if (!result.ok) {
    store.notify('error', result.error ?? selected)
    return false
  }
  warnIfWorkspaceUnfit(result.cwd ?? selected, t)
  const settings = await window.yan.getSettings()
  useStore.setState({ settings })
  const project = settings.projects.find((p) => p.cwd === settings.cwd)
  await store.newSession({ cwd: settings.cwd, projectId: project?.id, scope: 'project' })
  return true
}
