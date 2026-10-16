import { FileText, X } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { fmtSize } from '../../components/chat/attachment-files'

export function AttachmentStrip() {
  const t = useT()
  const attachments = useStore((s) => s.attachments)
  const removeAttachment = useStore((s) => s.removeAttachment)
  if (attachments.length === 0) return null

  return (
    <div className="composer-attachments" data-testid="composer-attachments">
      {attachments.map((a) => (
        <div className="ca-tile" key={a.id} title={`${a.name} · ${fmtSize(a.size)}`} data-kind={a.kind ?? 'image'}>
          {a.kind === 'file' ? (
            <span className="ca-file-ico" aria-hidden>
              <FileText size={12} />
            </span>
          ) : (
            <img className="ca-thumb" src={`data:${a.mimeType};base64,${a.preview}`} alt={a.name} />
          )}
          <span className="ca-name">{a.name}</span>
          {a.kind === 'file' ? <span className="ca-size">{fmtSize(a.size)}</span> : null}
          <button
            type="button"
            className="ca-del"
            title={t('composer.removeImage')}
            aria-label={`${t('composer.removeImage')}：${a.name}`}
            onClick={() => removeAttachment(a.id)}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}
