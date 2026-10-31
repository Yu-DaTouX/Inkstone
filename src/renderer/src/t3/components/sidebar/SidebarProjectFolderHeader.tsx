import { ChevronDownIcon, EllipsisIcon, SquarePenIcon } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { sidebarFolderRowId } from '../Sidebar.logic'
import { Button } from '../ui/button'

export type SidebarFolderDot = 'attention' | 'failed' | 'unread' | 'working'

const FOLDER_DOT_CLASS_NAME = {
  attention: 'bg-warning',
  failed: 'bg-error',
  unread: 'bg-success',
  working: 'bg-info'
} as const

export interface SidebarProjectFolderView {
  projectKey: string
  displayName: string
  icon?: ReactNode
  collapsed: boolean
  threadKeys: readonly string[]
  hiddenCount: number
  dot: SidebarFolderDot | null
  dotLabel: string | null
  manageable?: boolean
}

export const SidebarProjectFolderHeader = memo(function SidebarProjectFolderHeader(props: {
  folder: SidebarProjectFolderView
  newThreadLabel: string
  menuLabel: string
  onToggle: (projectKey: string) => void
  onNewThread: (projectKey: string) => void
  onContextMenu: (projectKey: string, position: { x: number; y: number }) => void
}) {
  const { folder } = props
  const rowId = sidebarFolderRowId(folder.projectKey)
  return (
    <li
      data-testid="sidebar-project-folder"
      className="group/project-folder relative mt-2 list-none first:mt-0"
    >
      <button
        type="button"
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={rowId}
        aria-expanded={!folder.collapsed}
        onClick={() => props.onToggle(folder.projectKey)}
        onContextMenu={(event) => {
          event.preventDefault()
          props.onContextMenu(folder.projectKey, { x: event.clientX, y: event.clientY })
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {folder.icon}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {folder.displayName}
        </span>
        {folder.dot ? (
          <span className={cn('size-1.5 shrink-0 rounded-full', FOLDER_DOT_CLASS_NAME[folder.dot])}>
            <span className="sr-only">{folder.dotLabel}</span>
          </span>
        ) : null}
        {folder.collapsed && folder.hiddenCount > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground group-hover/project-folder:invisible pointer-coarse:invisible">
            {folder.hiddenCount}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            'size-3 shrink-0 text-sidebar-muted-foreground transition-transform',
            folder.collapsed && '-rotate-90'
          )}
        />
      </button>
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/project-folder:opacity-100 pointer-coarse:opacity-100">
        {folder.manageable ? <Button
          data-sidebar-action-for={rowId}
          size="icon-xs"
          variant="ghost-muted"
          aria-label={props.menuLabel}
          data-testid="v3-project-more"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            props.onContextMenu(folder.projectKey, { x: rect.left, y: rect.bottom })
          }}
        ><EllipsisIcon aria-hidden /></Button> : null}
        <Button
          data-sidebar-action-for={rowId}
          size="icon-xs"
          variant="ghost-muted"
          aria-label={props.newThreadLabel}
          onClick={() => props.onNewThread(folder.projectKey)}
        >
          <SquarePenIcon aria-hidden />
        </Button>
      </span>
    </li>
  )
})
