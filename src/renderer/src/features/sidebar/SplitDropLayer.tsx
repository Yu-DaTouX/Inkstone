import type { JSX } from 'react'
import { useI18n } from '../../i18n'
import { v3Text } from '../../app/v3-text'
import { useSessionDrag } from './session-drag'
import './split-drop.css'

export function SplitDropLayer(): JSX.Element | null {
  const { lang } = useI18n()
  const text = v3Text(lang)
  const item = useSessionDrag((s) => s.item)
  const zones = useSessionDrag((s) => s.zones)
  const hit = useSessionDrag((s) => s.hit)
  const x = useSessionDrag((s) => s.x)
  const y = useSessionDrag((s) => s.y)
  if (!item) return null
  return (
    <div className="v3-drop-layer" aria-hidden data-testid="v3-split-drop">
      {zones.map((zone, index) => (
        <div
          key={`${zone.at}-${zone.side}`}
          className="v3-drop-zone"
          data-side={zone.side}
          data-hit={index === hit ? '1' : '0'}
          style={{ left: zone.rect.left, top: zone.rect.top, width: zone.rect.width, height: zone.rect.height }}
        >
          {index === hit ? <span className="v3-drop-label">{zone.side === 'left' ? text.dropLeft : text.dropRight}</span> : null}
        </div>
      ))}
      <div className="v3-drop-ghost" data-armed={hit >= 0 ? '1' : '0'} style={{ transform: `translate(${x + 12}px, ${y + 10}px)` }}>
        {item.title}
      </div>
    </div>
  )
}
