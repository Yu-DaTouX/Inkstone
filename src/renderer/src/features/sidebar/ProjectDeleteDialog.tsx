import { useState, type ReactElement } from 'react'
import type { ProjectRecord, SessionSummary } from '../../../../shared/ipc'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, DialogFooter, Modal, ModalOverlay, Notice } from '../../ui'
import { sameCwd } from './sidebar-model'

export function sessionsOfProject(sessions: readonly SessionSummary[], projects: readonly ProjectRecord[], project: ProjectRecord): SessionSummary[] {
  const known = new Set(projects.map((item) => item.id))
  return sessions.filter((session) =>
    session.projectId === project.id ||
    ((!session.projectId || !known.has(session.projectId)) && !!session.cwd && sameCwd(session.cwd, project.cwd))
  )
}

export async function removeProject(project: ProjectRecord): Promise<boolean> {
  const state = useStore.getState()
  const settings = state.settings
  if (!settings) return false
  const others = settings.projects.filter((item) => item.id !== project.id)
  const shared = others.some((item) => sameCwd(item.cwd, project.cwd))
  const fallback = others.find((item) => !item.archived)?.cwd
  try {
    await state.patchSettings({
      projects: others,
      projectNames: Object.fromEntries(Object.entries(settings.projectNames).filter(([path]) => shared || !sameCwd(path, project.cwd))),
      recentCwds: settings.recentCwds.filter((path) => shared || !sameCwd(path, project.cwd)),
      ...(!shared && fallback && sameCwd(settings.cwd, project.cwd) ? { cwd: fallback } : {})
    })
  } catch {
    return false
  }
  return !useStore.getState().settings?.projects.some((item) => item.id === project.id || sameCwd(item.cwd, project.cwd))
}

export function ProjectDeleteDialog({ project, name, onClose }: { project: ProjectRecord; name: string; onClose: () => void }): ReactElement {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.settings?.projects ?? [])
  const mine = sessionsOfProject(sessions, projects, project)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (withSessions: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    const state = useStore.getState()
    if (!withSessions && project.archived) {
      for (const session of mine) if (!session.archivedAt) await state.setSessionArchived(session.id, true)
    }
    const ok = await removeProject(project)
    if (!ok) {
      setError(t('rail.deleteProjectFailed'))
      setBusy(false)
      return
    }
    if (withSessions) for (const session of mine) await state.deleteSession(session.path)
    await state.refreshSessions()
    onClose()
  }

  return (
    <ModalOverlay isDismissable={!busy} isOpen onOpenChange={(next) => { if (!next) onClose() }}>
      <Modal>
        <Dialog title={t('rail.deleteProjectTitle')} closeLabel={t('rail.deleteProjectCancel')} data-testid="v3-project-delete">
          {() => (
            <div className="v3-confirm">
              <p className="v3-confirm-body">{t('rail.deleteProjectExplain', { name })}</p>
              {mine.length > 0 ? <p className="v3-confirm-body">{t(project.archived ? 'rail.deleteProjectSessionsArchived' : 'rail.deleteProjectSessions', { n: mine.length })}</p> : null}
              {error ? <Notice tone="fail" compact>{error}</Notice> : null}
              <DialogFooter>
                <Button variant="secondary" onPress={onClose} isDisabled={busy}>{t('rail.deleteProjectCancel')}</Button>
                {mine.length > 0 ? <Button variant="danger" onPress={() => void run(true)} isDisabled={busy} data-testid="v3-project-delete-with-sessions">{t('rail.deleteProjectWithSessions', { n: mine.length })}</Button> : null}
                <Button variant={mine.length > 0 ? 'secondary' : 'danger'} onPress={() => void run(false)} isDisabled={busy} data-testid="v3-project-delete-confirm">
                  {t(mine.length > 0 ? 'rail.deleteProjectKeep' : 'rail.deleteProjectAction')}
                </Button>
              </DialogFooter>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
