import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { neighborOf, sameSplitSession, useSplitView, type SplitSessionRef } from '../../state/split-view'
import { createTurnProjector } from '../../../../shared/turns'
import type { UIMessage } from '../../../../shared/ipc'
import { Badge, IconButton, RunDot } from '../ui'
import { Icon } from '../../icons/Icon'
import { TurnView } from './TurnView'
import { InteractionSession } from '../../lib/interaction-state'
import { ConversationOutline } from './ConversationOutline'
import { fitComposerHeight } from './Composer'
import { ComposerBorderIdle } from './ComposerBorder'
import { latestTimestamp, newestMessages, rememberScroll, rememberShown, restoreScrollAnchor, scrollAnchorOf, shownMessages, shownScroll } from '../../state/split-snapshots'
import { useStreamHeight } from '../../lib/useStreamHeight'

export function SplitPeerPane({ index, target }: { index: number; target: SplitSessionRef }) {
  const t = useT()
  const runtime = useStore((s) => (target.sessionId ? s.sessionRuntimes[target.sessionId] : undefined))
  const cached = runtime?.messages
  const running = !!runtime?.session?.isAgentRunning || !!runtime?.session?.isStreaming
  const [sawRun, setSawRun] = useState(false)
  useEffect(() => { if (running) setSawRun(true) }, [running])
  const [shown] = useState(() => shownMessages(target))
  const [history, setHistory] = useState<{ path: string; messages: UIMessage[] } | null>(null)
  const listed = useSplitSummary(target)
  const have = newestMessages(shown, cached)
  const needHistory = !!target.path && (!have || (listed?.updatedAt ?? 0) > latestTimestamp(have))
  useEffect(() => {
    if (!needHistory || !target.path) return
    let alive = true
    const path = target.path
    void window.yan.peekSession(path).then((peek) => {
      if (alive) setHistory({ path, messages: peek?.messages ?? [] })
    }).catch(() => { if (alive) setHistory({ path, messages: [] }) })
    return () => { alive = false }
  }, [needHistory, target.path])

  const fromHistory = history && history.path === target.path && history.messages.length ? history.messages : undefined
  const messages = (sawRun && cached?.length ? cached : newestMessages(shown, fromHistory, cached)) ?? []
  useEffect(() => { rememberShown(target, messages) }, [target, messages])
  const draft = useStore((s) => (target.sessionId ? s.sessionRuntimes[target.sessionId]?.draft ?? '' : ''))
  const waiting = (runtime?.uiRequests.length ?? 0) > 0
  const streamingId = running ? messages[messages.length - 1]?.id : undefined
  const projectTurns = useMemo(() => createTurnProjector(), [])
  const turns = useMemo(() => projectTurns(messages, streamingId), [messages, streamingId, projectTurns])
  const firstUserText = messages.find((m) => m.role === 'user')?.text
  const title = useSplitTitle(target, firstUserText)

  const streamRef = useRef<HTMLDivElement>(null)
  useStreamHeight(streamRef)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return undefined
    fitComposerHeight(el)
    const observer = new ResizeObserver(() => fitComposerHeight(el))
    observer.observe(el.parentElement ?? el)
    return () => observer.disconnect()
  }, [draft])
  const restored = useRef(shownScroll(target))
  const atBottom = useRef(restored.current?.atBottom ?? true)
  useLayoutEffect(() => {
    const el = streamRef.current
    if (!el) return
    if (atBottom.current) el.scrollTop = el.scrollHeight
    else if (restored.current) {
      if (!restoreScrollAnchor(el, restored.current.anchor)) el.scrollTop = restored.current.top
      restored.current = undefined
    }
  }, [turns])
  useLayoutEffect(() => {
    const el = streamRef.current
    const inner = el?.firstElementChild
    if (!el || !inner) return undefined
    const stick = (): void => { if (atBottom.current) el.scrollTop = el.scrollHeight }
    const observer = new ResizeObserver(stick)
    observer.observe(inner)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const focus = (): void => focusSplitSession(target, true)
  return (
    <InteractionSession.Provider value={target.sessionId ?? ''}>
    <section
      className="center split-peer"
      data-testid="split-peer"
      data-split-tile={index}
      aria-label={t('split.peerLabel', { title: title || t('split.untitled') })}
      onClickCapture={(e) => {
        if ((e.target as HTMLElement).closest('[data-split-own]')) return
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return
        e.preventDefault()
        e.stopPropagation()
        focus()
      }}
    >
      <SplitPaneHead index={index} target={target} firstUserText={firstUserText} />
      <ConversationOutline messages={messages} streamingId={streamingId} />
      <div className="stream" ref={streamRef} onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        rememberScroll(target, { top: el.scrollTop, atBottom: atBottom.current, anchor: atBottom.current ? undefined : scrollAnchorOf(el) })
      }}>
        <div className="stream-inner">
          {turns.map((tt) => <TurnView key={tt.id} turn={tt} streaming={tt.kind === 'assistant' && tt.streaming} />)}
        </div>
      </div>
      <div className="composer-wrap split-peer-composer">
        <div className="composer-stack">
          <div className="composer">
            <ComposerBorderIdle />
            <div className="composer-line">
              <span className="composer-prompt" aria-hidden>›</span>
              <textarea
                ref={inputRef}
                rows={1}
                readOnly
                tabIndex={-1}
                value={draft}
                placeholder={t('composer.ph')}
                aria-label={t('split.continue')}
                data-testid="split-peer-input"
              />
            </div>
            <div className="composer-bar">
              <div className="composer-tools">
                {waiting ? <span className="split-peer-state warn">{t('split.waiting')}</span>
                  : running ? <span className="split-peer-state"><RunDot />{t('split.running')}</span> : null}
              </div>
              <button type="button" className="send" data-testid="split-peer-focus" data-empty={draft.trim() ? undefined : ''} onClick={focus}>
                <Icon name="send" size={12} />
                <span>{t('composer.go')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="split-dim" aria-hidden />
    </section>
    </InteractionSession.Provider>
  )
}

export function focusSplitSession(target: SplitSessionRef, composer: boolean): void {
  const store = useStore.getState()
  if (composer) store.requestComposerFocus(target)
  if (target.path) void store.switchSession(target.path)
  else if (target.sessionId) {
    const runner = store.runners.find((r) => r.sessionId === target.sessionId)
    store.applyPush({ ch: 'tray-select-session', payload: { sessionId: target.sessionId, projectId: runner?.projectId, cwd: runner?.cwd ?? store.settings?.cwd ?? '' } })
  }
}

function useSplitSummary(target: SplitSessionRef) {
  return useStore((s) =>
    s.sessions.find((x) => !!target.sessionId && x.id === target.sessionId) ??
    s.sessions.find((x) => !!target.path && sameSplitSession({ path: x.path }, { path: target.path })))
}

function useSplitTitle(target: SplitSessionRef, firstUserText?: string): string {
  const summary = useSplitSummary(target)
  const named = useStore((s) => {
    const id = target.sessionId ?? summary?.id
    return (id && (s.manualTitles[id] || s.titles[id])) || summary?.title || ''
  })
  return named || (firstUserText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

export function SplitPaneHead({ index, target, children, firstUserText }: { index: number; target: SplitSessionRef; children?: ReactNode; firstUserText?: string }) {
  const t = useT()
  const title = useSplitTitle(target, firstUserText)
  const summary = useSplitSummary(target)
  const project = useStore((s) => {
    const record = summary?.projectId ? s.settings?.projects.find((p) => p.id === summary.projectId) : undefined
    return record?.name || (record?.cwd ?? summary?.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || ''
  })
  return (
    <header className={`split-head${children ? ' live' : ''}`} data-split-own data-testid="split-head">
      {children ?? (
        <div className="shead">
          <div className="shead-row">
            <h2 className="shead-title" title={title}>{title || t('split.untitled')}</h2>
            {project ? <Badge>{project}</Badge> : null}
          </div>
        </div>
      )}
      <IconButton size="sm" icon="close" label={t('split.close')} onClick={() => closeSplitTile(index)} />
    </header>
  )
}

export function closeSplitTile(index: number): void {
  const column = document.querySelector<HTMLElement>(`[data-split-column="${index}"]`)
  if (column && !column.classList.contains('closing') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    column.classList.add('closing')
    window.setTimeout(() => removeSplitColumn(index), 140)
    return
  }
  if (!column?.classList.contains('closing')) removeSplitColumn(index)
}

function removeSplitColumn(index: number): void {
  const view = useSplitView.getState()
  const split = view.split
  if (!split) return
  if (index === split.live) {
    const next = split.tiles[neighborOf(split, index)]
    if (next?.path) void useStore.getState().switchSession(next.path)
  }
  view.remove(index)
}
