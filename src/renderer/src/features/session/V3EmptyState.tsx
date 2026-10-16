import type { JSX, ReactNode } from 'react'
import { useI18n } from '../../i18n'
import { v3Text } from '../../app/v3-text'
import { UsagePattern } from '../../patterns/UsagePattern'
import { UsageStrip } from '../../patterns/UsageStrip'
import './v3-empty-state.css'

export interface V3EmptyStateProps {
  usage?: ReactNode
}

export function V3EmptyState({ usage }: V3EmptyStateProps = {}): JSX.Element {
  const { lang } = useI18n()
  const text = v3Text(lang)
  return (
    <div className="v3-empty v3-empty-page" data-testid="v3-empty">
      <div className="v3-empty-cols">
        <div className="v3-empty-main">
          <div className="v3-empty-greet">
            <span className="v3-empty-prompt" aria-hidden>&gt;</span>
            <span>HELLO WORLD<span className="v3-hello-cursor" aria-hidden>_</span></span>
          </div>
          {usage === null ? null : (
            <UsageStrip
              text={{ label: text.usageStripLabel, sessions: text.usageStripSessions, days: text.usageStripDays, recent: text.usageStripRecent }}
            />
          )}
        </div>
        {usage === undefined ? <UsagePattern emptyNote={text.usageEmptyNote} /> : usage}
      </div>
    </div>
  )
}
