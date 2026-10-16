/**
 * 并排视图（WP-20b，方案 02 §7.7）。
 *
 * 对话区一分为二（乃至更多），每列有自己的会话头与输入框：焦点那一列渲染完整的
 * `SessionView` + `Composer`（也就是主 store 当前投影的会话），其余列是只读投影。
 * 点任意一列把焦点切过去（走正式 `switchSession` / 托盘选择），所以全局快捷键与
 * 输入框始终作用于**当前侧**；列自己的会话身份来自它的会话引用，不受别的会话的
 * 后台推送影响（那类推送到 `sessionRuntimes` 各自会话的键下）。
 *
 * 三种列：
 *   · 会话（焦点）—— 真输入框；
 *   · 会话（非焦点）—— 只读投影 + 同尺寸的输入框外观（点它即切焦点）；
 *   · 子 Agent 转录 —— `subagent:<runId>` 伪列，只读，不能激活（见 SideBySideLayout）。
 *
 * 窄屏由 `collapsedPanes` 退回单栏（分屏状态保留，宽回来恢复）；「关闭一侧」由列头
 * 的关闭按钮移除，剩一列时退出分屏、回到单视图。分屏状态本身属于 `state/split-view`，
 * 本文件只投影与渲染，不新造第二套布局状态。
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
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
  /** 分屏状态；`null` 表示单会话。 */
  split: SplitLayout | null
  /** 窄窗：即使有分屏也只画焦点那一列。 */
  narrow: boolean
}

export function SideBySide({ split, narrow }: SideBySideProps): JSX.Element {
  const layout = collapsedPanes(split, narrow)
  const weights = useSplitView((s) => s.weights)

  /* 单会话：保持与外壳原来的版面一字不差（没有列头，不引入并列语义）。 */
  if (!layout) {
    return (
      <>
        <div className="v3-conv"><SessionView /></div>
        <div className="v3-composer"><Composer /></div>
      </>
    )
  }

  /** 关闭一列：关的是焦点列时先把焦点交给相邻会话，再移除；剩一列就退出分屏。 */
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
}

/* ------------------------------------------------------------------ 列框架 */

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

/** 会话在列表里的那条（先按 id，再按文件） */
function useSplitSummary(target: SplitSessionRef) {
  return useStore(
    (s) =>
      s.sessions.find((item) => !!target.sessionId && item.id === target.sessionId) ??
      s.sessions.find((item) => !!target.path && sameSplitSession({ path: item.path }, { path: target.path }))
  )
}

/** 会话的显示名，与标题栏同一顺序：手动名 > 自动标题 > 会话列表标题 */
function useSplitTitle(target: SplitSessionRef): string {
  const summary = useSplitSummary(target)
  const named = useStore((s) => {
    const id = target.sessionId ?? summary?.id
    return (id && (s.manualTitles[id] || s.titles[id])) || summary?.title || ''
  })
  return named.trim()
}

/** 列头右侧的项目名（有项目记录用记录名，否则退回目录最后一段） */
function useSplitProject(target: SplitSessionRef): string {
  const summary = useSplitSummary(target)
  return useStore((s) => {
    const record = summary?.projectId ? s.settings?.projects.find((item) => item.id === summary.projectId) : undefined
    return record?.name || (record?.cwd ?? summary?.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() || ''
  })
}

/* ------------------------------------------------------------------ 非焦点会话（只读） */

function PeerPane({ target }: { target: SplitSessionRef }): JSX.Element {
  const t = useT()
  const runtime = useStore((s) => (target.sessionId ? s.sessionRuntimes[target.sessionId] : undefined))
  const cached = runtime?.messages
  const shown = useMemo(() => shownMessages(target), [target])
  const [history, setHistory] = useState<UIMessage[] | null>(null)
  /*
   * 只读一侧的内容按自己的会话取：运行缓存（后台还在跑就是实时）优先，
   * 其次这条会话刚才在屏幕上的样子，最后读会话文件。绝不读活动会话的 messages。
   */
  const messages = useMemo(() => newestMessages(cached, shown, history ?? undefined) ?? [], [cached, shown, history])
  const draft = runtime?.draft ?? ''
  const running = !!runtime?.session?.isAgentRunning || !!runtime?.session?.isStreaming
  const waiting = (runtime?.uiRequests.length ?? 0) > 0
  const streamingId = runtime?.session?.isStreaming && messages.length ? messages[messages.length - 1].id : undefined
  const projectTurns = useMemo(() => createTurnProjector(), [])
  const turns = useMemo(() => projectTurns(messages, streamingId), [messages, streamingId, projectTurns])

  /* 没有运行缓存也没有屏幕快照时才读盘（每次打开只读一次） */
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
        /* 列头（关闭按钮）与列内按钮自己处理；拖选了文字也不切，留给用户复制 */
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

/* ------------------------------------------------------------------ 子 Agent 转录列 */

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

/* ------------------------------------------------------------------ 焦点切换 */

/**
 * 把焦点切到这一列。`requestComposerFocus` 让真输入框取得光标；会话有文件就正式切换，
 * 还没落盘的新会话只有 id，沿用托盘「按 id 选中运行实例」的同一条路径。
 */
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

/* ------------------------------------------------------------------ 列宽拖动 */

/**
 * 分屏相邻两列之间的分隔条。
 *
 * 交互全部由 `ui/Splitter` 原语实现：指针捕获、方向键 / Home / End、
 * `role="separator"` 与 aria 值、聚焦与禁用状态；这里只做两件事：
 *   · 从相邻两列的真实像素宽得出原语的像素 `value` 与拖动范围（min/max）；
 *   · 把原语给出的新像素宽换算成这两列的宽度份额（合计不变，其余列不动）。
 * 拖动靠原语在按下那一刻记的值 + 指针位移，不依赖 pointerdown 后立刻重渲。
 */
function SplitResizer({ left, right }: { left: SplitSessionRef; right: SplitSessionRef }): JSX.Element {
  const t = useT()
  /* 原语不转发 ref（配置式组件），用一层不产生盒子的宿主读取左右两列 */
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [pair, setPair] = useState<PairMetrics | null>(null)
  const leftKey = splitTileKey(left)
  const rightKey = splitTileKey(right)

  /* 两列真实像素：挂载先量一次，窗口或列宽变化时复读；换列、卸载即断开观察 */
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    return bindPairObserver(host, (metrics) => setPair((prev) => (samePair(prev, metrics) ? prev : metrics)))
  }, [leftKey, rightKey])

  const total = pair?.total ?? 0
  const bounds = pairBounds(total)

  /* 原语给来新的左列像素宽：换算成这两列的份额（合计不变），其余列不动 */
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
