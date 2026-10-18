import { FileText, X } from 'lucide-react'
import { useI18n, useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Badge } from '../../ui'
import { fmtSize } from './attachment-files'
import { brokenImageRefs, imageRefLabel, imageRefPrefix } from './image-refs'

export function AttachmentStrip({ onRemoveImage }: { onRemoveImage?: (n: number) => void }) {
  const t = useT()
  const { lang } = useI18n()
  const attachments = useStore((s) => s.attachments)
  const removeAttachment = useStore((s) => s.removeAttachment)
  if (attachments.length === 0) return null
  const prefix = imageRefPrefix(lang)
  let imageNumber = 0

  return (
    <div className="composer-attachments" data-testid="composer-attachments">
      {attachments.map((a) => {
        const n = a.kind === 'file' ? 0 : ++imageNumber
        return (
          <div className="ca-tile" key={a.id} title={`${a.name} · ${fmtSize(a.size)}`} data-kind={a.kind ?? 'image'}>
            {a.kind === 'file' ? (
              <span className="ca-file-ico" aria-hidden>
                <FileText size={12} />
              </span>
            ) : (
              <>
                <img className="ca-thumb" src={`data:${a.mimeType};base64,${a.preview}`} alt={a.name} />
                <Badge tone="accent" className="ca-ref" title={t('composer.imageRefHint', { label: `@${imageRefLabel(prefix, n)}` })}>
                  {imageRefLabel(prefix, n)}
                </Badge>
              </>
            )}
            <span className="ca-name">{a.name}</span>
            {a.kind === 'file' ? <span className="ca-size">{fmtSize(a.size)}</span> : null}
            <button
              type="button"
              className="ca-del"
              title={t('composer.removeImage')}
              aria-label={`${t('composer.removeImage')}：${a.name}`}
              onClick={() => {
                removeAttachment(a.id)
                if (n > 0) onRemoveImage?.(n)
              }}
            >
              <X size={12} aria-hidden />
            </button>
          </div>
        )
      })}
    </div>
  )
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
