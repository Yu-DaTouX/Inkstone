import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { neighborOf, sameSplitSession, useSplitView, type SplitSessionRef } from '../../state/split-view'
import { createTurnProjector } from '../../../../shared/turns'
import type { UIMessage } from '../../../../shared/ipc'
import { Badge, IconButton, RunDot } from '../ui'
import { Icon } from '../../icons/Icon'
import { TurnView } from './TurnView'
import { ConversationOutline } from './ConversationOutline'
import { fitComposerHeight } from './Composer'
import { ComposerBorderIdle } from './ComposerBorder'
import { latestTimestamp, newestMessages, rememberScroll, rememberShown, restoreScrollAnchor, scrollAnchorOf, shownMessages, shownScroll } from '../../state/split-snapshots'

/**
 * 分屏里**没有焦点**的那条会话（设计规范 §4「分屏」）。
 *
 * 只读投影：内容来自会话运行缓存（后台还在跑的会话会实时更新），其次是这条会话刚才在屏幕上
 * 显示的内容（焦点刚离开时接着显示，不闪空白），都没有才读会话文件。
 * 底部是与真输入框同尺寸的外观（显示草稿），上面盖一层淡遮罩。单击这一块先把焦点切过来并把
 * 光标放进输入框 —— 这一下不交给里面的按钮：它们操作的是当前活动会话，焦点没过来之前点下去
 * 会作用到另一条会话上。拖选文字不算单击。
 */
export function SplitPeerPane({ index, target }: { index: number; target: SplitSessionRef }) {
  const t = useT()
  const runtime = useStore((s) => (target.sessionId ? s.sessionRuntimes[target.sessionId] : undefined))
  const cached = runtime?.messages
  const running = !!runtime?.session?.isAgentRunning || !!runtime?.session?.isStreaming
  /*
   * 显示哪一份（焦点换块时版面不跳、内容不缺的关键）：
   *   · 失焦后这条会话又跑过 → 运行缓存（后台推送实时更新，流式中的消息时间不变，只能这样认）；
   *   · 否则在「它在焦点时屏幕上的那份 / 会话文件 / 运行缓存」里取最后一条消息最新的，一样新取靠前的。
   * 运行缓存可能是很早以前的旧版本，也不收只推给活动会话的补丁（成果卡片）；而且它把工具结果单列，
   * 条数多不代表新 —— 所以比时间，不比条数。
   */
  const [sawRun, setSawRun] = useState(false)
  useEffect(() => { if (running) setSawRun(true) }, [running])
  const [shown] = useState(() => shownMessages(target))
  const [history, setHistory] = useState<{ path: string; messages: UIMessage[] } | null>(null)
  /* 手上的最新一份比会话列表里的更新时间还旧（或根本没有）才读文件：每次焦点换块都会重挂载，不能每次读盘 */
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

  /* 贴底跟随：停在底部时新内容进来继续贴底；往上翻了就不打扰 */
  const streamRef = useRef<HTMLDivElement>(null)
  /* 外观输入框与真输入框同一高度规则（草稿或占位文字决定）；窗口变了重算 */
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return undefined
    fitComposerHeight(el)
    const observer = new ResizeObserver(() => fitComposerHeight(el))
    observer.observe(el.parentElement ?? el)
    return () => observer.disconnect()
  }, [draft])
  /* 刚失焦时接着停在焦点时的位置；之后停在底部就跟随新内容 */
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
  /*
   * 内容自己长高（成果卡片的预览、图片、代码块后加载）或列宽变了（换行变多）时，消息条数没变、
   * 也没有滚动事件 —— 停在底部的仍要贴住底部，否则最后一张卡片会落到可视区下面，看着像往上滚了。
   */
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
    <section
      className="center split-peer"
      data-testid="split-peer"
      data-split-tile={index}
      aria-label={t('split.peerLabel', { title: title || t('split.untitled') })}
      onClickCapture={(e) => {
        if ((e.target as HTMLElement).closest('[data-split-own]')) return
        /* 刚在这一块里拖选了文字：留给用户复制，不切焦点 */
        const selection = window.getSelection()
        if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return
        e.preventDefault()
        e.stopPropagation()
        focus()
      }}
    >
      <SplitPaneHead index={index} target={target} firstUserText={firstUserText} />
      {/* 与焦点那块同一条导航轨：正文让位的量一致，换块时不横移 */}
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
      {/* 与真输入框同一套外观与尺寸：焦点换过来时版面不跳 */}
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
  )
}

/**
 * 把焦点切到分屏里的这一块。`composer`：同时把光标放进它的输入框（点在会话上）；
 * 点在它旁边的工具上时不要，光标留给工具。
 */
export function focusSplitSession(target: SplitSessionRef, composer: boolean): void {
  const store = useStore.getState()
  if (composer) store.requestComposerFocus(target)
  if (target.path) void store.switchSession(target.path)
  /* 还没落盘的新会话只有 id：沿用托盘「按 id 选中运行实例」的同一条路径 */
  else if (target.sessionId) {
    const runner = store.runners.find((r) => r.sessionId === target.sessionId)
    store.applyPush({ ch: 'tray-select-session', payload: { sessionId: target.sessionId, projectId: runner?.projectId, cwd: runner?.cwd ?? store.settings?.cwd ?? '' } })
  }
}

/** 会话在列表里的那条（先按 id，再按文件） */
function useSplitSummary(target: SplitSessionRef) {
  return useStore((s) =>
    s.sessions.find((x) => !!target.sessionId && x.id === target.sessionId) ??
    s.sessions.find((x) => !!target.path && sameSplitSession({ path: x.path }, { path: target.path })))
}

/** 会话的显示名，与标题栏同一顺序：手动名 > 自动标题 > 会话列表 > 首条用户消息 */
function useSplitTitle(target: SplitSessionRef, firstUserText?: string): string {
  const summary = useSplitSummary(target)
  const named = useStore((s) => {
    const id = target.sessionId ?? summary?.id
    return (id && (s.manualTitles[id] || s.titles[id])) || summary?.title || ''
  })
  return named || (firstUserText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * 分屏两侧顶部的会话头（参考 Claude Code：分屏时标题从窗口标题栏移到各自磁贴上方）。
 * 焦点一侧传入完整会话头（标题、视图切换、项目胶囊）；另一侧是同字号标题 + 项目标签。
 * 右端是关闭这一侧。标记 `data-split-own`：在非焦点一侧点它不算「切焦点」。
 */
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

/** 关闭分屏里的一块：关的是焦点那一块时，焦点先去邻近的一块；只剩一块就退出分屏 */
export function closeSplitTile(index: number): void {
  /* 先让这一列淡出（.closing，见 motion.css），再真正移除；同一列重复点关闭只算一次 */
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
