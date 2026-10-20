import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ImageOff } from 'lucide-react'
import { Button, EmptyState } from '../../ui'
import type { PreviewText } from './preview-text'

export function SvgView({
  text,
  name,
  labels,
  onViewSource
}: {
  text: string
  name: string
  labels: PreviewText
  onViewSource: () => void
}): ReactElement {
  const url = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(text ?? ''))}`, [text])
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  if (failed) {
    return (
      <EmptyState
        className="v3-preview-media-error"
        data-testid="v3-preview-svg-error"
        icon={<ImageOff size={20} />}
        role="alert"
        title={labels.frameFailed}
        action={
          <Button size="sm" variant="secondary" onPress={onViewSource}>
            {labels.sourceMode}
          </Button>
        }
      />
    )
  }
  return (
    <figure className="v3-preview-media" data-testid="v3-preview-svg" data-media-format="svg">
      <img src={url} alt={name} draggable={false} onError={() => setFailed(true)} />
    </figure>
  )
}
