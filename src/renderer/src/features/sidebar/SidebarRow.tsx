import { memo, useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { AlarmClock, MoreHorizontal, Pin } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { cx, IconButton, InlineRename, isImeComposing, Kbd, ListRow, StatusSlot } from '../../ui'
import { useSessionNav } from './session-nav-store'
import { sessionJumpKeysText } from './use-session-jump'
import { ModelBot, type BotMood } from '../../patterns/ModelBot'
import { modelBrand, type ModelRef } from '../../../../shared/model-brand'
import { v3Text } from '../../app/v3-text'
import type { SessionSummary } from '../../../../shared/ipc'
import { SessionStatusIcon, sessionStatusHasMark } from './SessionStatusIcon'
import { sessionStatusLabel, type SessionStatusKind } from './session-status'
import { startSessionRowDrag, useSessionDrag } from './session-drag'
import { SessionMenu } from './SessionMenu'
import { SidebarTip } from './SidebarTip'
import { ProjectBadge } from './ProjectBadge'
import type { SessionRowMeta } from './sidebar-model'

export interface SidebarRowCard {
  project: string
  cwd: string
  global: boolean
  ago: string
  model?: string
  modelRef?: ModelRef
  branch?: string
  slim?: boolean
  hint?: string
  toneKey?: string
  hideProject?: boolean
}


export interface SidebarRowProps {
  item: SessionSummary
  title: string
  isCurrent: boolean
  status: SessionStatusKind
  code?: string
  card?: SidebarRowCard
  meta?: SessionRowMeta
  snoozeLabel?: string
  snoozeTitle?: string
  onOpen: (item: SessionSummary) => void
}

function cardDetail(card: SidebarRowCard, status: string, note?: string): string {
  return [card.cwd && card.cwd !== card.project ? `${card.project} · ${card.cwd}` : card.project, card.branch, card.model, status, note].filter(Boolean).join('\n')
}

function signalInk(status: SessionStatusKind): string | undefined {
  return status === 'running' ? 'ui-signal-run' : status === 'awaiting' ? 'ui-signal-ask' : undefined
}

function subModel(card: SidebarRowCard | undefined, status: SessionStatusKind): string | undefined {
  return card && !card.slim && cardHasBot(status) ? card.model : undefined
}

function RowSub({ card, note, status }: { card?: SidebarRowCard; note?: string; status: SessionStatusKind }): JSX.Element | null {
  const shown = card && !card.slim && !card.hideProject ? card : undefined
  const project = shown && (shown.global || !note) ? shown : undefined
  const tail = note ?? subModel(card, status)
  if (!project && !tail) return null
  return (
    <span className="v3-srow-sub" data-testid="v3-session-sub">
      {project ? (
        <span className="v3-srow-owner">
          {project.global ? <ProjectBadge label={project.project} global /> : null}
          {note ? null : <span className="v3-crow-project">{project.project}</span>}
          {project.hint && !note ? <span className="v3-srow-hint" data-testid="v3-session-hint">{project.hint}</span> : null}
        </span>
      ) : null}
      {project && tail && !note ? <span className="v3-srow-dot" aria-hidden>·</span> : null}
      {tail ? <span className="v3-srow-note" data-note={note ? '' : undefined}>{tail}</span> : null}
    </span>
  )
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

export const SidebarRow = memo(function SidebarRow({ item, title, isCurrent, status, code, card, meta, snoozeLabel, snoozeTitle, onOpen }: SidebarRowProps): JSX.Element {
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
  const settledByKey = useRef(false)
  const dragging = useSessionDrag((s) => s.source === `session:${item.path}`)
  const t = useT()
  const jumpIndex = useSessionNav((s) => s.jump?.get(item.path))
  const fileDrop = useSessionNav((s) => s.fileDropPath === item.path)
  const jumpKeys = jumpIndex ? sessionJumpKeysText(jumpIndex) : undefined
  const hasSub = !!meta?.note || (!!card && !card.slim && (!card.hideProject || !!subModel(card, status)))

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

  const finishRename = (): void => {
    setRenaming(false)
    if (!settledByKey.current) return
    settledByKey.current = false
    restoreRowFocus()
  }

  const noteRenameKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(event)) return
    if (event.key === 'Enter' || event.key === 'Escape') settledByKey.current = true
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
      data-jump={jumpIndex && !renaming ? '1' : undefined}
      data-file-drop={fileDrop ? '1' : undefined}
      onContextMenu={(event) => {
        if (renaming) return
        event.preventDefault()
        setMenuOpen(true)
      }}
    >
      {renaming ? (
        <InlineRename
          className="v3-srow-rename"
          aria-label={title}
          defaultValue={title}
          onKeyDown={noteRenameKey}
          onCommit={(name) => {
            finishRename()
            void useStore.getState().setManualTitle(item.id, name)
          }}
          onCancel={finishRename}
          data-testid="v3-session-rename"
        />
      ) : (
        <SidebarTip
          label={title}
          detail={card ? cardDetail(card, status === 'idle' ? '' : statusLabel, meta?.note) : meta?.note}
          placement="right"
          card={!!card || !!meta?.note}
          isDisabled={(!card && !meta?.note && !titleOverflowing) || menuOpen || dragging}
        >
          <ListRow
            className="v3-row"
            current={isCurrent}
            muted={status === 'archived'}
            signal={status === 'awaiting' ? 'ask' : undefined}
            data-variant={card ? (card.slim ? 'slim' : 'card') : undefined}
            data-menu={menuOpen ? '1' : undefined}
            data-status={status}
            data-age={meta?.age}
            data-sub={hasSub ? '' : undefined}
            data-mark={card?.slim && sessionStatusHasMark(status) ? '' : undefined}
            onPointerDown={onPointerDown}
            aria-keyshortcuts={jumpKeys ? `${jumpKeys.replace('Ctrl', 'Control').replace('Cmd', 'Meta')} F2` : 'F2'}
            onDoubleClick={(event) => {
              if (draggedRef.current || event.button !== 0) return
              setRenaming(true)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'F2' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
              event.preventDefault()
              setRenaming(true)
            }}
            onClick={() => {
              if (draggedRef.current) {
                draggedRef.current = false
                return
              }
              onOpen(item)
            }}
            data-testid="v3-session-row"
          >
            {card?.slim ? (
              <span className="v3-row-body">
                <ProjectBadge label={card.project} global={card.global} toneKey={card.toneKey} />
                <FadeTitleBox boxRef={titleBoxRef} text={title} />
                <span className="v3-crow-ago ui-num">{card.ago}</span>
                <SessionStatusIcon kind={status} label={statusLabel} />
              </span>
            ) : (
              <span className="v3-row-body" data-layout="lane">
                <SessionStatusIcon kind={status} label={statusLabel} />
                <FadeTitleBox boxRef={titleBoxRef} text={title} />
                <span className="v3-srow-meta">
                  {card && cardHasBot(status) ? (
                    <span className="v3-crow-bot">
                      <StatusSlot label={statusLabel}>
                        <ModelBot brand={modelBrand(card.modelRef)} mood={botMood(status)} size={16} seedKey={item.id} />
                      </StatusSlot>
                    </span>
                  ) : null}
                  {card && item.pinned ? <Pin size={11} className="v3-crow-pin" aria-hidden /> : null}
                  {snoozeLabel ? (
                    <span className="v3-srow-wake ui-num" title={snoozeTitle} data-testid="v3-session-snooze-wake">
                      <AlarmClock size={12} aria-hidden />
                      {snoozeLabel}
                    </span>
                  ) : meta ? (
                    <span className={cx('v3-crow-ago ui-num', meta.elapsed ? signalInk(status) : undefined)} data-testid="v3-session-ago">
                      {meta.elapsed ?? meta.ago}
                    </span>
                  ) : null}
                </span>
                {hasSub ? <RowSub card={card} note={meta?.note} status={status} /> : null}
              </span>
            )}
          </ListRow>
        </SidebarTip>
      )}
      {jumpIndex && !renaming ? (
        <Kbd className="v3-srow-jump" aria-label={t('sidebar.jump.label', { keys: jumpKeys ?? '' })} data-testid="v3-session-jump">
          {jumpIndex}
        </Kbd>
      ) : null}
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
})
