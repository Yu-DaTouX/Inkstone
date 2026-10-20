import { useState, type JSX, type RefObject } from 'react'
import { Columns2, FolderInput, FolderOpen, Globe, Pencil, Pin, PinOff, Archive, Rows2, Sparkles, SquareArrowOutUpRight, Trash2, X } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { indexOfSession, useSplitView } from '../../state/split-view'
import { Button, Dialog, Menu, MenuItem, Modal, ModalOverlay, Popover, SubmenuTrigger } from '../../ui'
import { v3Text } from '../../app/v3-text'
import { shortProject } from './sidebar-model'
import type { SessionSummary } from '../../../../shared/ipc'

import { closeSplitPane, openSessionInSplit as openInSplit } from '../split/split-actions'
import { splitText } from '../split/split-text'

export function openSessionInSplit(item: { id: string; path: string }): void {
  openInSplit(item)
}

type MenuKey = `move:${string}` | 'split' | 'split-below' | 'split-close' | 'rename' | 'pin' | 'archive' | 'title' | 'reveal' | 'delete'

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
  const split = splitText(lang)
  const splitIndex = useSplitView((s) => (s.split ? indexOfSession(s.split.tiles, { sessionId: item.id, path: item.path }) : -1))

  const run = (key: MenuKey): void => {
    const store = useStore.getState()
    if (key.startsWith('move:')) {
      const target = key.slice('move:'.length)
      void store.moveSession(item.id, target === 'global' ? null : target)
      return
    }
    switch (key) {
      case 'split':
        openInSplit(item)
        return
      case 'split-below':
        openInSplit(item, 'below')
        return
      case 'split-close':
        if (splitIndex >= 0) closeSplitPane(splitIndex)
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
          disabledKeys={isCurrent ? ['delete'] : []}
          data-testid="v3-session-menu"
        >
          <SubmenuTrigger>
            <MenuItem id="open-with" textValue={split.openWith} data-testid="v3-session-open-with">
              <SquareArrowOutUpRight size={14} aria-hidden />
              {split.openWith}
            </MenuItem>
            <Popover placement="end top" offset={2}>
              <Menu
                aria-label={split.openWith}
                onAction={(key) => {
                  onOpenChange(false)
                  run(key as MenuKey)
                }}
                disabledKeys={isCurrent && splitIndex < 0 ? ['split', 'split-below'] : []}
                data-testid="v3-session-open-with-menu"
              >
                {splitIndex >= 0 ? (
                  <MenuItem id="split-close" textValue={t('split.closeSide')}>
                    <X size={14} aria-hidden />
                    {t('split.closeSide')}
                  </MenuItem>
                ) : (
                  <MenuItem id="split" textValue={split.openInSplit}>
                    <Columns2 size={14} aria-hidden />
                    {split.openInSplit}
                  </MenuItem>
                )}
                {splitIndex < 0 ? (
                  <MenuItem id="split-below" textValue={split.openBelow}>
                    <Rows2 size={14} aria-hidden />
                    {split.openBelow}
                  </MenuItem>
                ) : null}
                <MenuItem id="reveal" textValue={t('rail.reveal')}>
                  <FolderOpen size={14} aria-hidden />
                  {t('rail.reveal')}
                </MenuItem>
              </Menu>
            </Popover>
          </SubmenuTrigger>
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
