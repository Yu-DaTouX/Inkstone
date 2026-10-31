import type { JSX } from 'react'
import { useI18n } from '../../i18n'
import { useSplitDrop } from './split-drag'
import type { DropBadgeLabel } from './split-drop-model'
import { splitText, type SplitText } from './split-text'
import './split.css'

function badgeText(label: DropBadgeLabel, text: SplitText): string {
  if (label === 'here') return text.openHere
  if (label === 'swap') return text.swap
  if (label === 'move') return text.moveHere
  return text.splitView
}

export function SplitDropLayer(): JSX.Element | null {
  const { lang } = useI18n()
  const badge = useSplitDrop((s) => s.badge)
  if (!badge) return null
  const text = splitText(lang)
  return (
    <div className="v3-split-drop" aria-hidden data-testid="v3-split-drop">
      <span
        className="v3-split-drop-badge"
        data-hint={badge.hint ? '' : undefined}
        data-label={badge.label}
        style={{ left: badge.box.left, top: badge.box.top, width: badge.box.width, height: badge.box.height }}
        data-testid="v3-split-drop-badge"
      >
        <span className="v3-split-drop-label">{badgeText(badge.label, text)}</span>
      </span>
    </div>
  )
}
