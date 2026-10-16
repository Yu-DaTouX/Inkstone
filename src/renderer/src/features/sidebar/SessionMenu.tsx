import { useState, type JSX, type RefObject } from 'react'
import { Columns2, FolderInput, FolderOpen, Globe, Pencil, Pin, PinOff, Archive, Sparkles, Trash2 } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { displayedSessionOf, useSplitView } from '../../state/split-view'
import { Button, Dialog, Menu, MenuItem, Modal, ModalOverlay, Popover } from '../../ui'
import { v3Text } from '../../app/v3-text'
import { shortProject } from './sidebar-model'
import type { SessionSummary } from '../../../../shared/ipc'

export function openSessionInSplit(item: { id: string; path: string }, at?: number): void {
  const current = displayedSessionOf(useStore.getState())
  useSplitView.getState().open({ sessionId: item.id, path: item.path }, current, at)
}

type MenuKey = `move:${string}` | 'split' | 'rename' | 'pin' | 'archive' | 'title' | 'reveal' | 'delete'

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
  const t = useT()
  const { lang } = useI18n()
  const text = v3Text(lang)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const projects = useStore((s) => s.settings?.projects)
  const moveTargets = (projects ?? []).filter((project) => !project.archived && project.id !== item.projectId)

  const run = (key: MenuKey): void => {
    const store = useStore.getState()
    if (key.startsWith('move:')) {
      const target = key.slice('move:'.length)
      void store.moveSession(item.id, target === 'global' ? null : target)
      return
    }
    switch (key) {
      case 'split':
        openSessionInSplit(item)
        return
      case 'rename':
        onRename()
        return
      case 'pin':
        void store.setSessionPinned(item.id, !item.pinned)
        return
      case 'archive':
        void store.setSessionArchived(item.id, true)
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
        <Menu
          aria-label={text.sessionMenu}
          autoFocus="first"
          onAction={(key) => run(key as MenuKey)}
          onClose={() => onOpenChange(false)}
          disabledKeys={isCurrent ? ['split', 'delete'] : []}
          data-testid="v3-session-menu"
        >
          <MenuItem id="split" textValue={t('rail.openSplit')}>
            <Columns2 size={14} aria-hidden />
            {t('rail.openSplit')}
          </MenuItem>
          <MenuItem id="rename" textValue={t('rail.rename')}>
            <Pencil size={14} aria-hidden />
            {t('rail.rename')}
          </MenuItem>
          <MenuItem id="pin" textValue={item.pinned ? t('rail.unpin') : t('rail.pin')}>
            {item.pinned ? <PinOff size={14} aria-hidden /> : <Pin size={14} aria-hidden />}
            {item.pinned ? t('rail.unpin') : t('rail.pin')}
          </MenuItem>
          <MenuItem id="title" textValue={t('rail.regenerateTitle')}>
            <Sparkles size={14} aria-hidden />
            {t('rail.regenerateTitle')}
          </MenuItem>
          <MenuItem id="archive" textValue={t('rail.archive')}>
            <Archive size={14} aria-hidden />
            {t('rail.archive')}
          </MenuItem>
          {item.scope !== 'global' ? (
            <MenuItem id="move:global" textValue={`${t('rail.moveSession')} ${t('rail.global')}`}>
              <Globe size={14} aria-hidden />
              {t('rail.moveSession')} · {t('rail.global')}
            </MenuItem>
          ) : null}
          {moveTargets.map((project) => (
            <MenuItem key={project.id} id={`move:${project.id}`} textValue={`${t('rail.moveSession')} ${project.name || shortProject(project.cwd)}`}>
              <FolderInput size={14} aria-hidden />
              {t('rail.moveSession')} · {project.name || shortProject(project.cwd)}
            </MenuItem>
          ))}
          <MenuItem id="reveal" textValue={t('rail.reveal')}>
            <FolderOpen size={14} aria-hidden />
            {t('rail.reveal')}
          </MenuItem>
          <MenuItem id="delete" textValue={t('rail.delete')} className="v3-menu-danger">
            <Trash2 size={14} aria-hidden />
            {isCurrent ? t('rail.cantDeleteCurrent') : t('rail.delete')}
          </MenuItem>
        </Menu>
      </Popover>

      <ModalOverlay isDismissable isOpen={confirmDelete} onOpenChange={setConfirmDelete}>
        <Modal>
          <Dialog title={text.deleteConfirmTitle} closeLabel={text.cancel} data-testid="v3-session-delete">
            {({ close }) => (
              <div className="v3-confirm">
                <p className="v3-confirm-body">{text.deleteConfirmBody.replace('{name}', title)}</p>
                <div className="v3-confirm-actions">
                  <Button variant="secondary" onPress={close}>{text.cancel}</Button>
                  <Button
                    variant="danger"
                    onPress={() => {
                      close()
                      void useStore.getState().deleteSession(item.path)
                    }}
                    data-testid="v3-session-delete-confirm"
                  >
                    {text.deleteConfirm}
                  </Button>
                </div>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  )
}
