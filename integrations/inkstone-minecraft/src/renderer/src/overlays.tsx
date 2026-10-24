import type { ReactElement, ReactNode } from 'react'
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components'
import { X } from 'lucide-react'
import { Button } from '@yan/ui/Button'
import { IconButton } from '@yan/ui/IconButton'

interface ConfirmDialogProps {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm(): void
  onCancel(): void
}

export function ConfirmDialog({ open, title, children, confirmLabel, danger, busy, onConfirm, onCancel }: ConfirmDialogProps): ReactElement {
  return (
    <ModalOverlay className="ui-modal-overlay" isOpen={open} isDismissable={!busy} onOpenChange={(next) => !next && onCancel()}>
      <Modal className="ui-modal" data-dialog-size="sm">
        <Dialog role="alertdialog" className="ui-dialog ui-dialog--alert">
          <div className="ui-dialog__head">
            <Heading slot="title" className="ui-dialog__title">
              {title}
            </Heading>
          </div>
          <div className="ui-dialog__body">
            <div className="confirm__text">{children}</div>
            <div className="confirm__actions">
              <Button variant="ghost" onPress={onCancel} isDisabled={busy}>
                取消
              </Button>
              <Button variant={danger ? 'danger' : 'primary'} onPress={onConfirm} isDisabled={busy} autoFocus>
                {confirmLabel}
              </Button>
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

interface SheetProps {
  open: boolean
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
  onClose(): void
}

export function Sheet({ open, title, actions, children, onClose }: SheetProps): ReactElement {
  return (
    <ModalOverlay className="sheet-overlay" isOpen={open} isDismissable onOpenChange={(next) => !next && onClose()}>
      <Modal className="sheet">
        <Dialog className="sheet__dialog">
          <header className="sheet__head">
            <Heading slot="title" className="sheet__title">
              {title}
            </Heading>
            <div className="sheet__actions">{actions}</div>
            <IconButton aria-label="关闭" size="sm" onPress={onClose}>
              <X size={16} />
            </IconButton>
          </header>
          <div className="sheet__body">{children}</div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
