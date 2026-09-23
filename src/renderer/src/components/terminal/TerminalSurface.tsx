/**
 * 交互终端表面（实施-11 H-11）。
 *
 * 与浏览器不同，终端是**纯 DOM**（xterm.js 画在 canvas / DOM 上），所以不需要
 * 原生视图协调；它只是右栏工作窗口的又一个资源页。
 *
 * 三条设计决定：
 *   ① **输出只走推送、不走 store**：PTY 输出是高频的，每个 chunk 进一次
 *      zustand 会让整个右栏重算。这里直接订阅 `window.yan.onPush` 写进 xterm。
 *   ② **重连 = reset + 回放**：切标签 / 重开面板都重新 `attach`，主进程把
 *      有界缓冲推回来；快照上的 `seq` 用来丢弃已经包含在缓冲里的实时块，
 *      不靠时间窗猜。
 *   ③ **不可用要说清楚**：原生依赖装不上时显示原因与重试，而不是一个
 *      点了没反应的终端框（H-11 禁区：不做灰色永久占位按钮）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../../state/store'
import { useT } from '../../i18n'
import { Icon } from '../../icons/Icon'

/**
 * xterm 的主题：**从 tokens.css 的 CSS 变量读**，不写死两份色值。
 *
 * 为什么不能用 `data-theme` 上硬编码的两份常量：主题不只深/浅两套（将来可能加），
 * 而且硬编码一份就多一份会和 tokens 漂移的真源。xterm 读不到 CSS 变量，
 * 所以只能在挂载与 `data-theme` 变化时把计算值取过来。
 */
function currentTheme(): {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
} {
  if (typeof window === 'undefined') {
    return { background: '#151515', foreground: '#ecece8', cursor: '#93a4f4', selectionBackground: 'rgba(147,164,244,0.28)' }
  }
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim()
    return value || fallback
  }
  return {
    background: read('--bg-0', '#151515'),
    foreground: read('--fg', '#ecece8'),
    cursor: read('--accent', '#93a4f4'),
    selectionBackground: read('--accent-soft', 'rgba(147,164,244,0.28)')
  }
}

export function TerminalSurface() {
  const t = useT()
  const terminals = useStore((s) => s.terminals)
  const activeId = useStore((s) => s.activeTerminalId)
  const available = useStore((s) => s.terminalAvailable)
  const error = useStore((s) => s.terminalError)
  const refresh = useStore((s) => s.refreshTerminals)
  const startTerminal = useStore((s) => s.startTerminal)
  const closeTerminal = useStore((s) => s.closeTerminal)
  const setActiveTerminal = useStore((s) => s.setActiveTerminal)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  /** 当前已接收到的输出序号（用于重连去重） */
  const seqRef = useRef(0)
  /** 输入回调要读到最新活动 id，但不重建 xterm 实例 */
  const activeIdRef = useRef<string | null>(activeId)
  const [exited, setExited] = useState<number | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  const active = terminals.find((item) => item.id === activeId) ?? null

  const fit = useCallback(() => {
    const term = termRef.current
    const fitAddon = fitRef.current
    const host = hostRef.current
    if (!term || !fitAddon || !host || host.clientWidth < 16 || host.clientHeight < 16) return
    try {
      fitAddon.fit()
    } catch {
      /* 尺寸过小 / 正在卸载：忽略 */
    }
    if (activeId) void window.yan.terminal.resize(activeId, term.cols, term.rows)
  }, [activeId])

  /* 建立 xterm 实例（一次），主题跟随 data-theme */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: 'var(--font-mono)',
      fontSize: 12.5,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: currentTheme()
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(host)
    termRef.current = term
    fitRef.current = fitAddon
    setReady(true)

    /* 用户输入 → 宿主 PTY */
    const dataSub = term.onData((data) => {
      const id = activeIdRef.current
      if (id) void window.yan.terminal.write(id, data)
    })

    const observer = new ResizeObserver(() => fit())
    observer.observe(host)
    /* 主题切换：xterm 不读 CSS 变量，得手动同步一次 */
    const themeObserver = new MutationObserver(() => {
      term.options.theme = currentTheme()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      dataSub.dispose()
      observer.disconnect()
      themeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      setReady(false)
    }
    // 实例只建一次；activeId 的变化由下面那个 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * attach 之前到达的实时块先进队列。
   *
   * 为什么需要队列：快照（含已有缓冲）与实时推送走的是**两条不同的 IPC 通道**，
   * 到达顺序不保证。若先收到实时块就直接写，后到的快照缓冲会把顺序搅反。
   * 所以“attach 完成前只收不发”，完成后按序号回放，天然去重。
   */
  const pendingRef = useRef<{ seq: number; data: string }[]>([])
  const attachedRef = useRef(false)

  /* 订阅宿主推送：只收数据与退出 */
  useEffect(() => {
    const off = window.yan.onPush((msg) => {
      if (msg.ch !== 'terminal') return
      const payload = msg.payload
      if (payload.kind === 'data') {
        if (payload.id !== activeIdRef.current) return
        const seq = payload.seq ?? 0
        const data = payload.data ?? ''
        if (!attachedRef.current) {
          pendingRef.current.push({ seq, data })
          return
        }
        /* 重连回放的块序号 ≤ 快照序号时已经写过了，丢弃 */
        if (seq <= seqRef.current) return
        seqRef.current = seq
        termRef.current?.write(data)
      } else if (payload.id === activeIdRef.current) {
        setExited(payload.exitCode ?? null)
      }
    })
    return off
  }, [])

  /* 活动会话变化：清屏 → attach（缓冲回放 + 排空队列） */
  useEffect(() => {
    const term = termRef.current
    if (!term || !ready) return
    setExited(null)
    term.reset()
    seqRef.current = 0
    pendingRef.current = []
    attachedRef.current = false
    if (!activeId) {
      attachedRef.current = true
      return
    }
    let alive = true
    void window.yan.terminal.attach(activeId).then((snapshot) => {
      if (!alive) return
      if (snapshot) {
        /* 快照里的缓冲直接写入（队列里同序号的回放块会被去重丢弃） */
        if (snapshot.buffer) term.write(snapshot.buffer)
        seqRef.current = snapshot.seq
        if (!snapshot.alive) setExited(snapshot.exitCode ?? null)
      }
      /* 排空 attach 期间到达的实时块（按到达顺序，序号严格递增） */
      const queued = pendingRef.current
      pendingRef.current = []
      attachedRef.current = true
      for (const chunk of queued) {
        if (chunk.seq <= seqRef.current) continue
        seqRef.current = chunk.seq
        term.write(chunk.data)
      }
      void window.yan.terminal.resize(activeId, term.cols, term.rows)
      term.focus()
      fit()
    })
    return () => {
      alive = false
    }
  }, [activeId, ready, fit])

  /* 进入终端页时刷新一次宿主会话列表（重连 / 重启渲染进程后） */
  useEffect(() => {
    void refresh()
  }, [refresh])

  const newTerminal = useCallback(async () => {
    const cols = termRef.current?.cols ?? 80
    const rows = termRef.current?.rows ?? 24
    const snapshot = await startTerminal({ cols, rows })
    if (snapshot) {
      setExited(null)
      setActiveTerminal(snapshot.id)
    }
  }, [startTerminal, setActiveTerminal])

  const closeActive = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) return
    await closeTerminal(id)
    const next = useStore.getState().terminals[0]
    setActiveTerminal(next?.id ?? null)
  }, [closeTerminal, setActiveTerminal])

  if (!available) {
    return (
      <div className="term-unavailable" data-testid="terminal-unavailable">
        <Icon name="activity" size={16} />
        <div className="term-unavailable-text">
          <div>{t('term.unavailable')}</div>
          {error ? <code data-testid="terminal-error">{error}</code> : null}
        </div>
        <button type="button" className="rp-btn" onClick={() => void refresh()} data-testid="terminal-retry">
          {t('term.retry')}
        </button>
      </div>
    )
  }

  return (
    <div className="term-surface" data-testid="terminal-surface">
      <div className="term-bar" data-testid="terminal-bar">
        <span className="term-bar-title" title={active?.cwd}>
          {active ? active.title : t('term.none')}
        </span>
        {active && !active.alive ? (
          <span className="term-bar-exited" data-testid="terminal-exited">
            {t('term.exited', { code: exited === null ? '—' : String(exited) })}
          </span>
        ) : null}
        <span className="spacer" />
        <button type="button" className="rp-btn" onClick={() => void newTerminal()} data-testid="terminal-new">
          <Icon name="plus" size={12} />
          {t('term.new')}
        </button>
        {active ? (
          <button type="button" className="rp-btn" onClick={() => void closeActive()} data-testid="terminal-close">
            {t('term.close')}
          </button>
        ) : null}
      </div>
      <div className="term-host" ref={hostRef} data-testid="terminal-host" />
    </div>
  )
}
