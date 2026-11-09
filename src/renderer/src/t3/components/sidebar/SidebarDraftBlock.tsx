import { SquarePenIcon, XIcon } from 'lucide-react'
import { memo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { cx } from '../../../ui/cx'
import { resolveSidebarRowAccessibility } from '../Sidebar.logic'
import { Focusable, TooltipTrigger, Tooltip, TooltipHint } from '../../../ui'
import './SidebarThreadRow.css'
import './SidebarDraftBlock.css'


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
    <li className="t3-draft-row">
      <div
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`draft:${draft.draftId}`}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-draft-row"
        className={cx(
          't3-g-sidebar-row t3-thread-row__surface',
          draft.isActive ? 't3-thread-row__surface--active' : 't3-thread-row__surface--draft'
        )}
        onClick={handleActivate}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
      >
        <span className="sr-only">{draft.preview}</span>
        <div className="t3-draft-row__body">
          <div className="t3-draft-row__head">
            <SquarePenIcon aria-hidden className="t3-icon--xs t3-thread-row__draft-mark" />
            {draft.projectIcon}
            <span className="t3-draft-row__project">
              {draft.projectDisplayName ?? props.unsentLabel}
            </span>
            <span className="t3-draft-row__discard-slot">
              <TooltipTrigger>
                <Focusable><button type="button" aria-label={props.discardLabel} onClick={handleDiscard} className="t3-thread-row__action t3-draft-row__discard">
                      <XIcon className="t3-icon--xs" />
                    </button></Focusable>
                <Tooltip><TooltipHint label={props.discardLabel} /></Tooltip>
              </TooltipTrigger>
            </span>
          </div>
          <div aria-hidden className="t3-draft-row__preview">
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
        className="t3-draft-divider"
      />
    </>
  )
})
