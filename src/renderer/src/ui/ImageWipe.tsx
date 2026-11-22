import { useState, type CSSProperties, type ReactElement } from 'react'
import { SliderThumb, SliderTrack } from 'react-aria-components'
import { InlineImage } from './InlineImage'
import { Slider } from './Slider'
import { cx } from './cx'
import './ImageWipe.css'

export function ImageWipe({ before, after, beforeLabel, afterLabel, label, frameless = false }: {
  before: string
  after: string
  beforeLabel: string
  afterLabel: string
  label: string
  frameless?: boolean
}): ReactElement {
  const [value, setValue] = useState(50)
  const [ratio, setRatio] = useState(1.6)
  return (
    <Slider label={null} aria-label={label} value={value} onChange={(next) => setValue(Number(next))} className={cx('ui-image-wipe', frameless && 'ui-image-wipe--frameless')}>
      <SliderTrack className="ui-image-wipe__track" style={{ '--wipe': `${value}%`, '--wipe-ratio': ratio } as CSSProperties}>
        <InlineImage src={after} alt={afterLabel} draggable={false} className="ui-image-wipe__after" onLoad={frameless ? ({ currentTarget: img }) => {
          if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight)
        } : undefined} />
        <InlineImage src={before} alt={beforeLabel} draggable={false} className="ui-image-wipe__before" />
        <span className="ui-image-wipe__label" data-side="before">{beforeLabel}</span>
        <span className="ui-image-wipe__label" data-side="after">{afterLabel}</span>
        <span className="ui-image-wipe__line" aria-hidden="true" />
        <SliderThumb className="ui-image-wipe__thumb" aria-label={label} />
      </SliderTrack>
    </Slider>
  )
}
