import { ChevronDownIcon, EllipsisIcon, SquarePenIcon } from '../../../ui/icons'
import { memo } from 'react'
import { useI18n } from '../../../i18n'
import { v3Text } from '../../../app/v3-text'
import { NO_PROJECT_ID } from '../../adapters/sidebar/types'
import { cx } from '../../../ui/cx'
import { sidebarFolderRowId } from '../Sidebar.logic'
import { ProjectFavicon } from '../ProjectFavicon'
import { IconButton, StatusDot } from '../../../ui'
import './SidebarProjectFolderHeader.css'

export type SidebarFolderDot = 'attention' | 'failed' | 'unread' | 'working'

const FOLDER_DOT_KIND = {
  attention: 'awaiting',
  failed: 'fail',
  unread: 'ok',
  working: 'running'
} as const

export interface SidebarProjectFolderView {
  projectKey: string
  displayName: string
  collapsed: boolean
  threadKeys: readonly string[]
  hiddenCount: number
  dot: SidebarFolderDot | null
  dotLabel: string | null
  manageable?: boolean
}

export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: Omit<SidebarProjectFolderView, 'threadKeys'> & {
  empty: boolean
  newThreadLabel: string
  menuLabel: string
  onToggle?: (projectKey: string) => void
  onNewThread?: (projectKey: string) => void
  onContextMenu?: (projectKey: string, position: { x: number; y: number }) => void
}) {
  const { empty, projectKey, collapsed, dot, dotLabel, hiddenCount, manageable } = props
  const { lang } = useI18n()
  const rowId = sidebarFolderRowId(projectKey)
  const displayName = projectKey === NO_PROJECT_ID ? v3Text(lang).groupUngrouped : props.displayName
  return (
    <li
      data-testid="sidebar-project-folder"
      className="t3-folder"
    >
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={rowId}
        aria-expanded={empty ? undefined : !collapsed}
        onClick={empty ? undefined : () => props.onToggle?.(projectKey)}
        onContextMenu={(event) => {
          event.preventDefault()
          props.onContextMenu?.(projectKey, { x: event.clientX, y: event.clientY })
        }}
        className={cx('t3-folder__header', !empty && 't3-folder__header--expandable')}
      >
        {manageable ? <ProjectFavicon project={{ projectId: projectKey, displayName: props.displayName }} /> : null}
        <span className={cx('t3-folder__name', empty && 't3-folder__name--empty')}>
          {displayName}
        </span>
        {dot ? (
          <>
            <StatusDot kind={FOLDER_DOT_KIND[dot]} />
            <span className="sr-only">{dotLabel}</span>
          </>
        ) : null}
        {collapsed && hiddenCount > 0 ? (
          <span className="t3-folder__hidden-count">
            {hiddenCount}
          </span>
        ) : null}
        {empty ? null : (
          <ChevronDownIcon
            aria-hidden
            className={cx(
              't3-icon--xs t3-chevron t3-folder__chevron',
              collapsed && 't3-chevron--collapsed'
            )}
          />
        )}
      </button>
      <span className="t3-folder__actions">
        {manageable ? <IconButton data-t3-btn variant="ghost" size="md" className="t3-folder__action" onPress={(event) => {
            const rect = (event.target as HTMLElement).getBoundingClientRect()
            props.onContextMenu?.(projectKey, { x: rect.left, y: rect.bottom })
          }} data-sidebar-action-for={rowId} aria-label={props.menuLabel} data-testid="v3-project-more"><EllipsisIcon aria-hidden /></IconButton> : null}
        <IconButton data-t3-btn variant="ghost" size="md" className="t3-folder__action" onPress={() => props.onNewThread?.(projectKey)} data-sidebar-action-for={rowId} aria-label={props.newThreadLabel}>
          <SquarePenIcon aria-hidden />
        </IconButton>
      </span>
    </li>
  )
})
