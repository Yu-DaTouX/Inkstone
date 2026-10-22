import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Eye, FileDiff, FolderOpen, GitBranch, Globe, GripVertical, PanelRight, ScrollText, Terminal, type LucideIcon } from 'lucide-react'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { createTurnProjector } from '../../../shared/turns'
import type { UIMessage } from '../../../shared/ipc'
import { sameSplitSession, splitColumns, splitTileKey, useSplitView, type SplitLayout, type SplitSessionRef } from '../state/split-view'
import { closeToolTile, dockToolTile, fitPaneTiles, toolTabOf, useTileCapacity, watchChatWidth } from '../features/workbench/tool-tiles'
import { toolTileText } from '../features/workbench/tool-tile-text'
import { workbenchText } from '../features/workbench/workbench-text'
import { ToolTileBody } from '../features/workbench/ToolTileBody'
import type { WorkbenchTabId } from '../features/workbench/types'
import { newestMessages } from '../state/split-snapshots'
import { SessionView } from '../features/session/SessionView'
import type { TurnSubagentScope } from '../state/subagent-view'
import { Composer } from '../features/composer/Composer'
import { TurnView } from '../features/session/TurnView'
import { Icon } from '../features/session/Icon'
import { IconButton, Splitter } from '../ui'
import { collapsedPanes } from './SideBySideLayout'
import { closeSplitPane, focusSplitSession } from '../features/split/split-actions'
import { startPaneDrag } from '../features/split/pane-drag'
import { rowBoundsFor, rowSplitFor } from '../features/split/split-drop-model'
import { observeHeight } from '../features/split/split-measure'
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

export interface SideBySideProps {
  split: SplitLayout | null
  narrow: boolean
}

export const SideBySide = memo(function SideBySide({ split, narrow }: SideBySideProps): JSX.Element {
  const capacity = useTileCapacity()
  const layout = fitPaneTiles(collapsedPanes(split, narrow), capacity)
  const weights = useSplitView((s) => s.weights)
  const storedRow = useSplitView((s) => s.rowSplit)
  const [hostHeight, setHostHeight] = useState(0)
  const hostRef = useCallback((element: HTMLDivElement | null) => {
    const stopWidth = watchChatWidth(element)
    const stopHeight = observeHeight(element, setHostHeight)
    return () => {
      stopWidth?.()
      stopHeight?.()
    }
  }, [])

  if (!layout || !split) {
    return <LiveChat />
  }

  const movable = !narrow && layout.tiles.length > 1
  const liveTarget = layout.tiles[layout.live]
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
    const tool = toolTabOf(target)
    const live = position === layout.live
    const index = split.tiles.indexOf(target)
    return (
      <PaneFrame
        target={target}
        owner={liveTarget}
        index={index}
        shown={shown}
        position={position}
        leftSlot={slotAt(position - 1)}
        rightSlot={slotAt(position + 2)}
        movable={movable}
        live={live}
        onClose={() => (tool ? closeToolTile(tool) : closeSplitPane(index))}
      >
        {tool ? (
          <ToolTileBody tab={tool} />
        ) : live ? (
          <LiveChat />
        ) : (
          <PeerPane target={target} />
        )}
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

const TOOL_ICONS: Partial<Record<WorkbenchTabId, LucideIcon>> = {
  changes: FileDiff,
  terminal: Terminal,
  files: FolderOpen,
  browser: Globe,
  preview: Eye,
  logs: ScrollText,
  branch: GitBranch
}

function LiveChat(): JSX.Element {
  const convRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useCallback((element: HTMLDivElement | null) => {
    let base = Infinity
    return observeHeight(element, (height) => {
      base = Math.min(base, height)
      convRef.current?.style.setProperty('--composer-grow', `${height - base}px`)
    })
  }, [])
  return (
    <>
      <div className="v3-conv" ref={convRef}><SessionView /></div>
      <div className="v3-composer" ref={composerRef}><Composer /></div>
    </>
  )
}

function focusGrip(key: string): void {
  requestAnimationFrame(() => {
    const host = [...document.querySelectorAll<HTMLElement>('[data-tile-key]')].find((el) => el.dataset.tileKey === key)
    host?.querySelector<HTMLElement>('[data-tile-grip]')?.focus()
  })
}

function PaneFrame({
  target,
  owner,
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
  owner: SplitSessionRef
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
  const tool = toolTabOf(target)
  const tileText = toolTileText(lang)
  const toolName = tool ? workbenchText(lang).tabs[tool] : ''
  const sessionTitle = useSplitTitle(tool ? owner : target)
  const title = sessionTitle
  const project = useSplitProject(target)
  const key = splitTileKey(target)
  const ToolIcon = tool ? TOOL_ICONS[tool] : undefined
  const inactive = !tool && !live

  const startDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('[data-tile-action]')) return
    startPaneDrag(event, { key, label: tool ? toolName : title || t('split.untitled'), shown, position })
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
    if (node.closest('[data-tile-action], .v3-stream')) return
    focusSplitSession(target)
  }

  return (
    <section
      className="v3-split-col"
      role="region"
      aria-label={tool ? toolName : title || t('split.untitled')}
      aria-current={live && !tool ? 'true' : undefined}
      data-live={live ? '1' : '0'}
      data-kind={tool ? 'tool' : 'session'}
      data-split-inactive={inactive ? '' : undefined}
      data-row={target.below ? '1' : '0'}
      data-testid="v3-split-col"
      data-pane={target.sessionId ?? target.path ?? ''}
      data-tile-key={key}
      data-split-index={index}
      data-tool-tile={tool ?? undefined}
      tabIndex={tool ? -1 : undefined}
      onPointerDownCapture={inactive ? activateOnPress : undefined}
    >
      <header className="v3-split-head" data-split-own data-movable={movable ? '1' : undefined} onPointerDownCapture={movable ? startDrag : undefined}>
        {movable ? (
          <IconButton size="sm" className="v3-split-grip" aria-label={tileText.grip} title={tileText.grip} data-tile-grip data-testid="v3-split-grip" onKeyDown={moveByKey}>
            <GripVertical size={14} />
          </IconButton>
        ) : null}
        {ToolIcon ? <ToolIcon size={15} className="v3-split-icon" aria-hidden /> : null}
        {tool ? (
          <>
            <span className="v3-split-title" title={toolName}>{toolName}</span>
            {title ? <span className="v3-split-proj" title={tileText.owner(title)}>{tileText.owner(title)}</span> : null}
            <IconButton size="sm" className="v3-split-action" aria-label={tileText.dock} title={tileText.dock} onPress={() => dockToolTile(tool)} data-tile-action data-testid="v3-tool-tile-dock">
              <PanelRight size={14} />
            </IconButton>
          </>
        ) : (
          <>
            <span className="v3-split-title" title={title}>{title || t('split.untitled')}</span>
            {project ? <span className="v3-split-proj" title={project}>{project}</span> : null}
          </>
        )}
        <IconButton
          size="sm"
          className="v3-split-action"
          aria-label={tool ? tileText.close : t('split.close')}
          title={tool ? tileText.close : t('split.close')}
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

function PeerPane({ target }: { target: SplitSessionRef }): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const text = splitText(lang)
  const runtime = useStore((s) => (target.sessionId ? s.sessionRuntimes[target.sessionId] : undefined))
  const summary = useSplitSummary(target)
  const cached = runtime?.messages
  const [history, setHistory] = useState<UIMessage[] | null>(null)
  const messages = useMemo(() => newestMessages(cached, history ?? undefined) ?? [], [cached, history])
  const draft = runtime?.draft ?? ''
  const running = !!runtime?.session?.isAgentRunning || !!runtime?.session?.isStreaming
  const waiting = (runtime?.uiRequests.length ?? 0) > 0
  const model = runtime?.session?.model?.name ?? ''
  const cwdBusy = useSameCwdBusy(target, runtime?.session?.cwd ?? summary?.cwd)
  const streamingId = running && messages.length ? messages[messages.length - 1].id : undefined
  const projectTurns = useMemo(() => createTurnProjector(), [])
  const subagentScope = useMemo<TurnSubagentScope>(() => ({ sessionIds: target.sessionId ? [target.sessionId] : [] }), [target.sessionId])
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
        focusSplitSession(target)
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
                <p className="v3-empty-hint">{running ? t('chat.working') : ''}</p>
              </div>
            ) : (
              turns.map((turn) => (
                <div key={turn.id} className="v3-stream-row">
                  <TurnView turn={turn} sessionId={target.sessionId ?? null} subagentScope={subagentScope} streaming={turn.kind === 'assistant' && turn.streaming} readOnly />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="v3-composer">
        <div className="composer" data-testid="v3-split-peer-composer">
          <div className="composer-input">
            <div className="composer-line">
              <textarea
                className="composer-text"
                rows={1}
                readOnly
                value={draft}
                placeholder={t('composer.ph')}
                aria-label={text.activate(summary?.title || t('split.untitled'))}
                onFocus={() => focusSplitSession(target)}
                data-testid="v3-split-peer-input"
              />
            </div>
            <div className="composer-bar">
              <div className="composer-tools">
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
        </div>
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
