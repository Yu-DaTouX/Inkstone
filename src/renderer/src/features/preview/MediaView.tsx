import { useState, type ReactElement } from 'react'
import { FolderOpen, ImageOff } from 'lucide-react'
import { Button, EmptyState } from '../../ui'
import { filePreviewUrl } from '../../lib/file-preview-url'
import type { PreviewFormat } from './preview-format'
import type { PreviewText } from './preview-text'
import { PdfView } from './LazyPdfView'

type MediaFormat = Extract<PreviewFormat, 'image' | 'audio' | 'video' | 'pdf'>

export function MediaView({
  format,
  name,
  abs,
  cwd,
  labels,
  onReveal,
  onOpen
}: {
  format: MediaFormat
  name: string
  abs: string
  cwd?: string
  labels: PreviewText
  onReveal: () => void
  onOpen: () => void
}): ReactElement {
  const [failed, setFailed] = useState(false)
  const url = filePreviewUrl(abs)
  if (format === 'pdf') return <PdfView name={name} abs={abs} cwd={cwd} labels={labels} onOpen={onOpen} />
  if (failed) return <MediaFailure format={format} labels={labels} onReveal={onReveal} />
  return (
    <figure className="v3-preview-media" data-testid={'v3-preview-' + format} data-media-format={format}>
      {format === 'image' ? (
        <img src={url} alt={name} draggable={false} onError={() => setFailed(true)} />
      ) : format === 'audio' ? (
        <audio
          className="v3-preview-audio"
          src={url}
          controls
          preload="metadata"
          aria-label={name}
          onError={() => setFailed(true)}
        />
      ) : (
        <video
          className="v3-preview-video"
          src={url}
          controls
          preload="metadata"
          aria-label={name}
          onError={() => setFailed(true)}
        />
      )}
    </figure>
  )
}

function MediaFailure({
  format,
  labels,
  onReveal
}: {
  format: MediaFormat
  labels: PreviewText
  onReveal: () => void
}): ReactElement {
  return (
    <EmptyState
      className="v3-preview-media-error"
      data-testid="v3-preview-media-error"
      icon={<ImageOff size={20} />}
      role="alert"
      title={labels.mediaLoadFailed}
      description={format === 'image' ? labels.imageLoadFailedHint : labels.mediaLoadFailedHint}
      action={
        <Button size="sm" variant="secondary" icon={<FolderOpen size={14} />} onPress={onReveal}>
          {labels.reveal}
        </Button>
      }
    />
  )
}
