import { memo } from 'react'
import { shallow } from 'zustand/shallow'
import { useT } from '../../i18n'
import { openSidebarSession } from '../../features/sidebar/session-advance'
import { startSessionRowDrag } from '../../features/sidebar/session-drag'
import { sidebarActions } from '../adapters/sidebar'
import {
  SidebarThreadRow,
  type SidebarThreadRowProps,
  type SidebarThreadRowView
} from '../components/sidebar/SidebarThreadRow'

export function openSidebarThread(thread: { id: string; path: string; snoozedUntil: string | null }): void {
  if (thread.snoozedUntil !== null) void sidebarActions.unsnooze({ environmentId: 'local', threadId: thread.id })
  void openSidebarSession({ id: thread.id, path: thread.path })
}

type SidebarSessionRowProps = Pick<SidebarThreadRowProps, 'variant' | 'isActive' | 'navigationParent' | 'dropVerb' | 'isFileDragOver' | 'snoozePresets' | 'sortable'> & {
  view: SidebarThreadRowView & { sessionPath: string }
  id: string
  archived: boolean
  snoozedUntil: string | null
  renameValue: string | null
  onMenu: (key: string, point: { x: number; y: number } | null) => void
  onRenameStart: (key: string, title: string) => void
  onRenameChange: (value: string) => void
  onRenameEnd: () => void
  onAnnounce: (text: string) => void
}

export function sameSidebarSessionRow(previous: SidebarSessionRowProps, next: SidebarSessionRowProps): boolean {
  const { view: leftView, sortable: leftSortable, ...left } = previous
  const { view: rightView, sortable: rightSortable, ...right } = next
  if (!shallow(left, right)) return false
  if (leftSortable !== rightSortable) {
    if (!leftSortable || !rightSortable) return false
    const { transform: leftTransform, ...leftBinding } = leftSortable
    const { transform: rightTransform, ...rightBinding } = rightSortable
    if (!shallow(leftBinding, rightBinding) || !shallow(leftTransform, rightTransform)) return false
  }
  if (leftView === rightView) return true
  const { project: leftProject, diff: leftDiff, ...leftDisplay } = leftView
  const { project: rightProject, diff: rightDiff, ...rightDisplay } = rightView
  return shallow(leftDisplay, rightDisplay) && shallow(leftProject, rightProject) && shallow(leftDiff, rightDiff)
}

export const SidebarSessionRow = memo(function SidebarSessionRow({ view, id, archived, snoozedUntil, renameValue, onMenu, onRenameStart, onRenameChange, onRenameEnd, onAnnounce, ...props }: SidebarSessionRowProps) {
  const t = useT()
  const ref = { environmentId: 'local', threadId: id } as const
  const open = () => openSidebarThread({ id, path: view.sessionPath, snoozedUntil })
  return (
    <SidebarThreadRow
      {...props}
      view={view}
      isDragging={props.sortable?.isDragging === true}
      renaming={renameValue !== null}
      renameValue={renameValue ?? ''}
      fileDropHandlers={!props.sortable?.listeners ? { onPointerDown: (event) => {
        if ((event.target as HTMLElement).closest('button, input')) return
        startSessionRowDrag(event, { id, path: view.sessionPath, title: view.title }, () => undefined)
      } } : undefined}
      onOpen={open}
      onActivate={open}
      onContextMenu={(point) => onMenu(view.threadKey, point)}
      onRenameStart={() => onRenameStart(view.threadKey, view.title)}
      onRenameChange={onRenameChange}
      onRenameCommit={() => {
        const next = renameValue?.trim()
        onRenameEnd()
        if (next && next !== view.title) void sidebarActions.rename(ref, next)
      }}
      onRenameCancel={onRenameEnd}
      onArchive={archived ? undefined : () => void sidebarActions.archive(ref)}
      onUnarchive={archived ? () => void sidebarActions.unarchive(ref) : undefined}
      onDelete={() => void sidebarActions.remove(ref)}
      onSnooze={(until) => {
        void sidebarActions.snooze(ref, until)
        onAnnounce(t('sidebar.t3.snooze'))
      }}
      onUnsnooze={snoozedUntil === null ? undefined : () => void sidebarActions.unsnooze(ref)}
      onUnpin={() => void sidebarActions.unpin(ref)}
      onDiscardDraft={() => sidebarActions.discardDraft(ref)}
    />
  )
}, sameSidebarSessionRow)
