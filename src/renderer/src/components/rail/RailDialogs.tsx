import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import type { SessionSummary } from '../../../../shared/ipc'
import { Button, IconButton } from '../ui'

export interface TrashNotice {
  token: string | null
  title: string
  busy: boolean
  error: string
  restored: boolean
  refreshFailed: boolean
}

export function TrashNoticeBar({ notice, onUndo, onClose }: {
  notice: TrashNotice
  onUndo: () => void
  onClose: () => void
}) {
  const t = useT()
  const label = notice.restored
    ? t('rail.restoredNotice')
    : notice.busy
      ? t('rail.restoring')
      : notice.refreshFailed
        ? t('rail.deletedRefreshFailed')
        : t('rail.deletedNotice')

  return (
    <div className="rail-trash" role="status" aria-live="polite" data-testid="trash-notice">
      <Icon name={notice.restored ? 'check' : 'history'} size={12} />
      <span className="rail-trash-text">
        <span>{label}</span>
        {!notice.restored ? (
          <span className="rail-trash-name" title={notice.title}>
            {notice.title}
          </span>
        ) : null}
        {notice.error ? (
          <span className="rail-trash-err" role="alert">
            {notice.error}
          </span>
        ) : null}
      </span>
      <span className="spacer" />
      {!notice.restored && notice.token ? (
        <Button disabled={notice.busy} onClick={onUndo} data-testid="trash-undo">
          {notice.busy ? t('rail.restoring') : t('rail.undoDelete')}
        </Button>
      ) : null}
      <IconButton icon="close" iconSize={12} label={t('rail.noticeDismiss')} onClick={onClose} />
    </div>
  )
}

export function SessionDeleteDialog({ session, onClose, onDeleted }: {
  session: SessionSummary
  onClose: () => void
  onDeleted: (token: string | null, refreshFailed: boolean) => void
}) {
  const t = useT()
  const descendantCount = useStore((state) => {
    const children = new Map<string, string[]>()
    for (const item of state.sessions) {
      if (!item.parentSession) continue
      const list = children.get(item.parentSession) ?? []
      list.push(item.path)
      children.set(item.parentSession, list)
    }
    const walk = (path: string): number => (children.get(path) ?? []).reduce((n, child) => n + 1 + walk(child), 0)
    return walk(session.path)
  })
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirmed = typed.trim() === session.title.trim()

  const panel = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(panel, true, isTop)

  const remove = async (): Promise<void> => {
    if (!confirmed || busy) return
    setBusy(true)
    setError('')
    const res = await window.yan.deleteSession(session.path)
    if (!res.ok) {
      setError(res.error ?? t('rail.deleteFailed'))
      setBusy(false)
      return
    }
    let refreshFailed = false
    try {
      await useStore.getState().refreshSessions()
    } catch {
      refreshFailed = true
    }
    onDeleted(res.undoToken ?? null, refreshFailed)
  }

  return createPortal(
    <div className="modal-scrim rail-delete-scrim" role="dialog" aria-modal="true" aria-labelledby="delete-session-title">
    <div className="modal rail-delete-dialog" ref={panel}>
      <div className="modal-head">
        <Icon name="alert-circle" size={14} />
        <span className="modal-title" id="delete-session-title">{t('rail.deleteTitle')}</span>
      </div>
      <div className="modal-message">
        {t('rail.deleteExplain', { name: session.title })}{descendantCount ? ` ${t('rail.deleteBranches', { n: descendantCount })}` : ''}
      </div>
      <input
        className="modal-input"
        autoFocus
        value={typed}
        placeholder={session.title}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void remove() }}
      />
      {error ? <div className="rail-delete-error" role="alert">{error}</div> : null}
      <div className="modal-foot">
        <Button onClick={onClose} disabled={busy}>{t('ui.cancel')}</Button>
        <span className="spacer" />
        <Button variant="danger" disabled={!confirmed || busy} onClick={() => void remove()}>
          {busy ? t('rail.deleting') : t('rail.deleteAction')}
        </Button>
      </div>
    </div>
  </div>,
    document.body
  )
}

export function ProjectRemoveDialog({ project, onClose, onRemoved }: {
  project: { id: string; name: string }
  onClose: () => void
  onRemoved: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const { isTop } = useModalLayer(true, onClose)
  useFocusTrap(panel, true, isTop)

  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const projects = (useStore.getState().settings?.projects ?? []).map((item) =>
        item.id === project.id ? { ...item, archived: true, updatedAt: Date.now() } : item
      )
      await useStore.getState().patchSettings({ projects })
      onRemoved()
    } catch {
      setError(t('rail.removeProjectFailed'))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-scrim rail-delete-scrim" role="dialog" aria-modal="true" aria-labelledby="remove-project-title">
    <div className="modal rail-delete-dialog" ref={panel}>
      <div className="modal-head">
        <Icon name="alert-circle" size={14} />
        <span className="modal-title" id="remove-project-title">{t('rail.removeProjectTitle')}</span>
      </div>
      <div className="modal-message">{t('rail.removeProjectExplain', { name: project.name })}</div>
      {error ? <div className="rail-delete-error" role="alert">{error}</div> : null}
      <div className="modal-foot">
        <Button onClick={onClose} disabled={busy}>{t('ui.cancel')}</Button>
        <span className="spacer" />
        <Button variant="danger" disabled={busy} onClick={() => void remove()} data-testid="rail-remove-project-confirm">
          {busy ? t('rail.removingProject') : t('rail.removeProjectAction')}
        </Button>
      </div>
    </div>
  </div>,
    document.body
  )
}
