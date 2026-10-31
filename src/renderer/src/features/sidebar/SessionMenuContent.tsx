import type { JSX } from 'react'
import { AlarmClock, Clock, Columns2, Eye, FolderInput, FolderOpen, Globe, Mail, MailOpen, Pencil, Pin, PinOff, Archive, ArchiveRestore, Rows2, Sparkles, SquareArrowOutUpRight, Trash2, X } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { indexOfSession, useSplitView } from '../../state/split-view'
import { splitText } from '../split/split-text'
import { Menu, MenuItem, Popover, SubmenuTrigger } from '../../ui'
import { v3Text } from '../../app/v3-text'
import { shortProject } from './sidebar-model'
import { useTranscriptViews } from '../../state/transcript-view'
import { effectiveView, TRANSCRIPT_VIEWS, type TranscriptView } from '../session/transcript-view-model'
import { transcriptViewText } from '../session/transcript-view-text'
import { formatSnoozeWake, isSnoozed, resolveSnoozeOptions } from './session-snooze'
import type { MenuKey, SessionMenuProps } from './SessionMenu'

export function SessionMenuContent({ item, isCurrent, onOpenChange, onAction }: SessionMenuProps & { onAction: (key: MenuKey) => void }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = v3Text(lang)
  const projects = useStore((s) => s.settings?.projects)
  const moveTargets = (projects ?? []).filter((project) => !project.archived && project.id !== item.projectId)
  const viewText = transcriptViewText(lang)
  const currentView = useTranscriptViews((s) => effectiveView(s, item.id))
  const defaultView = useTranscriptViews((s) => s.defaultView)
  const snoozed = isSnoozed(item, Date.now())
  const snoozeOptions = snoozed ? [] : resolveSnoozeOptions(Date.now())
  const split = splitText(lang)
  const splitIndex = useSplitView((s) => (s.split ? indexOfSession(s.split.tiles, { sessionId: item.id, path: item.path }) : -1))

  return (
    <Menu
      aria-label={text.sessionMenu}
      autoFocus="first"
      onAction={(key) => onAction(key as MenuKey)}
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
                onAction(key as MenuKey)
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
      <SubmenuTrigger>
        <MenuItem id="open-with" textValue={split.openWith} data-testid="v3-session-open-with" icon={<SquareArrowOutUpRight size={14} />}>
          {split.openWith}
        </MenuItem>
        <Popover placement="end top" offset={2}>
          <Menu
            aria-label={split.openWith}
            onAction={(key) => {
              onOpenChange(false)
              onAction(key as MenuKey)
            }}
            disabledKeys={isCurrent && splitIndex < 0 ? ['split', 'split-below'] : []}
            data-testid="v3-session-open-with-menu"
          >
            {splitIndex >= 0 ? (
              <MenuItem id="split-close" textValue={t('split.closeSide')} icon={<X size={14} />}>
                {t('split.closeSide')}
              </MenuItem>
            ) : (
              <MenuItem id="split" textValue={split.openInSplit} icon={<Columns2 size={14} />}>
                {split.openInSplit}
              </MenuItem>
            )}
            {splitIndex < 0 ? (
              <MenuItem id="split-below" textValue={split.openBelow} icon={<Rows2 size={14} />}>
                {split.openBelow}
              </MenuItem>
            ) : null}
          </Menu>
        </Popover>
      </SubmenuTrigger>
      {item.scope !== 'global' || moveTargets.length > 0 ? (
        <SubmenuTrigger>
          <MenuItem id="move" textValue={t('rail.moveTo')} data-testid="v3-session-move" icon={<FolderInput size={14} />}>
            {t('rail.moveTo')}
          </MenuItem>
          <Popover placement="end top" offset={2}>
            <Menu
              aria-label={t('rail.moveTo')}
              onAction={(key) => {
                onOpenChange(false)
                onAction(key as MenuKey)
              }}
              data-testid="v3-session-move-menu"
            >
              {item.scope !== 'global' ? (
                <MenuItem id="move:global" textValue={t('rail.global')} icon={<Globe size={14} />}>
                  {t('rail.global')}
                </MenuItem>
              ) : null}
              {moveTargets.map((project) => (
                <MenuItem key={project.id} id={`move:${project.id}`} textValue={project.name || shortProject(project.cwd)} icon={<FolderInput size={14} />}>
                  {project.name || shortProject(project.cwd)}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </SubmenuTrigger>
      ) : null}
      <MenuItem id="delete" textValue={t('rail.delete')} tone="danger" icon={<Trash2 size={14} />}>
        {isCurrent ? t('rail.cantDeleteCurrent') : t('rail.delete')}
      </MenuItem>
    </Menu>
  )
}
