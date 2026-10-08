import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { neighborOf, sameSplitSession, useSplitView, type SplitSessionRef } from '../../state/split-view'
import { groupIntoTurns } from '../../../../shared/turns'
import type { UIMessage } from '../../../../shared/ipc'
import { Badge, IconButton, RunDot } from '../ui'
import { TurnView } from './TurnView'

/**
 * 分屏里**没有焦点**的那条会话（设计规范 §4「分屏」）。
 *
 * 只读投影：内容来自会话运行缓存（后台还在跑的会话会实时更新），没有缓存就读会话文件。
 * 输入框收到底部，只剩一行「继续这个会话」。点这一侧任意位置先把焦点切过来 ——
 * 这一下不交给里面的按钮：它们操作的是当前活动会话，焦点没过来之前点下去会作用到另一条会话上。
 */
export function SplitPeerPane({ index, target }: { index: number; target: SplitSessionRef }) {
  const t = useT()
  const runtime = useStore((s) => (target.sessionId ? s.sessionRuntimes[target.sessionId] : undefined))
  const cached = runtime?.messages
  const [history, setHistory] = useState<{ path: string; messages: UIMessage[] } | null>(null)
  const needHistory = !cached?.length && !!target.path
  useEffect(() => {
    if (!needHistory || !target.path) return
    let alive = true
    const path = target.path
    void window.yan.peekSession(path).then((peek) => {
      if (alive) setHistory({ path, messages: peek?.messages ?? [] })
    }).catch(() => { if (alive) setHistory({ path, messages: [] }) })
    return () => { alive = false }
  }, [needHistory, target.path])

  const messages = cached?.length ? cached : history && history.path === target.path ? history.messages : []
  const running = !!runtime?.session?.isAgentRunning || !!runtime?.session?.isStreaming
  const waiting = (runtime?.uiRequests.length ?? 0) > 0
  const streamingId = running ? messages[messages.length - 1]?.id : undefined
  const turns = useMemo(() => groupIntoTurns(messages, streamingId), [messages, streamingId])
  const firstUserText = messages.find((m) => m.role === 'user')?.text
  const title = useSplitTitle(target, firstUserText)

  /* 贴底跟随：停在底部时新内容进来继续贴底；往上翻了就不打扰 */
  const streamRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  useLayoutEffect(() => {
    const el = streamRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [turns])

  const focus = (): void => {
    const store = useStore.getState()
    if (target.path) void store.switchSession(target.path)
    /* 还没落盘的新会话只有 id：沿用托盘「按 id 选中运行实例」的同一条路径 */
    else if (target.sessionId) {
      const runner = store.runners.find((r) => r.sessionId === target.sessionId)
      store.applyPush({ ch: 'tray-select-session', payload: { sessionId: target.sessionId, projectId: runner?.projectId, cwd: runner?.cwd ?? store.settings?.cwd ?? '' } })
    }
  }
  return (
    <section
      className="center split-peer"
      data-testid="split-peer"
      data-split-tile={index}
      aria-label={t('split.peerLabel', { title: title || t('split.untitled') })}
      onClickCapture={(e) => {
        if ((e.target as HTMLElement).closest('[data-split-own]')) return
        e.preventDefault()
        e.stopPropagation()
        focus()
      }}
    >
      <SplitPaneHead index={index} target={target} firstUserText={firstUserText} />
      <div className="stream" ref={streamRef} onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}>
        <div className="stream-inner">
          {turns.map((tt) => <TurnView key={tt.id} turn={tt} streaming={tt.kind === 'assistant' && tt.streaming} />)}
        </div>
      </div>
      <div className="split-peer-bar-wrap">
        <button type="button" className="split-peer-bar" data-split-own data-testid="split-peer-focus" onClick={focus}>
          <span className="split-peer-prompt" aria-hidden>›</span>
          <span className="split-peer-hint">{t('split.continue')}</span>
          {waiting ? <span className="split-peer-state warn">{t('split.waiting')}</span>
            : running ? <span className="split-peer-state"><RunDot />{t('split.running')}</span> : null}
        </button>
      </div>
    </section>
  )
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
  const view = useSplitView.getState()
  const split = view.split
  if (!split) return
  if (index === split.live) {
    const next = split.tiles[neighborOf(split, index)]
    if (next?.path) void useStore.getState().switchSession(next.path)
  }
  view.remove(index)
}
