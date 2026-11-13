import { useState, type JSX } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, DialogFooter, Modal, ModalOverlay, Notice } from '../../ui'
import { v3Text } from '../../app/v3-text'
import type { ProjectRecord } from '../../../../shared/ipc'
import { warnIfWorkspaceUnfit } from '../../lib/workspace-fit'
import { sameCwd } from './sidebar-model'

export async function setProjectArchived(projectId: string, archived: boolean): Promise<boolean> {
  const store = useStore.getState()
  const projects = (store.settings?.projects ?? []).map((item) =>
    item.id === projectId ? { ...item, archived, updatedAt: Date.now() } : item
  )
  try {
    await store.patchSettings({ projects })
    return true
  } catch {
    return false
  }
}

export async function ensureProjectForCwd(cwd: string): Promise<ProjectRecord | undefined> {
  const find = (): ProjectRecord | undefined => useStore.getState().settings?.projects.find((item) => sameCwd(item.cwd, cwd))
  const existing = find()
  if (existing) return existing
  const recent = useStore.getState().settings?.recentCwds ?? []
  try {
    await useStore.getState().patchSettings({ recentCwds: [cwd, ...recent.filter((item) => item !== cwd)] })
  } catch {
    return undefined
  }
  return find()
}

export function ArchiveConfirm({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => Promise<boolean> }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = v3Text(lang)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="v3-confirm">
      <p className="v3-confirm-body">{t('rail.removeProjectExplain', { name })}</p>
      {error ? <Notice tone="fail" compact>{error}</Notice> : null}
      <DialogFooter>
        <Button variant="secondary" onPress={onCancel} isDisabled={busy}>{text.cancel}</Button>
        <Button
          variant="danger"
          isDisabled={busy}
          onPress={async () => {
            setBusy(true)
            setError('')
            const ok = await onConfirm()
            if (!ok) {
              setError(t('rail.removeProjectFailed'))
              setBusy(false)
            }
          }}
          data-testid="v3-project-archive-confirm"
        >
          {busy ? t('rail.removingProject') : t('rail.removeProjectAction')}
        </Button>
      </DialogFooter>
    </div>
  )
}

export function ProjectDirectoryDialog({ project, onClose }: { project: ProjectRecord; onClose: () => void }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = v3Text(lang)
  const [cwd, setCwd] = useState(project.cwd)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (close: () => void): Promise<void> => {
    if (busy || !cwd.trim()) return
    setBusy(true)
    setError('')
    try {
      const result = await window.yan.changeProjectDirectory({ projectId: project.id, expectedCwd: project.cwd, cwd })
      if (!result.ok) {
        setError(result.error)
        return
      }
      useStore.getState().applyServerSettings(result.settings)
      void useStore.getState().refreshSessions()
      warnIfWorkspaceUnfit(cwd.trim(), t)
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalOverlay isDismissable isOpen onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal>
        <Dialog title={t('rail.changeDirectory')} closeLabel={text.cancel} data-testid="v3-project-directory">
          {({ close }) => (
            <div className="v3-confirm">
              <p className="v3-confirm-body">{t('rail.directoryProject', { name: project.name || project.cwd })}</p>
              <p className="v3-confirm-body">{t('rail.directoryDescription')}</p>
              <label className="v3-field">
                <span className="v3-field-label">{t('rail.directoryOld')}</span>
                <input className="ui-input" value={project.cwd} readOnly tabIndex={-1} />
              </label>
              <label className="v3-field">
                <span className="v3-field-label">{t('rail.directoryNew')}</span>
                <span className="v3-field-row">
                  <input
                    className="ui-input"
                    value={cwd}
                    disabled={busy}
                    autoFocus
                    onChange={(event) => setCwd(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void save(close)
                      }
                    }}
                    data-testid="v3-project-directory-input"
                  />
                  <Button
                    variant="secondary"
                    isDisabled={busy}
                    onPress={async () => {
                      const selected = await window.yan.pickCwd().catch(() => null)
                      if (selected) setCwd(selected)
                    }}
                  >
                    {t('rail.directoryBrowse')}
                  </Button>
                </span>
              </label>
              {error ? <Notice tone="fail" compact data-testid="v3-project-directory-error">{error}</Notice> : null}
              <DialogFooter>
                <Button variant="secondary" onPress={close}>{text.cancel}</Button>
                <Button variant="primary" isDisabled={busy || !cwd.trim()} onPress={() => void save(close)} data-testid="v3-project-directory-save">
                  {busy ? t('rail.directorySaving') : t('rail.directorySave')}
                </Button>
              </DialogFooter>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
