import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectRecord } from '../../../../shared/ipc'
import { useT } from '../../i18n'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import { useStore } from '../../state/store'
import { Button, Input } from '../ui'

export function ProjectDirectoryDialog({ project, onClose }: { project: ProjectRecord; onClose: () => void }) {
  const t = useT()
  const [cwd, setCwd] = useState(project.cwd)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const dialog = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => useStore.getState().acquireOverlayBlocker('project-directory'), [])
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(dialog, true, isTop)

  useEffect(() => {
    let frames = 0
    let raf = 0
    const pull = (): void => {
      if (!mounted.current) return
      if (!dialog.current?.contains(document.activeElement)) input.current?.focus()
      frames += 1
      if (frames < 5) raf = requestAnimationFrame(pull)
    }
    raf = requestAnimationFrame(pull)
    return () => cancelAnimationFrame(raf)
  }, [])

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const save = (): void => {
    if (!cwd.trim()) return
    void run(async () => {
      const result = await window.yan.changeProjectDirectory({ projectId: project.id, expectedCwd: project.cwd, cwd })
      if (!mounted.current) return
      if (!result.ok) { setError(result.error); return }
      useStore.getState().applyServerSettings(result.settings)
      void useStore.getState().refreshSessions()
      onClose()
    })
  }

  return createPortal(
    <div
      className="modal-scrim"
      role="presentation"
      data-testid="project-directory-mask"
      onPointerDown={(event) => { if (event.target === event.currentTarget && isTop) onClose() }}
    >
      <div
        ref={dialog}
        className="modal project-directory-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-directory-title"
        aria-describedby="project-directory-description"
        aria-busy={busy}
      >
        <header className="modal-head"><strong className="modal-title" id="project-directory-title">{t('rail.changeDirectory')}</strong></header>
        <p className="modal-message">{t('rail.directoryProject', { name: project.name || project.cwd })}</p>
        <p className="modal-message" id="project-directory-description">{t('rail.directoryDescription')}</p>
        <div className="project-directory-field">
          <label htmlFor="project-directory-old">{t('rail.directoryOld')}</label>
          <Input id="project-directory-old" value={project.cwd} readOnly tabIndex={-1} />
        </div>
        <div className="project-directory-field">
          <label htmlFor="project-directory-new">{t('rail.directoryNew')}</label>
          <Input
            ref={input}
            id="project-directory-new"
            data-testid="project-directory-input"
            value={cwd}
            disabled={busy}
            onChange={(event) => setCwd(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); save() }
            }}
          />
          <Button
            data-testid="project-directory-browse"
            disabled={busy}
            onClick={() => { void run(async () => {
              const selected = await window.yan.pickCwd()
              if (selected && mounted.current) setCwd(selected)
            }) }}
          >{t('rail.directoryBrowse')}</Button>
        </div>
        {error ? <p className="rail-delete-error" role="alert" data-testid="project-directory-error">{error}</p> : null}
        <footer className="modal-foot">
          <Button data-testid="project-directory-cancel" onClick={onClose}>{t('ui.cancel')}</Button>
          <Button variant="primary" disabled={busy || !cwd.trim()} data-testid="project-directory-save" onClick={save}>
            {busy ? t('rail.directorySaving') : t('rail.directorySave')}
          </Button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
