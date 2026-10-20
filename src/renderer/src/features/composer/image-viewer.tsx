import type { JSX } from 'react'
import { Dialog, Modal, ModalOverlay } from '../../ui'
import { useT } from '../../i18n'
import './image-viewer.css'

export function ImageViewer({
  src,
  alt,
  caption,
  isOpen,
  onOpenChange
}: {
  src: string | null
  alt?: string
  caption?: string
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element | null {
  const t = useT()
  if (!isOpen || !src) return null
  return (
    <ModalOverlay className="imgv-overlay" isOpen onOpenChange={onOpenChange} isDismissable>
      <Modal className="imgv-modal">
        <Dialog className="imgv-dialog" title={alt || t('chat.imagePreview')} closeLabel={t('ui.close')}>
          <div className="imgv-body">
            <img className="imgv-image" src={src} alt={alt ?? ''} />
            {caption ? <p className="imgv-caption">{caption}</p> : null}
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
