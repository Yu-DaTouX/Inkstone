import type { ReactElement } from 'react'
import type { RunPhase } from '../../../shared/runs'
import { useI18n } from '../i18n'
import { phaseWord, runTone } from '../state/runs-v3'
import './run-status.css'

export interface RunDotProps {
  /** null = 这条会话还没有运行，渲染一个透明占位保持行对齐 */
  phase: RunPhase | null
  /** 完成 / 失败且用户还没看过：完成态显示一个小点 */
  unread?: boolean
  /** 运行编号（S12 / T03…）；并入读屏词与 title */
  code?: string
}

/**
 * 运行状态点（WP-12）。
 *
 * 8px；只有 `running` 呼吸，其余静止。语义不只靠颜色：每个状态都带
 * `title` 与 `role="img"` 的读屏词，形状也各不相同（圆 / 环 / 方 / 透明）。
 * `done` 默认透明，未读时中间补一个小点 —— 完成不需要持续吸引注意。
 */
export function RunDot({ phase, unread = false, code }: RunDotProps): ReactElement {
  const { lang } = useI18n()
  if (!phase) {
    return <span className="run-dot" data-kind="none" aria-hidden="true" />
  }
  const tone = runTone(phase)
  const word = phaseWord(lang, phase)
  const label = code ? `${code} · ${word}` : word
  const showUnread = unread && (phase.kind === 'done' || phase.kind === 'failed')
  return (
    <span
      className="run-dot"
      data-kind={phase.kind}
      data-tone={tone}
      data-unread={showUnread ? '1' : '0'}
      role="img"
      aria-label={label}
      title={label}
    />
  )
}
