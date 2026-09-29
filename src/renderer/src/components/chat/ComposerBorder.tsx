import { useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { deriveRunProgress, runPhaseIsActive, type RunProgress } from '../../../../shared/run-progress'
import { formatDuration } from '../../../../shared/duration'
import { Spinner } from '../ui'

/**
 * 输入区顶边的运行条（设计规范 §3.5）：方点阵 · 阶段文字 · 计时。
 *
 * 只在运行时用 grow 长出来（motion.css 的 .cborder）；空闲时高度为 0，输入框保留完整边框。
 * 思考档位色落在方点阵与运行条底线上（沿用 pi 的七档色，这样档位有个常驻的视觉载体），
 * 文字用中性色。中止在输入框右下角的发送键上，这里不重复放。
 *
 * 阶段文案按 pi 的状态提示来（status-indicator.js）：工作中 / 压缩上下文 / 重试……
 * 阶段本身由 deriveRunProgress 纯投影决定，这里只负责把快照凑齐与显示。
 */

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
      <div className="cborder-row">
        {progress ? (
          <span className="cborder-status" data-testid="working" role="status" aria-live="polite" title={title}>
            {/* 方点阵：思考档位色（motion.css 的 .cborder-spinner） */}
            <Spinner className="cborder-spinner" />
            {/* key 让文案变化时重演一次淡入 */}
            <span className="cborder-text" key={text}>
              {text}
            </span>
          </span>
        ) : null}
        {progress ? <span className="cborder-time">{formatDuration(progress.elapsedMs)}</span> : null}
      </div>
    </div>
  )
}
