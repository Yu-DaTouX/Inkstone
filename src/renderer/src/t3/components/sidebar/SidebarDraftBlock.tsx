import { SquarePenIcon, XIcon } from 'lucide-react'
import { memo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { resolveSidebarRowAccessibility } from '../Sidebar.logic'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip'

export const DRAFT_SURFACE_CLASS_NAME = 'bg-warning/4 hover:bg-warning/8'
export const DRAFT_PEN_CLASS_NAME = 'size-3 shrink-0 text-warning-foreground'

export interface SidebarDraftRowData {
  draftId: string
  projectDisplayName: string | null
  preview: string
  isActive: boolean
  projectIcon?: ReactNode
}

const SidebarDraftRow = memo(function SidebarDraftRow(props: {
  draft: SidebarDraftRowData
  discardLabel: string
  unsentLabel: string
  onNavigate: (draftId: string) => void
  onDiscard: (draftId: string) => void
  onContextMenu: (draftId: string, position: { x: number; y: number }) => void
}) {
  const { draft, onContextMenu, onDiscard, onNavigate } = props
  const accessibility = resolveSidebarRowAccessibility({
    title: draft.preview,
    statusLabel: props.unsentLabel,
    projectDisplayName: draft.projectDisplayName,
    isActive: draft.isActive
  })
  const handleActivate = () => onNavigate(draft.draftId)
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if ((event.target as HTMLElement).closest('button')) return
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      onContextMenu(draft.draftId, { x: rect.left, y: rect.bottom })
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onNavigate(draft.draftId)
    }
  }
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault()
    onContextMenu(draft.draftId, { x: event.clientX, y: event.clientY })
  }
  const handleDiscard = (event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    onDiscard(draft.draftId)
  }
  return (
    <li className="list-none py-0.5">
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`draft:${draft.draftId}`}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-draft-row"
        className={cn(
          'group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          draft.isActive ? 'bg-sidebar-row-active' : DRAFT_SURFACE_CLASS_NAME
        )}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only">{draft.preview}</span>
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <SquarePenIcon aria-hidden className={DRAFT_PEN_CLASS_NAME} />
            {draft.projectIcon}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
              {draft.projectDisplayName}
            </span>
            <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={props.discardLabel}
                      onClick={handleDiscard}
                      className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">{props.discardLabel}</TooltipPopup>
              </Tooltip>
            </span>
          </div>
          <div aria-hidden className="mt-0.5 truncate text-sm font-medium text-foreground/90">
            {draft.preview}
          </div>
        </div>
      </div>
    </li>
  )
})

export const SidebarDraftBlock = memo(function SidebarDraftBlock(props: {
  drafts: readonly SidebarDraftRowData[]
  discardLabel: string
  unsentLabel: string
  onNavigateToDraft: (draftId: string) => void
  onDiscardDraft: (draftId: string) => void
  onDraftContextMenu: (draftId: string, position: { x: number; y: number }) => void
}) {
  if (props.drafts.length === 0) return null
  return (
    <>
      {props.drafts.map((draft) => (
        <SidebarDraftRow
          key={draft.draftId}
          draft={draft}
          discardLabel={props.discardLabel}
          unsentLabel={props.unsentLabel}
          onNavigate={props.onNavigateToDraft}
          onDiscard={props.onDiscardDraft}
          onContextMenu={props.onDraftContextMenu}
        />
      ))}
      <li
        aria-hidden
        data-testid="sidebar-draft-divider"
        className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"
      />
    </>
  )
})
