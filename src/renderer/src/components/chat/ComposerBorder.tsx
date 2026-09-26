import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { deriveRunProgress, runPhaseIsActive, type RunProgress } from '../../../../shared/run-progress'
import { formatDuration } from '../../../../shared/duration'

/**
 * 输入框顶边框上的工作状态 —— **pi TUI 的原样实现**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 参考 pi 的真实实现（不是猜的）
 * ══════════════════════════════════════════════════════════════════
 * pi 的 TUI 把这个状态**画在输入框的顶边框上**，而不是单独占一行：
 *
 *   dist/modes/interactive/components/custom-editor.js
 *     renderTopBorder(width, hiddenLineCount) {
 *       let status = this.workingStatusIndicator.renderInBorder(width - 5)
 *       return borderColor('── ')
 *            + status
 *            + borderColor(' ' + '─'.repeat(width - statusWidth - 4))
 *     }
 *
 * 渲染出来就是：
 *
 *   ── ⠋ 正在处理… ─────────────────────────────────────────────
 *   关于聊天栏 按照 pi 的样式来设计▌
 *
 * 三个细节都照抄了：
 *   ① 前缀固定是 `── `（两个横 + 一个空格）
 *   ② 状态后面接一个空格，再用 `─` 把剩余宽度填满
 *   ③ **边框颜色 = 当前思考强度的颜色**
 *      （pi: `theme.getThinkingBorderColor(thinkingLevel)`，
 *        七档各一个颜色：off 深灰 → max 品红）
 *      这样「思考强度」这个抽象档位有了一个常驻的视觉载体。
 *
 * 状态文案也按 pi 的几种来（status-indicator.js）：
 *   Working / Compacting context… / Auto-compacting… / Retrying (1/3) in 5s…
 * ══════════════════════════════════════════════════════════════════
 */

/** pi 用的 10 帧盲文点阵（loader.js 的 DEFAULT_FRAMES，80ms 一帧） */
export const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 80

/** 转动的长度（字符数）—— 与 pi 一致 */ 
function useFrame(active: boolean, frames: string[] = FRAMES): string {
  const [i, setI] = useState(0)

  useEffect(() => {
    if (!active) {
      setI(0)
      return
    }
    // 尊重系统设置：不转，固定一帧（与 CSS 的 reduced-motion 同一原则）
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || frames.length <= 1) return

    const id = setInterval(() => setI((v) => (v + 1) % frames.length), FRAME_MS)
    return () => clearInterval(id)
  }, [active, frames])

  return frames[i] ?? frames[0] ?? ''
}

/**
 * 本回合的运行阶段（实施-21 P1/P2）。
 *
 * 数据全部来自已有 store 快照，不新增 IPC：running（agent_start → settled）、
 * 正文流、最后一条 running 的 toolCall、可见思考流（`thinkingLive`）。
 * 阶段本身由 `deriveRunProgress` 纯投影决定，这里只负责把快照凑齐。
 */
function useRunProgress(): RunProgress | null {
  const session = useStore((s) => s.session)
  const messages = useStore((s) => s.messages)
  const running = !!session?.isAgentRunning || !!session?.isStreaming
  const startedRef = useRef<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) {
      startedRef.current = null
      return undefined
    }
    if (startedRef.current === null) startedRef.current = Date.now()
    /* 秒级心跳只为了“耗时”和长耗时阈值，不拿它推进阶段 */
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])

  if (!running) return null

  /* 只看本回合：最后一条用户消息之后的部分 */
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      lastUser = i
      break
    }
  }
  const turn = messages.slice(lastUser + 1)

  let tool: { name: string; startedAt?: number } | null = null
  let thinking = false
  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const message = turn[i]
    if (message.thinkingLive) thinking = true
    if (!tool) {
      const call = [...(message.toolCalls ?? [])].reverse().find((item) => item.status === 'running')
      if (call) {
        tool = { name: call.name, ...(call.startedAt !== undefined ? { startedAt: call.startedAt } : {}) }
      }
    }
  }

  const requested = !!session?.isStreaming || turn.some((message) => message.role === 'assistant')

  return deriveRunProgress({
    running: true,
    streaming: !!session?.isStreaming,
    tool,
    thinking,
    requested,
    terminal: null,
    startedAt: startedRef.current ?? turn[0]?.timestamp ?? null,
    now
  })
}

/**
 * 顶边框。宽度靠 CSS 的 `flex: 1` 撑满，所以不需要像 TUI 那样算字符数 ——
 * 这是浏览器相对终端的优势，直接用一条可伸缩的横线元素即可。
 */
export function ComposerBorder() {
  const t = useT()
  const progress = useRunProgress()
  const level = useStore((s) => s.session?.thinkingLevel ?? 'off')
  const busy = !!progress && runPhaseIsActive(progress.phase)
  const frame = useFrame(busy)

  /*
   * 阶段文案（实施-21 P2）：只说真的发生了的事。
   * 长耗时（≥30s）只写「仍在运行」—— 细节靠 title 与阶段文案，
   * 不把秒数堆在主行里干扰阅读。
   */
  const text = !progress
    ? ''
    : progress.long
      ? t('run.long')
      : progress.phase === 'tool'
        ? t('run.tool', { name: progress.detail ?? '' })
        : progress.phase === 'thinking'
          ? t('run.thinking')
          : progress.phase === 'responding'
            ? t('run.responding')
            : progress.phase === 'requesting'
              ? t('run.requesting')
              : progress.phase === 'preparing'
                ? t('run.preparing')
                : progress.phase === 'failed'
                  ? t('run.failed')
                  : progress.phase === 'cancelled'
                    ? t('run.cancelled')
                    : t('chat.working')
  const title = progress
    ? [formatDuration(progress.elapsedMs), progress.detail].filter(Boolean).join(' · ')
    : undefined

  return (
    <div
      className={`cborder ${busy ? 'busy' : ''}`}
      data-level={level}
      data-state={busy ? 'working' : 'idle'}
      data-phase={progress?.phase ?? 'idle'}
      data-testid="composer-border"
    >
      {/* 左端固定的 `── ` —— pi 的 renderTopBorder 里就是 '── ' */}
      <span className="cborder-dash lead" aria-hidden>
        ──
      </span>

      {progress ? (
        <span
          className="cborder-status"
          data-testid="working"
          role="status"
          aria-live="polite"
          title={title}
        >
          <span className="cborder-spinner" aria-hidden>
            {frame}
          </span>
          {/* key 让文案变化时重演一次淡入 —— 状态切换是「有新消息」，
              不该是硬切（pi 每次刷新整行，浏览器这边用淡入表达同一件事） */}
          <span className="cborder-text" key={text}>
            {text}
          </span>
        </span>
      ) : null}

      {/* 剩余宽度：可伸缩的横线。`flex:1` 代替 TUI 里手算 repeat() */}
      <span className="cborder-dash tail" aria-hidden />
    </div>
  )
}
