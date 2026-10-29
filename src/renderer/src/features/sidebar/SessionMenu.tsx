import { useState, type JSX, type RefObject } from 'react'
import { AlarmClock, Clock, Eye, FolderInput, FolderOpen, Globe, Mail, MailOpen, Pencil, Pin, PinOff, Archive, ArchiveRestore, Sparkles, Trash2 } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Dialog, DialogFooter, Menu, MenuItem, Modal, ModalOverlay, Popover, SubmenuTrigger } from '../../ui'
import { v3Text } from '../../app/v3-text'
import { shortProject } from './sidebar-model'
import type { SessionSummary } from '../../../../shared/ipc'

import { useTranscriptViews } from '../../state/transcript-view'
import { effectiveView, TRANSCRIPT_VIEWS, type TranscriptView } from '../session/transcript-view-model'
import { transcriptViewText } from '../session/transcript-view-text'
import { markSessionRunsSeen } from '../../state/use-current-runs-seen'
import { formatSnoozeWake, isSnoozed, pickSnoozeOption, resolveSnoozeOptions } from './session-snooze'
import { CustomSnoozeDialog } from './CustomSnoozeDialog'

type MenuKey = `move:${string}` | `snooze:${string}` | 'rename' | 'pin' | 'archive' | 'title' | 'reveal' | 'delete' | 'wake' | 'unread'

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
  const [customSnooze, setCustomSnooze] = useState(false)
  const projects = useStore((s) => s.settings?.projects)
  const moveTargets = (projects ?? []).filter((project) => !project.archived && project.id !== item.projectId)
  const viewText = transcriptViewText(lang)
  const currentView = useTranscriptViews((s) => effectiveView(s, item.id))
  const defaultView = useTranscriptViews((s) => s.defaultView)
  const snoozed = isSnoozed(item, Date.now())
  const snoozeOptions = snoozed ? [] : resolveSnoozeOptions(Date.now())

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
      if (option) void store.setSessionSnoozed(item.id, option.until)
      return
    }
    switch (key) {
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
        void store.setSessionArchived(item.id, !item.archivedAt)
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
          <MenuItem id="reveal" textValue={t('rail.reveal')} data-testid="v3-session-reveal" icon={<FolderOpen size={14} />}>
            {t('rail.reveal')}
          </MenuItem>
          <SubmenuTrigger>
            <MenuItem id="transcript-view" textValue={viewText.menu} data-testid="v3-session-transcript-view" icon={<Eye size={14} />}>
              {viewText.menu} · {viewText.views[currentView]}
            </MenuItem>
            <Popover placement="end top" offset={2}>
              <Menu
                aria-label={viewText.menu}
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[currentView]}
                onAction={(key) => {
                  onOpenChange(false)
                  const store = useTranscriptViews.getState()
                  if (key === 'make-default') store.setDefaultView(currentView)
                  else store.setSessionView(item.id, key as TranscriptView)
                }}
                data-testid="v3-session-transcript-view-menu"
              >
                {TRANSCRIPT_VIEWS.map((view) => (
                  <MenuItem key={view} id={view} textValue={viewText.views[view]} checked="selection">
                    {viewText.views[view]}
                  </MenuItem>
                ))}
                {currentView !== defaultView ? (
                  <MenuItem id="make-default" textValue={viewText.makeDefault(viewText.views[currentView])}>
                    {viewText.makeDefault(viewText.views[currentView])}
                  </MenuItem>
                ) : null}
              </Menu>
            </Popover>
          </SubmenuTrigger>
          <MenuItem id="rename" textValue={t('rail.rename')} icon={<Pencil size={14} />}>
            {t('rail.rename')}
          </MenuItem>
          <MenuItem id="pin" textValue={item.pinned ? t('rail.unpin') : t('rail.pin')} icon={item.pinned ? <PinOff size={14} /> : <Pin size={14} />}>
            {item.pinned ? t('rail.unpin') : t('rail.pin')}
          </MenuItem>
          {snoozed ? (
            <MenuItem id="wake" textValue={t('rail.wakeNow')} data-testid="v3-session-wake" icon={<AlarmClock size={14} />}>
              {t('rail.wakeNow')}
            </MenuItem>
          ) : (
            <SubmenuTrigger>
              <MenuItem id="snooze" textValue={t('rail.snooze')} data-testid="v3-session-snooze" icon={<Clock size={14} />}>
                {t('rail.snooze')}
              </MenuItem>
              <Popover placement="end top" offset={2}>
                <Menu
                  aria-label={t('rail.snooze')}
                  onAction={(key) => {
                    onOpenChange(false)
                    run(key as MenuKey)
                  }}
                  data-testid="v3-session-snooze-menu"
                >
                  {snoozeOptions.map((option) => {
                    const wake = formatSnoozeWake(option.until, Date.now(), lang)
                    return (
                      <MenuItem key={option.id} id={`snooze:${option.id}`} textValue={`${t(option.labelKey)} ${wake}`}>
                        {t(option.labelKey)}
                        <span className="v3-menu-when">{wake}</span>
                      </MenuItem>
                    )
                  })}
                  <MenuItem id="snooze:custom" textValue={t('rail.snoozeCustom')} data-testid="v3-session-snooze-custom">
                    {t('rail.snoozeCustom')}
                  </MenuItem>
                </Menu>
              </Popover>
            </SubmenuTrigger>
          )}
          <MenuItem id="unread" textValue={item.markedUnread ? t('rail.markRead') : t('rail.markUnread')} data-testid="v3-session-mark-unread" icon={item.markedUnread ? <MailOpen size={14} /> : <Mail size={14} />}>
            {item.markedUnread ? t('rail.markRead') : t('rail.markUnread')}
          </MenuItem>
          <MenuItem id="title" textValue={t('rail.regenerateTitle')} icon={<Sparkles size={14} />}>
            {t('rail.regenerateTitle')}
          </MenuItem>
          <MenuItem id="archive" textValue={t(item.archivedAt ? 'rail.unarchive' : 'rail.archive')} icon={item.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}>
            {t(item.archivedAt ? 'rail.unarchive' : 'rail.archive')}
          </MenuItem>
          {item.scope !== 'global' ? (
            <MenuItem id="move:global" textValue={`${t('rail.moveSession')} ${t('rail.global')}`} icon={<Globe size={14} />}>
              {t('rail.moveSession')} · {t('rail.global')}
            </MenuItem>
          ) : null}
          {moveTargets.map((project) => (
            <MenuItem key={project.id} id={`move:${project.id}`} textValue={`${t('rail.moveSession')} ${project.name || shortProject(project.cwd)}`} icon={<FolderInput size={14} />}>
              {t('rail.moveSession')} · {project.name || shortProject(project.cwd)}
            </MenuItem>
          ))}
          <MenuItem id="delete" textValue={t('rail.delete')} tone="danger" icon={<Trash2 size={14} />}>
            {isCurrent ? t('rail.cantDeleteCurrent') : t('rail.delete')}
          </MenuItem>
        </Menu>
      </Popover>

      <CustomSnoozeDialog
        open={customSnooze}
        onOpenChange={setCustomSnooze}
        onSubmit={(until) => void useStore.getState().setSessionSnoozed(item.id, until)}
      />

      <ModalOverlay isDismissable isOpen={confirmDelete} onOpenChange={setConfirmDelete}>
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
                      void useStore.getState().deleteSession(item.path)
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
