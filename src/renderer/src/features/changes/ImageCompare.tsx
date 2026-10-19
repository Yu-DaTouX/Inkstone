import type { ReactElement } from 'react'
import type { GitImageSide } from '../../../../shared/git'
import { formatBytes } from './changes-scope'
import type { ChangesText } from './text'

interface ImageSideViewProps {
  label: string
  side: GitImageSide
  text: ChangesText
}

function ImageSideView({ label, side, text }: ImageSideViewProps): ReactElement {
  const size = side.missing ? '' : formatBytes(side.size)
  return (
    <figure className="changes-pane__image-side">
      <figcaption className="changes-pane__image-caption">
        <span>{label}</span>
        {size ? <span className="changes-pane__image-size">{size}</span> : null}
      </figcaption>
      <div className="changes-pane__image-frame">
        {side.missing ? (
          <span className="changes-pane__image-note">{text.imageMissing}</span>
        ) : side.tooLarge || !side.dataUrl ? (
          <span className="changes-pane__image-note">{text.imageTooLarge}</span>
        ) : (
          <img className="changes-pane__image" src={side.dataUrl} alt={label} draggable={false} />
        )}
      </div>
    </figure>
  )
}

export function ImageCompare({
  before,
  after,
  text
}: {
  before: GitImageSide
  after: GitImageSide
  text: ChangesText
}): ReactElement {
  return (
    <div className="changes-pane__images">
      <ImageSideView label={text.imageBefore} side={before} text={text} />
      <ImageSideView label={text.imageAfter} side={after} text={text} />
    </div>
  )
}
