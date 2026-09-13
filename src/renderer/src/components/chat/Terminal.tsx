import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { ToolDetail } from './MessageParts'
import type { UIToolCall } from '../../../../shared/ipc'

/**
 * 终端窗口 —— 工具调用详情（用户要求：「类似终端窗口」+「可以调整窗口大小」）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一版做了什么（相对上一版的 `.term` 静态卡片）
 * ══════════════════════════════════════════════════════════════════
 * ① **真正像终端**：
 *    · 标题栏左边是三个窗口灯（装饰）+ 终端脉冲图标 + 工具名
 *    · 右边是状态胶囊（运行中 / ✓ ok / ✕ error）+ 耗时 + 复制 + 展开
 *    · 正文第一行是 prompt 行（`$ 命令` 或 `> 工具名`），输出跟在后面
 * ② **可以调窗口大小**（用户明确要求）：
 *    · 下边缘拖动 = 调高度
 *    · 右边缘拖动 = 调宽度
 *    · 右下角拖动 = 同时调
 *    · 标题栏的展开按钮 = 一键到 72vh
 *    · 双击把手 / Home 键 = 复位
 *    尺寸存在 localStorage（所有终端共用上次调好的大小）。
 * ③ **键盘可用**：把手是 `role="separator"`，↑↓/←→ 调 24px（Shift 96px）。
 *
 * ⚠️ 为什么宽度也允许调：终端里长命令换行很难读，用户经常想「拉宽一点
 *    一行放下整条命令」。但正文列本身是限宽的，所以宽度不会超过父容器
 *    （CSS `max-width:100%` + JS 夹取双保险），拖到边缘就停。
 */

const SIZE_KEY = 'yan.termSize'
const DEFAULT_H = 240
const MIN_H = 80

/** 从 localStorage 读上次的尺寸（脏数据一律当默认，别让坏值把窗口撑爆） */
function loadSize(): { h: number; w: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (raw) {
      const o = JSON.parse(raw) as { h?: unknown; w?: unknown }
      const h = Number(o.h)
      const w = Number(o.w)
      if (Number.isFinite(h) && Number.isFinite(w) && h > 0 && w >= 0) {
        return { h: Math.min(1200, Math.max(MIN_H, Math.round(h))), w: Math.round(w) }
      }
    }
  } catch {
    /* 读不到 / 解析失败都当没有 */
  }
  return { h: DEFAULT_H, w: 0 }
}

function saveSize(size: { h: number; w: number }): void {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(size))
  } catch {
    /* 隐私模式等场景写不了，忽略 */
  }
}

/** 允许的最大高度：视口的 72%（再高就把整屏占了，不像“窗口”了） */
function maxHeight(): number {
  return Math.max(200, Math.round(window.innerHeight * 0.72))
}

export function TerminalWindow({
  call,
  target,
  secs
}: {
  call: UIToolCall
  /** 命令原文 / 路径，标题与 prompt 行用 */
  target: string
  secs: number | null
}) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState(loadSize)
  /** 尺寸的同步真源：拖动松手 / 键盘调完后落盘用它，不依赖异步 state */
  const sizeRef = useRef(size)
  /** 拖动中挂的 document 监听清理函数（组件卸载时兑底） */
  const dragCleanup = useRef<(() => void) | null>(null)
  const [maxed, setMaxed] = useState(false)
  const [copied, setCopied] = useState(false)
  /** 正在拖哪个把手（null = 没拖）；只用于 .dragging 视觉反馈 */
  const [drag, setDrag] = useState<'h' | 'w' | 'both' | null>(null)

  const running = call.status === 'running' || call.status === 'pending'
  const failed = call.status === 'error'

  /* 输出文本（复制 / 提示用） */
  const output = call.output ?? ''

  const clampH = useCallback((h: number): number => Math.min(maxHeight(), Math.max(MIN_H, Math.round(h))), [])
  const clampW = useCallback((w: number, maxW: number): number => {
    if (w <= 0) return 0
    return Math.min(maxW, Math.max(320, Math.round(w)))
  }, [])

  const setSizeBoth = useCallback((next: { h: number; w: number }): void => {
    sizeRef.current = next
    setSize(next)
  }, [])

  const beginDrag = (kind: 'h' | 'w' | 'both') => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = rootRef.current
    if (!el) return
    const maxW = el.parentElement?.clientWidth ?? el.offsetWidth
    const st = {
      kind,
      x: e.clientX,
      y: e.clientY,
      h: el.offsetHeight,
      w: el.offsetWidth,
      maxW
    }
    setMaxed(false)
    setDrag(kind)
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* 测试环境可能不实现 pointer capture */
    }
    document.body.classList.add('resizing-term')

    /*
     * 监听**同步**挂在 document 上（而不是放到 effect 里）。
     * 放 effect 里要等一次 React 渲染才生效 —— 在同一帧内先 pointerdown
     * 再 pointermove 时，第一次移动会被丢掉（探针实测：拖不动；键盘却能调）。
     * 挂 document 还保证鼠标拖快了不会跑出小把手（与面板拖拽同一套）。
     */
    const onMove = (ev: PointerEvent): void => {
      const dy = ev.clientY - st.y
      const dx = ev.clientX - st.x
      let h = st.h
      let w = st.w
      if (st.kind === 'h' || st.kind === 'both') h = clampH(st.h + dy)
      if (st.kind === 'w' || st.kind === 'both') {
        const want = clampW(st.w + dx, st.maxW)
        // 拉满 / 超过容器宽 → 归回 100%（用 0 表示），跟着窗口自适应
        w = want >= st.maxW ? 0 : want
      }
      setSizeBoth({ h, w })
    }
    const finish = (): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', finish)
      dragCleanup.current = null
      document.body.classList.remove('resizing-term')
      setDrag(null)
      saveSize(sizeRef.current)
    }
    dragCleanup.current = finish
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', finish)
  }

  /* 组件在拖动中被卸载时，把 document 监听与 body class 收掉 */
  useEffect(() => () => dragCleanup.current?.(), [])

  /* 键盘调大小（把手可聚焦） */
  const onKeyDown = (kind: 'h' | 'w' | 'both') => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 96 : 24
    let handled = true
    const maxW = rootRef.current?.parentElement?.clientWidth ?? 9999
    let { h, w } = sizeRef.current
    if ((kind === 'h' || kind === 'both') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      h = clampH(h + (e.key === 'ArrowDown' ? step : -step))
    } else if ((kind === 'w' || kind === 'both') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const base = w || rootRef.current?.offsetWidth || 480
      w = clampW(base + (e.key === 'ArrowRight' ? step : -step), maxW)
    } else if (e.key === 'Home') {
      h = DEFAULT_H
      w = 0
    } else {
      handled = false
    }
    if (handled) {
      e.preventDefault()
      setMaxed(false)
      const next = { h, w: w === maxW ? 0 : w }
      setSizeBoth(next)
      saveSize(next)
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(output || target)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* 剪贴板不可用就静默失败（与其它复制入口一致） */
    }
  }

  const toggleMax = (): void => setMaxed((v) => !v)

  /* 内容为空时（比如纯 diff 之外的 read）也给一个最小高度，别只剩标题栏 */
  const style: React.CSSProperties = maxed
    ? { height: `min(${maxHeight()}px, 72vh)`, width: '100%' }
    : {
        height: `${Math.max(MIN_H, size.h)}px`,
        width: size.w > 0 ? `${size.w}px` : '100%'
      }

  return (
    <div
      className={`term ${running ? 'running' : ''} ${maxed ? 'max' : ''} ${drag ? 'dragging' : ''}`}
      ref={rootRef}
      style={style}
      data-testid="tool-terminal"
    >
      <div className="term-bar">
        <span className="term-lights" aria-hidden>
          <span className="term-dot" />
          <span className="term-dot" />
          <span className="term-dot" />
        </span>
        <span className={`term-ico ${running ? 'live' : ''}`} aria-hidden>
          <Icon name="activity" size={12} />
        </span>
        <span className="term-title" title={target || call.name}>
          {call.name}
        </span>
        {target ? <span className="term-cmd" title={target}>{target}</span> : null}
        <span className="spacer" />
        {running ? (
          <span className="term-pill running">{t('term.running')}</span>
        ) : failed ? (
          <span className="term-pill err">{t('term.failed')}</span>
        ) : (
          <span className="term-pill ok">{t('term.ok')}</span>
        )}
        {secs !== null ? <span className="term-time">{secs}s</span> : null}
        <button
          className={`term-act ${copied ? 'on' : ''}`}
          onClick={() => void copy()}
          title={t('term.copy')}
          data-testid="term-copy"
        >
          <Icon name={copied ? 'check' : 'layers'} size={12} />
        </button>
        <button
          className="term-act"
          onClick={toggleMax}
          title={maxed ? t('term.restore') : t('term.expand')}
          data-testid="term-max"
        >
          <Icon name={maxed ? 'sidebar-left' : 'sidebar-right'} size={12} />
        </button>
      </div>

      <div className="term-body">
        {/* prompt 行：让「这是一次命令执行」一眼成立（终端里 `$ ` 的约定） */}
        <div className="term-prompt" aria-hidden>
          <span className="term-prompt-sign">{call.name === 'bash' ? '$' : '>'}</span>
          <span className="term-prompt-text">{target || call.name}</span>
        </div>
        <div className="term-out">
          <ToolDetail call={call} />
          {running ? <span className="term-caret" aria-hidden /> : null}
        </div>
      </div>

      {/* 拖拽把手：下 / 右 / 右下角 */}
      <div
        className="term-grip term-grip-s"
        role="separator"
        aria-orientation="horizontal"
        tabIndex={0}
        title={t('term.resize')}
        aria-label={t('term.resize')}
        onPointerDown={beginDrag('h')}
        onKeyDown={onKeyDown('h')}
        onDoubleClick={() => {
          setMaxed(false)
          const n = { h: DEFAULT_H, w: sizeRef.current.w }
          setSizeBoth(n)
          saveSize(n)
        }}
      />
      <div
        className="term-grip term-grip-e"
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
        title={t('term.resizeW')}
        aria-label={t('term.resizeW')}
        onPointerDown={beginDrag('w')}
        onKeyDown={onKeyDown('w')}
        onDoubleClick={() => {
          setMaxed(false)
          const n = { h: sizeRef.current.h, w: 0 }
          setSizeBoth(n)
          saveSize(n)
        }}
      />
      <div
        className="term-grip term-grip-se"
        role="separator"
        tabIndex={0}
        title={t('term.resize')}
        aria-label={t('term.resize')}
        onPointerDown={beginDrag('both')}
        onKeyDown={onKeyDown('both')}
        onDoubleClick={() => {
          setMaxed(false)
          const n = { h: DEFAULT_H, w: 0 }
          setSizeBoth(n)
          saveSize(n)
        }}
      />
    </div>
  )
}
