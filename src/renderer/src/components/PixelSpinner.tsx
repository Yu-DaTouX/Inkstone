import { useEffect, useState } from 'react'
import { useT } from '../i18n'

/**
 * pi 风格的等待动画 —— 盲文点字转圈。
 *
 * pi（以及很多终端工具）用盲文字符做 spinner：
 *   ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
 * 这是 2×4 的点阵，逐帧点亮不同的点，肉眼看着就是一个方块在转。
 *
 * 为什么不用 CSS border 转圈：
 *   ① 等宽字体下盲文字符宽度固定，不会推动布局
 *   ② 它就是"终端感"的一部分 —— 用户明确要这个
 *   ③ 不依赖 CSS 动画，`prefers-reduced-motion` 时换个静态字符即可
 */

/** 盲文 spinner 的 10 帧 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function PixelSpinner({ className }: { className?: string }) {
  const [i, setI] = useState(0)

  useEffect(() => {
    // 尊重系统设置：要减少动效就不转，固定显示一帧
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) return

    const id = setInterval(() => setI((v) => (v + 1) % FRAMES.length), 80)
    return () => clearInterval(id)
  }, [])

  return (
    <span className={`spinner ${className ?? ''}`} aria-hidden>
      {FRAMES[i]}
    </span>
  )
}

/**
 * 生成中提示：「⠋ 正在处理…」
 *
 * 放在消息流的底部 —— 流式还没吐出第一个字时，用户需要知道
 * 「它在干活」而不是「卡住了」。
 */
export function Working() {
  const t = useT()
  return (
    <div className="working" data-testid="working">
      <PixelSpinner />
      <span className="working-text">{t('chat.working')}</span>
    </div>
  )
}
