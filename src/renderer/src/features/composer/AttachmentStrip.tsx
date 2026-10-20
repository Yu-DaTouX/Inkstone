import { useState } from 'react'
import { FileText, X } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Badge } from '../../ui'
import { fmtSize } from './attachment-files'
import { brokenImageRefs, imageRefLabel, imageRefPrefix } from './image-refs'
import { ImageViewer } from './image-viewer'

export function AttachmentStrip({ onRemoveImage }: { onRemoveImage?: (n: number) => void }) {
  const t = useT()
  const { lang } = useI18n()
  const attachments = useStore((s) => s.attachments)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const [viewing, setViewing] = useState<number | null>(null)
  if (attachments.length === 0) return null
  const prefix = imageRefPrefix(lang)
  let imageNumber = 0
  const imageItems = attachments.map((a) => ({ attachment: a, n: a.kind === 'file' ? 0 : ++imageNumber }))
  const opened = viewing === null ? null : imageItems.find((item) => item.n === viewing)?.attachment

  return (
    <div className="composer-attachments" data-testid="composer-attachments">
      {imageItems.map(({ attachment: a, n }) => (
        <div className="ca-tile" key={a.id} title={`${a.name} · ${fmtSize(a.size)}`} data-kind={a.kind ?? 'image'}>
          {a.kind === 'file' ? (
            <span className="ca-body ca-body-file" aria-hidden>
              <FileText size={16} />
              <span className="ca-ext">{extensionOf(a.name)}</span>
            </span>
          ) : (
            <button
              type="button"
              className="ca-body ca-body-image"
              aria-label={`${t('chat.imageOpen')}：${a.name}`}
              title={`${a.name} · ${fmtSize(a.size)}`}
              data-testid="attachment-open"
              onClick={() => setViewing(n)}
            >
              <img className="ca-thumb" src={`data:${a.mimeType};base64,${a.preview}`} alt={a.name} />
            </button>
          )}
          {a.kind === 'file' ? <span className="ca-name">{a.name}</span> : null}
          {a.kind !== 'file' ? (
            <Badge tone="accent" className="ca-ref" title={t('composer.imageRefHint', { label: `@${imageRefLabel(prefix, n)}` })}>
              {imageRefLabel(prefix, n)}
            </Badge>
          ) : null}
          <button
            type="button"
            className="ca-del"
            title={t('composer.removeImage')}
            aria-label={`${t('composer.removeImage')}：${a.name}`}
            data-testid="attachment-remove"
            tabIndex={0}
            onClick={() => {
              removeAttachment(a.id)
              if (n > 0) onRemoveImage?.(n)
            }}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
      <ImageViewer
        isOpen={!!opened}
        src={opened ? `data:${opened.mimeType};base64,${opened.data}` : null}
        alt={opened?.name}
        caption={opened ? `${opened.name} · ${fmtSize(opened.size)}` : undefined}
        onOpenChange={(open) => {
          if (!open) setViewing(null)
        }}
      />
    </div>
  )
}

function extensionOf(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1] ?? ''
  return ext.toLowerCase()
}

export function ImageRefWarning({ text }: { text: string }) {
  const t = useT()
  const { lang } = useI18n()
  const imageCount = useStore((s) => s.attachments.filter((a) => a.kind !== 'file').length)
  const { missing, removed } = brokenImageRefs(text, imageCount)
  if (missing.length === 0 && removed === 0) return null
  const prefix = imageRefPrefix(lang)
  const labels = [...missing.map((n) => `@${imageRefLabel(prefix, n)}`), ...(removed ? [`@${prefix}?`] : [])]
  return (
    <div className="ca-ref-warn" role="status" data-testid="image-ref-warning">
      {t('composer.imageRefBroken', { list: labels.join(' ') })}
    </div>
  )
}
