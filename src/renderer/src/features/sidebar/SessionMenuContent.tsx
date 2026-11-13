import type { JSX } from 'react'
import { Eye, FileCode, FileText, FolderInput, FolderOpen, Globe, Mail, MailOpen, Package, Pencil, Pin, PinOff, Archive, ArchiveRestore, Sparkles, Trash2, Upload } from '../../ui/icons'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Menu, MenuItem, MenuSeparator, Popover, SubmenuTrigger } from '../../ui'
import { v3Text } from '../../app/v3-text'
import { shortProject } from './sidebar-model'
import { useTranscriptViews } from '../../state/transcript-view'
import { effectiveView, TRANSCRIPT_VIEWS, type TranscriptView } from '../session/transcript-view-model'
import { transcriptViewText } from '../session/transcript-view-text'
import type { MenuKey, SessionMenuProps } from './SessionMenu'

export function SessionMenuContent({ item, isCurrent, pointAnchor, onOpenChange, onAction }: SessionMenuProps & { onAction: (key: MenuKey) => void }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = v3Text(lang)
  const projects = useStore((s) => s.settings?.projects)
  const moveTargets = (projects ?? []).filter((project) => !project.archived && project.id !== item.projectId)
  const viewText = transcriptViewText(lang)
  const currentView = useTranscriptViews((s) => effectiveView(s, item.id))
  const defaultView = useTranscriptViews((s) => s.defaultView)

  return (
    <Menu
      aria-label={text.sessionMenu}
      autoFocus={pointAnchor ? true : 'first'}
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
      <SubmenuTrigger>
        <MenuItem id="transfer" textValue={t('rail.transfer')} data-testid="v3-session-transfer" icon={<Upload size={14} />}>
          {t('rail.transfer')}
        </MenuItem>
        <Popover placement="end top" offset={2}>
          <Menu
            aria-label={t('rail.transfer')}
            onAction={(key) => {
              onOpenChange(false)
              onAction(key as MenuKey)
            }}
            data-testid="v3-session-transfer-menu"
          >
            <MenuItem id="export:markdown" textValue={t('rail.exportMarkdown')} icon={<FileText size={14} />}>
              {t('rail.exportMarkdown')}
            </MenuItem>
            <MenuItem id="export:html" textValue={t('rail.exportHtml')} icon={<FileCode size={14} />}>
              {t('rail.exportHtml')}
            </MenuItem>
            <MenuItem id="export:bundle" textValue={t('rail.exportBundle')} icon={<Package size={14} />}>
              {t('rail.exportBundle')}
            </MenuItem>
          </Menu>
        </Popover>
      </SubmenuTrigger>
      <MenuSeparator />
      <MenuItem id="rename" textValue={t('rail.rename')} icon={<Pencil size={14} />}>
        {t('rail.rename')}
      </MenuItem>
      <MenuItem id="pin" textValue={item.pinned ? t('rail.unpin') : t('rail.pin')} icon={item.pinned ? <PinOff size={14} /> : <Pin size={14} />}>
        {item.pinned ? t('rail.unpin') : t('rail.pin')}
      </MenuItem>
      <MenuItem id="unread" textValue={item.markedUnread ? t('rail.markRead') : t('rail.markUnread')} data-testid="v3-session-mark-unread" icon={item.markedUnread ? <MailOpen size={14} /> : <Mail size={14} />}>
        {item.markedUnread ? t('rail.markRead') : t('rail.markUnread')}
      </MenuItem>
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
      <MenuItem id="title" textValue={t('rail.regenerateTitle')} icon={<Sparkles size={14} />}>
        {t('rail.regenerateTitle')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem id="archive" textValue={t(item.archivedAt ? 'rail.unarchive' : 'rail.archive')} icon={item.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}>
        {t(item.archivedAt ? 'rail.unarchive' : 'rail.archive')}
      </MenuItem>
      <MenuItem id="delete" textValue={t('rail.delete')} tone="danger" icon={<Trash2 size={14} />} disabledReason={isCurrent ? t('rail.cantDeleteCurrent') : undefined}>
        {t('rail.delete')}
      </MenuItem>
    </Menu>
  )
}
