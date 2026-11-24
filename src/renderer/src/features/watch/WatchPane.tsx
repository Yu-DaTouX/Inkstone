import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { X } from '../../ui/icons'
import { useI18n } from '../../i18n'
import { Badge, Button, EmptyState, Notice, Spinner, type BadgeTone } from '../../ui'
import { groupIntoTurns } from '../../../../shared/turns'
import type { WatchStatus } from '../../../../shared/session-watch'
import { useSessionWatch } from '../../state/session-watch'
import { useRightPanel } from '../../state/right-panel'
import { PaneTitle, PaneTools } from '../workbench/pane-chrome'
import { isNearBottom } from '../workbench/background-tasks'
import { TurnView } from '../session/TurnView'
import { TurnScopeContext, type TurnScope } from '../session/turn-scope'
import { ErrorCardRetryContext } from '../session/ErrorCard'
import { watchText } from './watch-text'
import './watch.css'

const STATUS_TONE: Record<WatchStatus, BadgeTone> = { connecting: 'neutral', live: 'ok', reconnecting: 'stall', ended: 'neutral', failed: 'fail' }
const USER_SCROLL_MS = 800

export function WatchPane({ watchId }: { watchId: string }): JSX.Element {
  const { lang } = useI18n()
  const text = watchText(lang)
  const data = useSessionWatch((s) => s.watches[watchId])
  const [leaving, setLeaving] = useState(false)
  const messages = data?.messages
  const turns = useMemo(() => groupIntoTurns(messages ?? []), [messages])
  const scope = useMemo<TurnScope>(() => ({ messages: messages ?? [], session: null, view: { sessionId: null, sessionFile: null, key: `watch:${watchId}` } }), [messages, watchId])

  const scrollRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const userScrollAt = useRef(0)
  const markUserScroll = (): void => {
    userScrollAt.current = Date.now()
  }

  useEffect(() => {
    if (data && !data.loaded && data.view.status === 'live') void window.yan.watch.refresh(watchId).catch(() => undefined)
  }, [data, watchId])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [turns.length])

  useEffect(() => {
    const el = scrollRef.current
    const stream = streamRef.current
    if (!el || !stream || typeof ResizeObserver !== 'function') return undefined
    const stick = (): void => {
      if (followRef.current && el.clientHeight > 0) el.scrollTop = el.scrollHeight
    }
    const observer = new ResizeObserver(stick)
    observer.observe(stream)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  if (!data) return <EmptyState className="watch-pane-missing" title={text.status.ended} description={text.leave} data-testid="watch-pane-missing" />
  const { view } = data
  const running = !!(view.state?.isStreaming || view.state?.isAgentRunning) && view.status === 'live'

  const leave = async (): Promise<void> => {
    setLeaving(true)
    try {
      await window.yan.watch.leave(watchId)
    } finally {
      setLeaving(false)
      useRightPanel.getState().drop([`watch:${watchId}`])
    }
  }

  return (
    <div className="watch-pane" data-status={view.status} data-testid="watch-pane">
      <PaneTitle>
        <span className="watch-pane-head">
          <span className="watch-pane-name" title={view.title}>{view.title}</span>
          <span className="watch-pane-host" title={view.fingerprint}>{text.host(view.host)}</span>
          {view.state?.model ? <span className="watch-pane-model">{view.state.model}</span> : null}
          <Badge tone={STATUS_TONE[view.status]} data-testid="watch-pane-status">{text.status[view.status]}</Badge>
          <Badge tone="neutral">{text.readOnly}</Badge>
        </span>
      </PaneTitle>
      <PaneTools>
        <Button size="sm" variant="ghost" icon={<X size={12} aria-hidden />} isPending={leaving} onPress={() => void leave()} data-testid="watch-pane-leave">
          {text.leave}
        </Button>
      </PaneTools>
      {view.status === 'ended' || view.status === 'failed' ? (
        <Notice tone={view.status === 'failed' ? 'fail' : 'info'} compact className="watch-pane-notice" data-testid="watch-pane-ended">
          {view.error || text.status[view.status]}
        </Notice>
      ) : view.status === 'reconnecting' ? (
        <Notice tone="stall" compact className="watch-pane-notice" data-testid="watch-pane-reconnecting">
          {view.error ? `${text.status.reconnecting} · ${view.error}` : text.status.reconnecting}
        </Notice>
      ) : null}
      <div
        className="watch-pane-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget
          if (el.clientHeight <= 0) return
          if (isNearBottom(el)) followRef.current = true
          else if (Date.now() - userScrollAt.current < USER_SCROLL_MS) followRef.current = false
          else if (followRef.current) el.scrollTop = el.scrollHeight
        }}
        onWheel={markUserScroll}
        onPointerDown={markUserScroll}
        onTouchMove={markUserScroll}
        onKeyDown={markUserScroll}
      >
        <div className="watch-pane-stream" ref={streamRef} data-testid="watch-pane-stream">
          <TurnScopeContext.Provider value={scope}>
            <ErrorCardRetryContext.Provider value={false}>
              {turns.map((turn) => (
                <div key={turn.id} className="v3-stream-row">
                  <TurnView turn={turn} streaming={turn.kind === 'assistant' && running && turn === turns[turns.length - 1]} tail={turn === turns[turns.length - 1]} readOnly />
                </div>
              ))}
            </ErrorCardRetryContext.Provider>
          </TurnScopeContext.Provider>
          {!data.loaded ? <p className="watch-pane-wait" role="status"><Spinner size="sm" />{text.waiting}</p> : turns.length === 0 ? <p className="watch-pane-wait">{text.empty}</p> : null}
        </div>
      </div>
      {view.pending > 0 && view.status === 'live' ? (
        <footer className="watch-pane-foot" role="status" data-testid="watch-pane-pending">
          <Spinner size="sm" />
          {text.pending(view.pending)}
        </footer>
      ) : null}
    </div>
  )
}
