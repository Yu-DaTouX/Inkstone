import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { createTurnProjector, groupIntoTurns, type Turn } from '../../../shared/turns'
import type { UIMessage } from '../../../shared/ipc'
import { neighborOf, sameSplitSession, splitTileKey, useSplitView, type SplitLayout, type SplitSessionRef } from '../state/split-view'
import { newestMessages, shownMessages } from '../state/split-snapshots'
import { SessionView } from '../features/session/SessionView'
import { Composer } from '../features/composer/Composer'
import { TurnView } from '../features/session/TurnView'
import { Icon } from '../features/session/Icon'
import { Button, IconButton, Splitter } from '../ui'
import { collapsedPanes, isSessionTile, subagentRunIdOf } from './SideBySideLayout'
import {
  KEY_STEP,
  bindPairObserver,
  clampPairValue,
  pairBounds,
  samePair,
  weightsForLeft,
  type PairMetrics
} from './split-resizer-model'
import './SideBySide.css'

export interface SideBySideProps {
  split: SplitLayout | null
  narrow: boolean
}

export const SideBySide = memo(function SideBySide({ split, narrow }: SideBySideProps): JSX.Element {
  const layout = collapsedPanes(split, narrow)
  const weights = useSplitView((s) => s.weights)

  if (!layout) {
    return (
      <>
        <div className="v3-conv"><SessionView /></div>
        <div className="v3-composer"><Composer /></div>
      </>
    )
  }

  const closePane = (index: number): void => {
    const view = useSplitView.getState()
    const current = view.split
    if (!current) return
    if (index === current.live) {
      const neighbor = current.tiles[neighborOf(current, index)]
      if (neighbor && isSessionTile(neighbor) && neighbor.path) void useStore.getState().switchSession(neighbor.path)
    }
    view.remove(index)
  }

  return (
    <div className="v3-split" data-testid="v3-split">
      {layout.tiles.map((target, index) => {
        const runId = subagentRunIdOf(target)
        const live = index === layout.live
        return (
          <Fragment key={splitTileKey(target) || `pane-${index}`}>
            {index > 0 ? <SplitResizer left={layout.tiles[index - 1]} right={target} /> : null}
            <PaneFrame target={target} live={live} weight={weights[splitTileKey(target)] ?? 1} onClose={() => closePane(index)}>
              {runId ? (
                <AgentPane runId={runId} />
              ) : live ? (
                <>
                  <div className="v3-conv"><SessionView /></div>
                  <div className="v3-composer"><Composer /></div>
                </>
              ) : (
                <PeerPane target={target} />
              )}
            </PaneFrame>
          </Fragment>
        )
      })}
    </div>
  )
})

function PaneFrame({
  target,
  live,
  weight,
  onClose,
  children
}: {
  target: SplitSessionRef
  live: boolean
  weight: number
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  const t = useT()
  const title = useSplitTitle(target)
  const project = useSplitProject(target)
  return (
    <section
      className="v3-split-col"
      data-live={live ? '1' : '0'}
      data-testid="v3-split-col"
      data-pane={target.sessionId ?? target.path ?? ''}
      style={{ flexGrow: weight, flexBasis: 0 }}
    >
      <header className="v3-split-head" data-split-own>
        <span className="v3-split-title" title={title}>{title || t('split.untitled')}</span>
        {project ? <span className="v3-split-proj" title={project}>{project}</span> : null}
        <IconButton size="sm" aria-label={t('split.close')} title={t('split.close')} onPress={onClose} data-testid="v3-split-close">
          <Icon name="close" size={14} />
        </IconButton>
      </header>
      {children}
    </section>
  )
}

function useSplitSummary(target: SplitSessionRef) {
  return useStore(
    (s) =>
      s.sessions.find((item) => !!target.sessionId && item.id === target.sessionId) ??
      s.sessions.find((item) => !!target.path && sameSplitSession({ path: item.path }, { path: target.path }))
  )
}

function useSplitTitle(target: SplitSessionRef): string {
  const summary = useSplitSummary(target)
  const named = useStore((s) => {
    const id = target.sessionId ?? summary?.id
    return (id && (s.manualTitles[id] || s.titles[id])) || summary?.title || ''
  })
  return named.trim()
}

function useSplitProject(target: SplitSessionRef): string {
  const summary = useSplitSummary(target)
  return useStore((s) => {
    const record = summary?.projectId ? s.settings?.projects.find((item) => item.id === summary.projectId) : undefined
    return record?.name || (record?.cwd ?? summary?.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || ''
  })
}

function PeerPane({ target }: { target: SplitSessionRef }): JSX.Element {
  const t = useT()
  const runtime = useStore((s) => (target.sessionId ? s.sessionRuntimes[target.sessionId] : undefined))
  const cached = runtime?.messages
  const shown = useMemo(() => shownMessages(target), [target])
  const [history, setHistory] = useState<UIMessage[] | null>(null)
  const messages = useMemo(() => newestMessages(cached, shown, history ?? undefined) ?? [], [cached, shown, history])
  const draft = runtime?.draft ?? ''
  const running = !!runtime?.session?.isAgentRunning || !!runtime?.session?.isStreaming
  const waiting = (runtime?.uiRequests.length ?? 0) > 0
  const streamingId = runtime?.session?.isStreaming && messages.length ? messages[messages.length - 1].id : undefined
  const projectTurns = useMemo(() => createTurnProjector(), [])
  const turns = useMemo(() => projectTurns(messages, streamingId), [messages, streamingId, projectTurns])

  useEffect(() => {
    if (cached?.length || !target.path) return undefined
    let alive = true
    void window.yan
      .peekSession(target.path)
      .then((peek) => { if (alive) setHistory(peek?.messages ?? []) })
      .catch(() => { if (alive) setHistory([]) })
    return () => { alive = false }
  }, [cached?.length, target.path])

  const streamRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  useLayoutEffect(() => {
    const el = streamRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [turns])

  return (
    <div
      className="v3-split-peer"
      data-testid="v3-split-peer"
      onClickCapture={(event) => {
        if ((event.target as HTMLElement).closest('button, [data-split-own]')) return
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return
        focusSession(target)
      }}
    >
      <div className="v3-conv">
        <div
          className="v3-stream"
          ref={streamRef}
          onScroll={(event) => {
            const el = event.currentTarget
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
        >
          <div className="v3-stream-inner">
            {turns.length === 0 ? (
              <div className="v3-empty">
                <p className="v3-empty-hint">{running ? t('chat.working') : t('split.continue')}</p>
              </div>
            ) : (
              turns.map((turn) => (
                <div key={turn.id} className="v3-stream-row">
                  <TurnView turn={turn} sessionId={target.sessionId ?? null} streaming={turn.kind === 'assistant' && turn.streaming} readOnly />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="v3-composer">
        <div className="composer" data-testid="v3-split-peer-composer">
          <div className="composer-input">
            <textarea
              className="composer-text"
              rows={1}
              readOnly
              tabIndex={-1}
              value={draft}
              placeholder={t('composer.ph')}
              aria-label={t('split.continue')}
              data-testid="v3-split-peer-input"
            />
            <div className="composer-bar">
              {waiting ? (
                <span className="v3-split-state" data-tone="warn">{t('split.waiting')}</span>
              ) : running ? (
                <span className="v3-split-state" data-tone="run">{t('split.running')}</span>
              ) : null}
              <span className="composer-spacer" />
              <Button size="sm" variant="primary" onPress={() => focusSession(target)} data-testid="v3-split-peer-focus">
                {t('split.continue')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentPane({ runId }: { runId: string }): JSX.Element {
  const t = useT()
  const run = useStore((s) => s.subagents.find((item) => item.id === runId))
  const turns = useMemo<Turn[]>(() => {
    if (!run) return []
    return groupIntoTurns(
      run.transcript
        .filter((item) => item.role !== 'user' || item.text !== run.task)
        .map((item) => ({ ...item, sourceCwd: item.sourceCwd ?? run.cwd }))
    )
  }, [run])
  const streamRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  useLayoutEffect(() => {
    const el = streamRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [turns])

  if (!run) return <div className="v3-split-empty" data-testid="v3-split-agent-missing">{t('delegate.missing')}</div>
  return (
    <div className="v3-conv">
      <div
        className="v3-stream"
        ref={streamRef}
        onScroll={(event) => {
          const el = event.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <div className="v3-stream-inner">
          {turns.length === 0 ? (
            <div className="v3-empty"><p className="v3-empty-hint">{t('sa.waitingMessages')}</p></div>
          ) : (
            turns.map((turn) => (
              <div key={turn.id} className="v3-stream-row"><TurnView turn={turn} readOnly /></div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function focusSession(target: SplitSessionRef): void {
  const store = useStore.getState()
  store.requestComposerFocus(target)
  if (target.path) {
    void store.switchSession(target.path)
    return
  }
  if (!target.sessionId) return
  const runner = store.runners.find((item) => item.sessionId === target.sessionId)
  store.applyPush({
    ch: 'tray-select-session',
    payload: {
      sessionId: target.sessionId,
      projectId: runner?.projectId,
      cwd: runner?.cwd ?? store.settings?.cwd ?? ''
    }
  })
}

function SplitResizer({ left, right }: { left: SplitSessionRef; right: SplitSessionRef }): JSX.Element {
  const t = useT()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [pair, setPair] = useState<PairMetrics | null>(null)
  const leftKey = splitTileKey(left)
  const rightKey = splitTileKey(right)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    return bindPairObserver(host, (metrics) => setPair((prev) => (samePair(prev, metrics) ? prev : metrics)))
  }, [leftKey, rightKey])

  const total = pair?.total ?? 0
  const bounds = pairBounds(total)

  const resizeTo = (next: number): void => {
    if (!(total > 0)) return
    const share = (useSplitView.getState().weights[leftKey] ?? 1) + (useSplitView.getState().weights[rightKey] ?? 1)
    const weights = weightsForLeft(next, total, share)
    setPair((prev) => (prev ? { left: clampPairValue(next, pairBounds(prev.total)), total: prev.total } : prev))
    useSplitView.getState().setWeights({ [leftKey]: weights.left, [rightKey]: weights.right })
  }

  return (
    <div className="v3-split-resizer" ref={hostRef}>
      <Splitter
        orientation="vertical"
        value={pair ? pair.left : 0}
        min={bounds.min}
        max={bounds.max}
        step={KEY_STEP}
        aria-label={t('tile.resizeWidth')}
        data-testid="v3-split-resizer"
        onChange={resizeTo}
        onReset={() => useSplitView.getState().setWeights({ [leftKey]: 1, [rightKey]: 1 })}
      />
    </div>
  )
}
