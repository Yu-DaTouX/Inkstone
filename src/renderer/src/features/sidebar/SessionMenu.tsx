import { useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, DialogFooter, Modal, ModalOverlay, Popover } from '../../ui'
import { leaveSessionAfter } from './session-advance'
import { deleteSessionWithUndo } from './session-undo-toast'
import { v3Text } from '../../app/v3-text'
import type { SessionSummary } from '../../../../shared/ipc'
import { markSessionRunsSeen } from '../../state/use-current-runs-seen'
import { indexOfSession, useSplitView } from '../../state/split-view'
import { closeSplitPane, openSessionInSplit } from '../split/split-actions'
import { pickSnoozeOption } from './session-snooze'
import { CustomSnoozeDialog } from './CustomSnoozeDialog'
import { SessionMenuContent } from './SessionMenuContent'

export type MenuKey = `move:${string}` | `snooze:${string}` | 'split' | 'split-below' | 'split-close' | 'rename' | 'pin' | 'archive' | 'title' | 'reveal' | 'delete' | 'wake' | 'unread'

export interface SessionMenuProps {
  item: SessionSummary
  title: string
  isCurrent: boolean
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
  onRename: () => void
}

export function SessionMenu({ item, title, isCurrent, anchor, open, onOpenChange, onRename }: SessionMenuProps): JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  const t = useT()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [customSnooze, setCustomSnooze] = useState(false)
  const dialogOpen = confirmDelete || customSnooze
  const [dialogReady, setDialogReady] = useState(false)
  useEffect(() => {
    setDialogReady(false)
    if (!dialogOpen || open) return
    let frame = 0
    let idle = 0
    const settle = (): void => {
      idle = document.querySelector('.ui-popover') ? 0 : idle + 1
      if (idle < 2) {
        frame = requestAnimationFrame(settle)
        return
      }
      setDialogReady(true)
    }
    frame = requestAnimationFrame(settle)
    return () => cancelAnimationFrame(frame)
  }, [dialogOpen, open])
  const hadDialog = useRef(false)
  useEffect(() => {
    const restore = hadDialog.current && !dialogOpen
    hadDialog.current = dialogOpen
    if (!restore) return
    let frame = 0
    let idle = 0
    const focus = (): void => {
      idle = document.querySelector('[role="dialog"], .ui-popover') ? 0 : idle + 1
      if (idle < 2) {
        frame = requestAnimationFrame(focus)
        return
      }
      anchor.current?.querySelector<HTMLElement>('.v3-row')?.focus()
    }
    frame = requestAnimationFrame(focus)
    return () => cancelAnimationFrame(frame)
  }, [dialogOpen, anchor])

  const run = (key: MenuKey): void => {
    const store = useStore.getState()
    if (key.startsWith('move:')) {
      const target = key.slice('move:'.length)
      void store.moveSession(item.id, target === 'global' ? null : target)
      return
    }
    if (key.startsWith('snooze:')) {
      const preset = key.slice('snooze:'.length)
      if (preset === 'custom') {
        setCustomSnooze(true)
        return
      }
      const option = pickSnoozeOption(preset, Date.now())
      if (option) void leaveSessionAfter(item.path, () => store.setSessionSnoozed(item.id, option.until))
      return
    }
    switch (key) {
      case 'split':
        openSessionInSplit(item)
        return
      case 'split-below':
        openSessionInSplit(item, 'below')
        return
      case 'split-close': {
        const split = useSplitView.getState().split
        const index = split ? indexOfSession(split.tiles, { sessionId: item.id, path: item.path }) : -1
        if (index >= 0) closeSplitPane(index)
        return
      }
      case 'wake':
        void store.setSessionSnoozed(item.id, null)
        return
      case 'unread':
        if (item.markedUnread) {
          markSessionRunsSeen({ id: item.id, path: item.path })
          void store.setSessionMarkedUnread(item.id, false)
        } else {
          void store.setSessionMarkedUnread(item.id, true)
        }
        return
      case 'rename':
        onRename()
        return
      case 'pin':
        void store.setSessionPinned(item.id, !item.pinned)
        return
      case 'archive':
        if (item.archivedAt) void store.setSessionArchived(item.id, false)
        else void leaveSessionAfter(item.path, () => store.setSessionArchived(item.id, true))
        return
      case 'title':
        void store.regenerateTitle(item.id)
        return
      case 'reveal':
        void window.yan.revealPath(item.path)
        return
      case 'delete':
        setConfirmDelete(true)
    }
  }

  return (
    <>
      <Popover triggerRef={anchor} isOpen={open} onOpenChange={onOpenChange} placement="bottom end" offset={4}>
        {open ? <SessionMenuContent item={item} title={title} isCurrent={isCurrent} anchor={anchor} open={open} onOpenChange={onOpenChange} onRename={onRename} onAction={run} /> : null}
      </Popover>

      <CustomSnoozeDialog
        open={customSnooze && dialogReady}
        onOpenChange={setCustomSnooze}
        onSubmit={(until) => void leaveSessionAfter(item.path, () => useStore.getState().setSessionSnoozed(item.id, until))}
      />

      <ModalOverlay isDismissable isOpen={confirmDelete && dialogReady} onOpenChange={setConfirmDelete}>
        <Modal>
          <Dialog title={text.deleteConfirmTitle} closeLabel={text.cancel} data-testid="v3-session-delete">
            {({ close }) => (
              <div className="v3-confirm">
                <p className="v3-confirm-body">{text.deleteConfirmBody.replace('{name}', title)}</p>
                <DialogFooter>
                  <Button variant="secondary" onPress={close}>{text.cancel}</Button>
                  <Button
                    variant="danger"
                    onPress={() => {
                      close()
                      void deleteSessionWithUndo(item.path, title, t)
                    }}
                    data-testid="v3-session-delete-confirm"
                  >
                    {text.deleteConfirm}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  )
}
