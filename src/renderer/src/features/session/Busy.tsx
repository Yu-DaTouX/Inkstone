/**
 * 「模型在工作」的指示：三点依次起伏，取代旋转的圆环。颜色跟随文字，
 * 动画见 `session-look.css` 的 `.v3-busy`（减少动效时静止）。
 */
import type { JSX } from 'react'

export function Busy({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`v3-busy ${className}`.trim()} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}
