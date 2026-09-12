import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

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
 * 当前该显示什么状态。
 *
 * 优先级与 pi 一致：压缩 > 重试 > 常规处理。
 * 因为压缩/重试时「正在处理」是误导的 —— 那一刻它在做别的事。
 */
function useStatusText(): { kind: string; text: string } | null {
  const t = useT()
  const session = useStore((s) => s.session)

  if (session?.isCompacting) {
    return { kind: 'compacting', text: t('work.compacting') }
  }
  // 重试中：pi 会显示倒计时。我们拿不到精确的 delay，
  // 所以不编数字（与用量条的速度同一条原则：拿不到就不假装）。
  if (session?.isStreaming) {
    return { kind: 'working', text: t('chat.working') }
  }
  return null
}

/**
 * 顶边框。宽度靠 CSS 的 `flex: 1` 撑满，所以不需要像 TUI 那样算字符数 ——
 * 这是浏览器相对终端的优势，直接用一条可伸缩的横线元素即可。
 */
export function ComposerBorder() {
  const status = useStatusText()
  const level = useStore((s) => s.session?.thinkingLevel ?? 'off')
  const frame = useFrame(!!status)

  return (
    <div
      className={`cborder ${status ? 'busy' : ''}`}
      data-level={level}
      data-state={status?.kind ?? 'idle'}
      data-testid="composer-border"
    >
      {/* 左端固定的 `── ` —— pi 的 renderTopBorder 里就是 '── ' */}
      <span className="cborder-dash lead" aria-hidden>
        ──
      </span>

      {status ? (
        <span className="cborder-status" data-testid="working" role="status" aria-live="polite">
          <span className="cborder-spinner" aria-hidden>
            {frame}
          </span>
          {/* key 让文案变化时重演一次淡入 —— 状态切换是「有新消息」，
              不该是硬切（pi 每次刷新整行，浏览器这边用淡入表达同一件事） */}
          <span className="cborder-text" key={status.text}>
            {status.text}
          </span>
        </span>
      ) : null}

      {/* 剩余宽度：可伸缩的横线。`flex:1` 代替 TUI 里手算 repeat() */}
      <span className="cborder-dash tail" aria-hidden />
    </div>
  )
}
