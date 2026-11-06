import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { sameSplitSession, splitColumns, splitTileKey, useSplitView, type SplitLayout, type SplitSessionRef } from '../state/split-view'
import { Icon } from '../features/session/Icon'
import { Badge, Button, IconButton, Splitter } from '../ui'
import { ChatMain } from './ChatMain'
import { SessionView } from '../features/session/SessionView'
import { ComposerV3 } from '../features/composer/ComposerV3'
import { collapsedPanes } from './SideBySideLayout'
import { closeSplitPane, focusSplitSession } from '../features/split/split-actions'
import { startPaneDrag } from '../features/split/pane-drag'
import { answerSplitSession, usePeerAsk } from '../features/split/peer-ask'
import { rowBoundsFor, rowSplitFor } from '../features/split/split-drop-model'
import { observeHeight, observeWidth } from '../features/split/split-measure'
import { splitText } from '../features/split/split-text'
import {
  KEY_STEP,
  LARGE_KEY_STEP,
  bindPairObserver,
  clampPairValue,
  pairBounds,
  samePair,
  weightsForLeft,
  type PairMetrics
} from './split-resizer-model'
import './SideBySide.css'

const COMPOSER_SETTLE_MS = 250
let liveComposerFloor = 0
const liveComposerListeners = new Set<() => void>()

function reportLiveComposerHeight(height: number): void {
  if (!(height > 0)) return
  const next = liveComposerFloor > 0 ? Math.min(liveComposerFloor, height) : height
  if (next === liveComposerFloor) return
  liveComposerFloor = next
  liveComposerListeners.forEach((listener) => listener())
}

function resetLiveComposerFloor(): void {
  if (liveComposerFloor === 0) return
  liveComposerFloor = 0
  liveComposerListeners.forEach((listener) => listener())
}

function subscribeLiveComposerFloor(listener: () => void): () => void {
  liveComposerListeners.add(listener)
  return () => { liveComposerListeners.delete(listener) }
}

const readLiveComposerFloor = (): number => liveComposerFloor

export interface SideBySideProps {
  split: SplitLayout | null
  narrow: boolean
  maxColumns?: number
}

export const SideBySide = memo(function SideBySide({ split, narrow, maxColumns }: SideBySideProps): JSX.Element {
  const layout = collapsedPanes(split, narrow, maxColumns)
  const weights = useSplitView((s) => s.weights)
  const storedRow = useSplitView((s) => s.rowSplit)
  const [hostHeight, setHostHeight] = useState(0)
  const hostRef = useCallback((element: HTMLDivElement | null) => observeHeight(element, setHostHeight), [])
  useEffect(() => {
    const chat = document.querySelector<HTMLElement>('.v3-chat')
    return observeWidth(chat, (width) => useSplitView.getState().setContainerWidth(width))
  }, [])

  useEffect(() => {
    if (!layout || !split) resetLiveComposerFloor()
  }, [layout, split])

  if (!layout || !split) {
    return <ChatMain />
  }

  const movable = !narrow && layout.tiles.length > 1
  const shown = layout.tiles
  const columns = splitColumns(shown)
  const rowSplit = rowSplitFor(storedRow, hostHeight)
  const slotAt = (position: number): number => {
    if (position <= 0) return split.tiles.indexOf(shown[0])
    if (position < shown.length) return split.tiles.indexOf(shown[position])
    return split.tiles.indexOf(shown[shown.length - 1]) + 1
  }

  const renderPane = (position: number): JSX.Element => {
    const target = shown[position]
    const live = position === layout.live
    const index = split.tiles.indexOf(target)
    return (
      <PaneFrame
        target={target}
        index={index}
        shown={shown}
        position={position}
        leftSlot={slotAt(position - 1)}
        rightSlot={slotAt(position + 2)}
        movable={movable}
        live={live}
        onClose={() => closeSplitPane(index)}
      >
        <PaneBody target={target} live={live} />
      </PaneFrame>
    )
  }

  return (
    <div
      className="v3-split"
      data-testid="v3-split"
      data-columns={columns.length}
      ref={hostRef}
      style={{ '--split-row': rowSplit } as CSSProperties}
    >
      {columns.map((column, at) => {
        const top = shown[column[0]]
        return (
          <Fragment key={splitTileKey(top) || `col-${at}`}>
            {at > 0 ? <SplitResizer left={shown[columns[at - 1][0]]} right={top} /> : null}
            <div
              className="v3-split-column"
              data-col={at}
              data-stacked={column.length > 1 ? '1' : undefined}
              style={{ flexGrow: weights[splitTileKey(top)] ?? 1, flexBasis: 0 }}
            >
              {column.map((position, row) => (
                <Fragment key={splitTileKey(shown[position]) || `pane-${position}`}>
                  {row > 0 ? <RowResizer height={hostHeight} value={rowSplit} /> : null}
                  {renderPane(position)}
                </Fragment>
              ))}
            </div>
          </Fragment>
        )
      })}
    </div>
  )
})

function focusGrip(key: string): void {
  requestAnimationFrame(() => {
    const host = [...document.querySelectorAll<HTMLElement>('[data-tile-key]')].find((el) => el.dataset.tileKey === key)
    host?.querySelector<HTMLElement>('[data-tile-grip]')?.focus()
  })
}

function PaneFrame({
  target,
  index,
  shown,
  position,
  leftSlot,
  rightSlot,
  movable,
  live,
  onClose,
  children
}: {
  target: SplitSessionRef
  index: number
  shown: readonly SplitSessionRef[]
  position: number
  leftSlot: number
  rightSlot: number
  movable: boolean
  live: boolean
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = splitText(lang)
  const title = useSplitTitle(target)
  const project = useSplitProject(target)
  const key = splitTileKey(target)
  const inactive = !live
  const asking = !!usePeerAsk(target) && inactive

  const startDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('[data-tile-action]')) return
    startPaneDrag(event, { key, label: title || t('split.untitled'), shown, position })
  }

  const moveByKey = (event: ReactKeyboardEvent): void => {
    const to = event.key === 'ArrowLeft' ? leftSlot : event.key === 'ArrowRight' ? rightSlot : null
    if (to === null) return
    event.preventDefault()
    useSplitView.getState().move(index, to)
    focusGrip(key)
  }

  const activateOnPress = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!inactive || event.button !== 0) return
    const node = event.target as HTMLElement
    if (node.closest('[data-tile-action], .v3-stream, .v3-split-peer-ask')) return
    focusSplitSession(target)
  }

  return (
    <section
      className="v3-split-col"
      role="region"
      aria-label={title || t('split.untitled')}
      aria-current={live ? 'true' : undefined}
      data-live={live ? '1' : '0'}
      data-kind="session"
      data-split-inactive={inactive ? '' : undefined}
      data-asking={asking ? '' : undefined}
      data-row={target.below ? '1' : '0'}
      data-testid="v3-split-col"
      data-pane={target.sessionId ?? target.path ?? ''}
      data-scroll-key={target.path ?? target.sessionId ?? ''}
      data-tile-key={key}
      data-split-index={index}
      onPointerDownCapture={inactive ? activateOnPress : undefined}
    >
      <header className="v3-split-head" data-split-own data-movable={movable ? '1' : undefined} onPointerDownCapture={movable ? startDrag : undefined}>
        {movable ? (
          <IconButton size="sm" className="v3-split-grip" aria-label={text.grip} title={text.grip} data-tile-grip data-testid="v3-split-grip" onKeyDown={moveByKey}>
            <GripVertical size={14} />
          </IconButton>
        ) : null}
        <span className="v3-split-title" title={title}>{title || t('split.untitled')}</span>
        {project ? <span className="v3-split-proj" title={project}>{project}</span> : null}
        <IconButton
          size="sm"
          className="v3-split-action"
          aria-label={t('split.close')}
          title={t('split.close')}
          onPress={onClose}
          data-tile-action
          data-testid="v3-split-close"
        >
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

const samePath = (a?: string, b?: string): boolean => !!a && !!b && a.replace(/[\\/]+/g, '/').toLowerCase() === b.replace(/[\\/]+/g, '/').toLowerCase()

function useSameCwdBusy(target: SplitSessionRef, cwd: string | undefined): boolean {
  return useStore((s) => {
    if (!cwd) return false
    const live = s.session
    if (live && live.sessionId !== target.sessionId && (live.isAgentRunning || live.isStreaming) && samePath(live.cwd, cwd)) return true
    return Object.entries(s.sessionRuntimes).some(
      ([id, runtime]) => id !== target.sessionId && (!!runtime.session?.isAgentRunning || !!runtime.session?.isStreaming) && samePath(runtime.session?.cwd, cwd)
    )
  })
}

function PaneBody({ target, live }: { target: SplitSessionRef; live: boolean }): JSX.Element {
  const pane = useMemo(() => ({ target, live }), [target, live])
  const convRef = useRef<HTMLDivElement | null>(null)
  const ownComposerHeight = useRef(0)
  const lastLiveHeight = useRef(0)
  const floor = useSyncExternalStore(subscribeLiveComposerFloor, readLiveComposerFloor)
  const applyComposerHeight = useCallback(() => {
    const own = ownComposerHeight.current
    convRef.current?.style.setProperty('--composer-h', `${Math.max(own, readLiveComposerFloor(), live ? 0 : lastLiveHeight.current)}px`)
  }, [live])
  const composerRef = useCallback((element: HTMLDivElement | null) => {
    let settle = 0
    const stop = observeHeight(element, (height) => {
      ownComposerHeight.current = height
      if (live) {
        window.clearTimeout(settle)
        settle = window.setTimeout(() => {
          lastLiveHeight.current = height
          reportLiveComposerHeight(height)
        }, COMPOSER_SETTLE_MS)
      }
      applyComposerHeight()
    })
    return () => {
      window.clearTimeout(settle)
      stop?.()
    }
  }, [live, applyComposerHeight])
  useLayoutEffect(() => { applyComposerHeight() }, [applyComposerHeight, floor])
  return (
    <div
      className="v3-split-peer"
      data-testid={live ? undefined : 'v3-split-peer'}
      onClickCapture={live ? undefined : (event) => {
        if ((event.target as HTMLElement).closest('a, button, input, textarea, select, summary, [role="button"], [role="link"], .v3-md-code-link, [data-split-own]')) return
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed && event.currentTarget.contains(selection.anchorNode)) return
        focusSplitSession(target)
      }}
    >
      <div className="v3-conv" ref={convRef}><SessionView pane={pane} /></div>
      <div className="v3-composer" ref={composerRef}>{live ? <ComposerV3 /> : <PeerComposer target={target} />}</div>
    </div>
  )
}

function PeerComposer({ target }: { target: SplitSessionRef }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = splitText(lang)
  const runtime = useStore((s) => (target.sessionId ? s.sessionRuntimes[target.sessionId] : undefined))
  const paneTitle = useSplitTitle(target)
  const summary = useSplitSummary(target)
  const draft = runtime?.draft ?? ''
  const running = !!runtime?.session?.isAgentRunning || !!runtime?.session?.isStreaming
  const ask = usePeerAsk(target)
  const waiting = !!ask
  const model = runtime?.session?.model?.name ?? ''
  const cwdBusy = useSameCwdBusy(target, runtime?.session?.cwd ?? summary?.cwd)

  return ask ? (
    <div className="v3-split-peer-ask" role="group" aria-label={ask.kind === 'approval' ? t('split.waitingApproval') : t('split.waiting')} data-testid="v3-split-peer-ask">
      <div className="v3-split-peer-bar">
        <Badge tone="ask">{ask.kind === 'approval' ? t('split.waitingApproval') : t('split.waiting')}</Badge>
        {model ? <span className="v3-split-model">{model}</span> : null}
      </div>
      {ask.text ? <p className="v3-split-peer-ask-text">{ask.text}</p> : null}
      <div className="v3-split-peer-bar">
        <Button size="sm" variant="secondary" onPress={() => answerSplitSession(target)} data-testid="v3-split-peer-answer">
          {ask.kind === 'approval' ? t('split.handle') : t('split.answer')}
        </Button>
      </div>
    </div>
  ) : (
    <div className="v3-split-peer-composer" data-testid="v3-split-peer-composer">
      <textarea
        className="v3-split-peer-input"
        rows={1}
        readOnly
        value={draft}
        placeholder={text.activate(paneTitle || t('split.untitled'))}
        aria-label={text.activate(paneTitle || t('split.untitled'))}
        onFocus={() => focusSplitSession(target)}
        data-testid="v3-split-peer-input"
      />
      <div className="v3-split-peer-bar">
        <div className="v3-split-peer-state">
          {waiting ? (
            <span className="v3-split-state" data-tone="ask">{t('split.waiting')}</span>
          ) : running ? (
            <span className="v3-split-state" data-tone="run">{t('split.running')}</span>
          ) : cwdBusy ? (
            <span className="v3-split-state" data-testid="v3-split-peer-cwd-busy">{text.sameCwdRunning}</span>
          ) : null}
        </div>
        {model ? <span className="v3-split-model">{model}</span> : null}
      </div>
    </div>
  )
}

function RowResizer({ height, value }: { height: number; value: number }): JSX.Element {
  const { lang } = useI18n()
  const bounds = rowBoundsFor(height)
  const fixed = !(height > 0) || bounds.min >= bounds.max
  return (
    <Splitter
      className="v3-split-row-resizer"
      orientation="horizontal"
      value={Math.round(value * height)}
      min={Math.round(bounds.min * height)}
      max={Math.round(bounds.max * height)}
      step={KEY_STEP}
      largeStep={LARGE_KEY_STEP}
      isDisabled={fixed}
      aria-label={splitText(lang).resizeRows}
      data-testid="v3-split-row-resizer"
      onChange={(next) => {
        if (height > 0) useSplitView.getState().setRowSplit(next / height)
      }}
      onReset={() => useSplitView.getState().setRowSplit(0.5)}
    />
  )
}

function SplitResizer({ left, right }: { left: SplitSessionRef; right: SplitSessionRef }): JSX.Element {
  const { lang } = useI18n()
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
        largeStep={LARGE_KEY_STEP}
        aria-label={splitText(lang).resizeColumns}
        data-testid="v3-split-resizer"
        onChange={resizeTo}
        onReset={() => useSplitView.getState().setWeights({ [leftKey]: 1, [rightKey]: 1 })}
      />
    </div>
  )
}
