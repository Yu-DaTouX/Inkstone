import type { JSX } from 'react'
import { useT } from '../i18n'
import { shortTokens, type ContextUsageSummary } from '../features/workbench/context-pane-view'
import './context-ring.css'

export type ContextTone = ContextUsageSummary['tone']

export function ContextRingGlyph({ percent, tone }: { percent: number | null; tone: ContextTone }): JSX.Element {
  const R = 5
  const C = 2 * Math.PI * R
  const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  const dash = (clamped / 100) * C
  return (
    <svg className="ctx-ring-svg" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle className="ctx-ring-track" cx="7" cy="7" r={R} fill="none" strokeWidth="2" />
      {percent !== null ? (
        <circle
          className="ctx-ring-arc"
          data-tone={tone}
          cx="7"
          cy="7"
          r={R}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${C}`}
          transform="rotate(-90 7 7)"
        />
      ) : null}
    </svg>
  )
}

export function ContextGauge({
  usage,
  className,
  'data-testid': testId
}: {
  usage: Pick<ContextUsageSummary, 'tokens' | 'windowSize' | 'percent' | 'tone'>
  className?: string
  'data-testid'?: string
}): JSX.Element {
  const t = useT()
  const label = t('ctx.usedOf', { used: shortTokens(usage.tokens), win: shortTokens(usage.windowSize) })
  return (
    <span
      className={className ? `ctx-gauge ${className}` : 'ctx-gauge'}
      data-tone={usage.tone}
      role="img"
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      <ContextRingGlyph percent={usage.percent} tone={usage.tone} />
      <span className="ctx-gauge-text" aria-hidden>
        {usage.percent === null ? '—' : `${Math.round(usage.percent)}%`}
      </span>
    </span>
  )
}
