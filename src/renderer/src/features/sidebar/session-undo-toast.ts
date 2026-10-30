import type { TFunc } from '../../i18n'
import { useStore } from '../../state/store'
import { showToast } from '../../ui'
import { viewingSessionPath } from './session-advance'
import { sameSessionPathLoose } from './session-nav'
import { canUndo, claimUndo, createUndoTicket, expireUndo, releaseUndo, SESSION_UNDO_WINDOW_MS, type SessionUndoTicket } from './session-undo'

function offerUndo(ticket: SessionUndoTicket, title: string, t: TFunc, tone: 'info' | 'danger' = 'info'): void {
  showToast(title, {
    tone,
    timeout: SESSION_UNDO_WINDOW_MS,
    action: { label: tone === 'danger' ? t('sidebar.undo.retry') : t('sidebar.undo.action'), onAction: () => void undoDelete(ticket, t) },
    onClose: () => {
      if (canUndo(ticket)) expireUndo(ticket)
    }
  })
}

async function undoDelete(ticket: SessionUndoTicket, t: TFunc): Promise<void> {
  const token = claimUndo(ticket)
  if (!token) return
  const store = useStore.getState()
  const res = await store.restoreDeletedSession(token)
  releaseUndo(ticket, res.ok)
  if (!res.ok) {
    offerUndo(ticket, t('sidebar.undo.failed', { error: res.error ?? t('state.error.restoreFailed') }), t, 'danger')
    return
  }
  showToast(t('sidebar.undo.restored', { name: ticket.title }), { tone: 'success', timeout: 2500 })
  if (sameSessionPathLoose(viewingSessionPath(), ticket.path)) await useStore.getState().switchSession(ticket.path)
}

export async function deleteSessionWithUndo(path: string, title: string, t: TFunc): Promise<void> {
  const res = await useStore.getState().deleteSession(path)
  if (!res.ok) return
  const ticket = createUndoTicket(res.undoToken, path, title)
  if (!ticket) return
  offerUndo(ticket, t('sidebar.undo.deleted', { name: title }), t)
}
