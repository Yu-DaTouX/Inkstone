import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { IconButton, ShimmerText } from '../../ui'
import { v3Text } from '../../app/v3-text'
import { RunDot } from '../../patterns/RunDot'
import type { RunPhase } from '../../../../shared/runs'
import type { SessionSummary } from '../../../../shared/ipc'
import { passedThreshold, useSessionDrag } from './session-drag'
import { SessionMenu, openSessionInSplit } from './SessionMenu'

export interface SidebarRowProps {
  item: SessionSummary
  title: string
  isCurrent: boolean
  phase: RunPhase | null
  unread: boolean
  code?: string
  word: string | null
  tone: string
  onOpen: () => void
}

export function SidebarRow({ item, title, isCurrent, phase, unread, code, word, tone, onOpen }: SidebarRowProps): JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  const rowRef = useRef<HTMLDivElement>(null)
  const draggedRef = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renamePending, setRenamePending] = useState(false)
  const [draft, setDraft] = useState(title)
  const dragging = useSessionDrag((s) => s.item?.path === item.path)

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
    const sx = event.clientX
    const sy = event.clientY
    let active = false

    const move = (ev: PointerEvent): void => {
      if (!active) {
        if (!passedThreshold(ev.clientX - sx, ev.clientY - sy)) return
        active = true
        draggedRef.current = true
        useSessionDrag.getState().begin({ id: item.id, path: item.path, title }, ev.clientX, ev.clientY)
        document.body.dataset.v3Dragging = '1'
        return
      }
      useSessionDrag.getState().move(ev.clientX, ev.clientY)
    }
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', cancel)
      if (!active) return
      const state = useSessionDrag.getState()
      const zone = state.hit >= 0 ? state.zones[state.hit] : null
      state.end()
      delete document.body.dataset.v3Dragging
      if (commit && zone) openSessionInSplit(item, zone.at)
    }
    const up = (): void => finish(true)
    const cancel = (): void => finish(false)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !active) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', cancel)
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
            if (event.key === 'Enter') commitRename()
            else if (event.key === 'Escape') {
              event.preventDefault()
              setRenaming(false)
            }
          }}
          data-testid="v3-session-rename"
        />
      ) : (
        <button
          type="button"
          className="v3-row"
          aria-current={isCurrent ? 'true' : undefined}
          title={`${title}\n${text.dragToSplit}`}
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
          <RunDot phase={phase} unread={unread} code={code} />
          <ShimmerText className="v3-row-title" active={phase?.kind === 'running'}>{title}</ShimmerText>
          {word ? <span className={`v3-row-word v3-row-word-${tone}`}>{word}</span> : null}
        </button>
      )}
      {renaming ? null : (
        <IconButton
          size="sm"
          variant="ghost"
          className="v3-srow-more"
          aria-label={text.sessionMenu}
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
