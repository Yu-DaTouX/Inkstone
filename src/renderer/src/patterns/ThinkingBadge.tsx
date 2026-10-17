import type { JSX } from 'react'
import { useT, type MessageKey, type TFunc } from '../i18n'
import './model-thinking-picker.css'

const LEVEL_LABEL: Record<string, MessageKey> = {
  off: 'think.off',
  minimal: 'think.minimal',
  low: 'think.low',
  medium: 'think.medium',
  high: 'think.high',
  xhigh: 'think.xhigh',
  max: 'think.max'
}

export function levelLabel(t: TFunc, level: string): string {
  const key = LEVEL_LABEL[level]
  return key ? t(key) : level
}

export function ThinkingBadge({
  level,
  className,
  'data-testid': testId
}: {
  level: string
  className?: string
  'data-testid'?: string
}): JSX.Element {
  const t = useT()
  return (
    <span className={className ? `mtp-level ${className}` : 'mtp-level'} data-level={level} data-testid={testId}>
      {levelLabel(t, level)}
    </span>
  )
}
