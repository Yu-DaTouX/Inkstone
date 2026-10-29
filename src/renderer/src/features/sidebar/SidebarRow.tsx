import { useEffect, useLayoutEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { AlarmClock, GitBranch, MoreHorizontal, Pin } from 'lucide-react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { IconButton, StatusSlot } from '../../ui'
import { ModelBot, type BotMood } from '../../patterns/ModelBot'
import { modelBrand, type ModelRef } from '../../../../shared/model-brand'
import { v3Text } from '../../app/v3-text'
import type { SessionSummary } from '../../../../shared/ipc'
import { SessionStatusIcon, sessionStatusHasMark } from './SessionStatusIcon'
import { sessionStatusLabel, type SessionStatusKind } from './session-status'
import { startSessionRowDrag, useSplitDrag } from '../split/split-drag'
import { SessionMenu, openSessionInSplit } from './SessionMenu'
import { SidebarTip } from './SidebarTip'
import { ProjectBadge } from './ProjectBadge'

export interface SidebarRowCard {
  project: string
  cwd: string
  global: boolean
  ago: string
  model?: string
  modelRef?: ModelRef
  branch?: string
  slim?: boolean
}

export interface SidebarRowProps {
  item: SessionSummary
  title: string
  isCurrent: boolean
  status: SessionStatusKind
  code?: string
  card?: SidebarRowCard
  snoozeLabel?: string
  snoozeTitle?: string
  onOpen: () => void
}

function cardDetail(card: SidebarRowCard, status: string): string {
  return [card.cwd && card.cwd !== card.project ? `${card.project} · ${card.cwd}` : card.project, card.branch, card.model, status].filter(Boolean).join('\n')
}

function cardHasBot(status: SessionStatusKind): boolean {
  return status === 'running' || status === 'awaiting'
}

function botMood(status: SessionStatusKind): BotMood {
  return status === 'running' ? 'work' : status === 'awaiting' ? 'ask' : 'icon'
}

function FadeTitleBox({ boxRef, text }: { boxRef: RefObject<HTMLSpanElement | null>; text: string }): JSX.Element {
  return (
    <span ref={boxRef} className="v3-row-title">
      <span className="v3-row-title-text">{text}</span>
    </span>
  )
}

export function SidebarRow({ item, title, isCurrent, status, code, card, snoozeLabel, snoozeTitle, onOpen }: SidebarRowProps): JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  const statusWord = sessionStatusLabel(status, lang)
  const statusLabel = code && status !== 'idle' ? `${code} · ${statusWord}` : statusWord
  const rowRef = useRef<HTMLDivElement>(null)
  const titleBoxRef = useRef<HTMLSpanElement>(null)
  const [titleOverflowing, setTitleOverflowing] = useState(false)
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

  useLayoutEffect(() => {
    const box = titleBoxRef.current
    const inner = box?.firstElementChild as HTMLElement | null | undefined
    if (!box) {
      setTitleOverflowing(false)
      return
    }
    const measure = (): void => {
      const overflowing = !!inner && inner.getBoundingClientRect().width > box.getBoundingClientRect().width + 0.5
      box.toggleAttribute('data-overflowing', overflowing)
      setTitleOverflowing(overflowing)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    if (inner) observer.observe(inner)
    return () => observer.disconnect()
  }, [renaming, title])

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
      data-variant={card ? (card.slim ? 'slim' : 'card') : undefined}
      data-session-path={item.path}
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
        <SidebarTip
          label={title}
          detail={card ? cardDetail(card, status === 'idle' ? '' : statusLabel) : undefined}
          placement="right"
          card={!!card}
          isDisabled={(!card && !titleOverflowing) || menuOpen || dragging}
        >
          <button
            type="button"
            className="ui-row v3-row"
            data-variant={card ? (card.slim ? 'slim' : 'card') : undefined}
            data-menu={menuOpen ? '1' : undefined}
            data-muted={status === 'archived' ? '' : undefined}
            data-status={status}
            data-mark={sessionStatusHasMark(status) && !(card && !card.slim && cardHasBot(status)) ? '' : undefined}
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
            {card?.slim ? (
              <>
                <ProjectBadge label={card.project} global={card.global} />
                <FadeTitleBox boxRef={titleBoxRef} text={title} />
                <span className="v3-crow-ago">{card.ago}</span>
              </>
            ) : null}
            {card && !card.slim ? (
              <span className="v3-crow-meta">
                <ProjectBadge label={card.project} global={card.global} />
                <span className="v3-crow-project">{card.project}</span>
                {item.pinned ? <Pin size={11} className="v3-crow-pin" aria-hidden /> : null}
                <span className="v3-crow-ago">{card.ago}</span>
              </span>
            ) : null}
            {card?.slim ? null : card ? (
              <span className="v3-crow-line">
                <FadeTitleBox boxRef={titleBoxRef} text={title} />
                {card.modelRef || cardHasBot(status) ? (
                  <span className="v3-crow-bot" data-idle={cardHasBot(status) ? undefined : ''}>
                    <StatusSlot label={cardHasBot(status) ? statusLabel : card.model} live={cardHasBot(status)}>
                      <ModelBot brand={modelBrand(card.modelRef)} mood={botMood(status)} size={16} seedKey={item.id} />
                    </StatusSlot>
                  </span>
                ) : null}
              </span>
            ) : (
              <FadeTitleBox boxRef={titleBoxRef} text={title} />
            )}
            {card?.branch && !card.slim ? (
              <span className="v3-crow-branch">
                <GitBranch size={11} aria-hidden />
                <span className="v3-crow-branch-name">{card.branch}</span>
              </span>
            ) : null}
            {snoozeLabel ? (
              <span className="v3-srow-wake" title={snoozeTitle} data-testid="v3-session-snooze-wake">
                <AlarmClock size={12} aria-hidden />
                {snoozeLabel}
              </span>
            ) : card && !card.slim && cardHasBot(status) ? null : <SessionStatusIcon kind={status} label={statusLabel} />}
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
