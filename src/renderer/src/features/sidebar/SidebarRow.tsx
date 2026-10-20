import { useEffect, useLayoutEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { IconButton } from '../../ui'
import { v3Text } from '../../app/v3-text'
import type { SessionSummary } from '../../../../shared/ipc'
import { SessionStatusIcon, sessionStatusHasMark } from './SessionStatusIcon'
import { sessionStatusLabel, type SessionStatusKind } from './session-status'
import { startSessionRowDrag, useSplitDrag } from '../split/split-drag'
import { SessionMenu, openSessionInSplit } from './SessionMenu'
import { SidebarTip } from './SidebarTip'

export interface SidebarRowProps {
  item: SessionSummary
  title: string
  isCurrent: boolean
  status: SessionStatusKind
  code?: string
  onOpen: () => void
}

function FadeTitle({ text }: { text: string }): JSX.Element {
  const boxRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const box = boxRef.current
    const inner = textRef.current
    if (!box || !inner) return
    const measure = (): void => {
      box.toggleAttribute('data-overflowing', inner.getBoundingClientRect().width > box.getBoundingClientRect().width + 0.5)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  return (
    <span ref={boxRef} className="v3-row-title">
      <span ref={textRef} className="v3-row-title-text">{text}</span>
    </span>
  )
}

export function SidebarRow({ item, title, isCurrent, status, code, onOpen }: SidebarRowProps): JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  const statusWord = sessionStatusLabel(status, lang)
  const statusLabel = code && status !== 'idle' ? `${code} · ${statusWord}` : statusWord
  const rowRef = useRef<HTMLDivElement>(null)
  const draggedRef = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renamePending, setRenamePending] = useState(false)
  const [draft, setDraft] = useState(title)
  const dragging = useSplitDrag((s) => s.source === `session:${item.path}`)

  useEffect(() => {
    if (!renamePending || menuOpen) return
    let frame = 0
    let idleFrames = 0
    let waited = 0
    const wait = (): void => {
      idleFrames = document.querySelector('.ui-popover') ? 0 : idleFrames + 1
      if (idleFrames < 2 && waited++ < 60) {
        frame = requestAnimationFrame(wait)
        return
      }
      setRenamePending(false)
      setDraft(title)
      setRenaming(true)
    }
    frame = requestAnimationFrame(wait)
    return () => cancelAnimationFrame(frame)
  }, [renamePending, menuOpen, title])

  useEffect(() => {
    if (isCurrent) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [isCurrent])

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || renaming) return
    draggedRef.current = false
    startSessionRowDrag(event, { id: item.id, path: item.path, title }, () => {
      draggedRef.current = true
    })
  }

  const restoreRowFocus = (): void => {
    requestAnimationFrame(() => rowRef.current?.querySelector<HTMLElement>('.v3-row')?.focus())
  }

  const commitRename = (): void => {
    const name = draft.trim()
    setRenaming(false)
    if (!name || name === title) return
    void useStore.getState().setManualTitle(item.id, name)
  }

  return (
    <div
      ref={rowRef}
      className="v3-srow"
      data-current={isCurrent ? '1' : undefined}
      data-menu={menuOpen ? '1' : undefined}
      data-dragging={dragging ? '1' : undefined}
      onContextMenu={(event) => {
        if (renaming) return
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      {renaming ? (
        <input
          className="ui-input v3-srow-rename"
          aria-label={title}
          value={draft}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitRename()
              restoreRowFocus()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(false)
              restoreRowFocus()
            }
          }}
          data-testid="v3-session-rename"
        />
      ) : (
        <SidebarTip label={title}>
          <button
            type="button"
            className="ui-row v3-row"
            data-menu={menuOpen ? '1' : undefined}
            data-muted={status === 'archived' ? '' : undefined}
            data-status={status}
            data-mark={sessionStatusHasMark(status) ? '' : undefined}
            aria-current={isCurrent ? 'true' : undefined}
            onPointerDown={onPointerDown}
            onClick={(event) => {
              if (draggedRef.current) {
                draggedRef.current = false
                return
              }
              if ((event.ctrlKey || event.metaKey) && !isCurrent) {
                openSessionInSplit(item)
                return
              }
              onOpen()
            }}
            data-testid="v3-session-row"
          >
            <FadeTitle text={title} />
            <SessionStatusIcon kind={status} label={statusLabel} />
          </button>
        </SidebarTip>
      )}
      {renaming ? null : (
        <IconButton
          size="sm"
          variant="ghost"
          className="v3-srow-more"
          aria-label={`${text.sessionMenu} · ${title}`}
          onPress={() => setMenuOpen(true)}
          data-testid="v3-session-more"
        >
          <MoreHorizontal size={14} />
        </IconButton>
      )}
      <SessionMenu
        item={item}
        title={title}
        isCurrent={isCurrent}
        anchor={rowRef}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onRename={() => setRenamePending(true)}
      />
    </div>
  )
}
