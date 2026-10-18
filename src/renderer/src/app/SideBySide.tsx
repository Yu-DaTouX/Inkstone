import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Eye, FileDiff, FolderOpen, GitBranch, Globe, GripVertical, PanelRight, ScrollText, Terminal, type LucideIcon } from 'lucide-react'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { createTurnProjector, groupIntoTurns, type Turn } from '../../../shared/turns'
import type { UIMessage } from '../../../shared/ipc'
import { nearestSessionOf, sameSplitSession, splitTileKey, useSplitView, type SplitLayout, type SplitSessionRef } from '../state/split-view'
import { closeToolTile, dockToolTile, fitPaneTiles, toolTabOf, useTileCapacity, watchChatWidth } from '../features/workbench/tool-tiles'
import { trackTileDrag } from '../features/workbench/tile-drag'
import { toolTileText } from '../features/workbench/tool-tile-text'
import { workbenchText } from '../features/workbench/workbench-text'
import { ToolTileBody } from '../features/workbench/ToolTileBody'
import type { WorkbenchTabId } from '../features/workbench/types'
import { newestMessages, shownMessages } from '../state/split-snapshots'
import { SessionView } from '../features/session/SessionView'
import { ChatSubagentPanel } from '../features/session/SubagentPanel'
import { subagentTitle } from '../features/session/SubagentLine'
import type { TurnSubagentScope } from '../state/subagent-view'
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
  panelInChat?: boolean
}

export const SideBySide = memo(function SideBySide({ split, narrow, panelInChat = false }: SideBySideProps): JSX.Element {
  const capacity = useTileCapacity()
  const layout = fitPaneTiles(collapsedPanes(split, narrow), capacity)
  const weights = useSplitView((s) => s.weights)

  if (!layout || !split) {
    return (
      <>
        <div className="v3-conv"><SessionView subagentPanel={!panelInChat} /></div>
        <div className="v3-composer"><Composer /></div>
        {panelInChat ? <ChatSubagentPanel /> : null}
      </>
    )
  }

  const closePane = (index: number): void => {
    const view = useSplitView.getState()
    const current = view.split
    if (!current) return
    if (index === current.live) {
      const neighbor = current.tiles[nearestSessionOf(current.tiles, index)]
      if (neighbor && isSessionTile(neighbor) && neighbor.path) void useStore.getState().switchSession(neighbor.path)
    }
    view.remove(index)
  }

  const movable = !narrow && layout.tiles.length > 1
  const liveTarget = layout.tiles[layout.live]
  const shown = layout.tiles
  const slotAt = (position: number): number => {
    if (position <= 0) return split.tiles.indexOf(shown[0])
    if (position < shown.length) return split.tiles.indexOf(shown[position])
    return split.tiles.indexOf(shown[shown.length - 1]) + 1
  }

  return (
    <div className="v3-split" data-testid="v3-split" ref={watchChatWidth}>
      {shown.map((target, position) => {
        const runId = subagentRunIdOf(target)
        const tool = toolTabOf(target)
        const live = position === layout.live
        const index = split.tiles.indexOf(target)
        return (
          <Fragment key={splitTileKey(target) || `pane-${index}`}>
            {position > 0 ? <SplitResizer left={shown[position - 1]} right={target} /> : null}
            <PaneFrame
              target={target}
              owner={liveTarget}
              index={index}
              leftSlot={slotAt(position - 1)}
              rightSlot={slotAt(position + 2)}
              movable={movable}
              live={live}
              weight={weights[splitTileKey(target)] ?? 1}
              onClose={() => (tool ? closeToolTile(tool) : closePane(index))}
            >
              {tool ? (
                <ToolTileBody tab={tool} />
              ) : runId ? (
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

const TOOL_ICONS: Partial<Record<WorkbenchTabId, LucideIcon>> = {
  changes: FileDiff,
  terminal: Terminal,
  files: FolderOpen,
  browser: Globe,
  preview: Eye,
  logs: ScrollText,
  branch: GitBranch
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
  leftSlot,
  rightSlot,
  movable,
  live,
  weight,
  onClose,
  children
}: {
  target: SplitSessionRef
  owner: SplitSessionRef
  index: number
  leftSlot: number
  rightSlot: number
  movable: boolean
  live: boolean
  weight: number
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  const t = useT()
  const { lang } = useI18n()
  const tool = toolTabOf(target)
  const tileText = toolTileText(lang)
  const toolName = tool ? workbenchText(lang).tabs[tool] : ''
  const sessionTitle = useSplitTitle(tool ? owner : target)
  const agentTask = useStore((s) => {
    const id = subagentRunIdOf(target)
    return id ? s.subagents.find((item) => item.id === id)?.task ?? '' : ''
  })
  const title = agentTask ? subagentTitle(agentTask) : sessionTitle
  const project = useSplitProject(target)
  const key = splitTileKey(target)
  const ToolIcon = tool ? TOOL_ICONS[tool] : undefined

  const startDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('[data-tile-action]')) return
    trackTileDrag(event, { id: key, title: tool ? toolName : title || t('split.untitled') }, (at) => useSplitView.getState().move(index, at))
  }

  const moveByKey = (event: ReactKeyboardEvent): void => {
    const to = event.key === 'ArrowLeft' ? leftSlot : event.key === 'ArrowRight' ? rightSlot : null
    if (to === null) return
    event.preventDefault()
    useSplitView.getState().move(index, to)
    focusGrip(key)
  }

  return (
    <section
      className="v3-split-col"
      data-live={live ? '1' : '0'}
      data-kind={tool ? 'tool' : subagentRunIdOf(target) ? 'agent' : 'session'}
      data-testid="v3-split-col"
      data-pane={target.sessionId ?? target.path ?? ''}
      data-tile-key={key}
      data-split-index={index}
      data-tool-tile={tool ?? undefined}
      tabIndex={tool ? -1 : undefined}
      style={{ flexGrow: weight, flexBasis: 0 }}
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
  const subagentScope = useMemo<TurnSubagentScope>(() => ({ sessionIds: [], parentRunIds: [runId] }), [runId])
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
              <div key={turn.id} className="v3-stream-row"><TurnView turn={turn} subagentScope={subagentScope} readOnly /></div>
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
