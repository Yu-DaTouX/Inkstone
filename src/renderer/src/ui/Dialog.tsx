import { forwardRef, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { popModal, pushModal } from '../lib/modalLayer'
import {
  Dialog as RACDialog,
  DialogTrigger,
  Heading,
  Modal as RACModal,
  ModalOverlay as RACModalOverlay,
  composeRenderProps,
  type DialogProps as RACDialogProps,
  type ModalOverlayProps
} from 'react-aria-components'
import { useOptionalT } from '../i18n'
import { cx } from './cx'
import { Button } from './Button'
import { CloseButton } from './IconButton'

export { DialogTrigger }
export type { DialogTriggerProps } from 'react-aria-components'

export const ModalOverlay = forwardRef<HTMLDivElement, ModalOverlayProps>(function ModalOverlay(
  { className, ...props },
  ref
) {
  return (
    <RACModalOverlay
      {...props}
      ref={ref}
      className={composeRenderProps(className, (cn) => cx('ui-modal-overlay', cn))}
    />
  )
})

export const Modal = forwardRef<HTMLDivElement, ModalOverlayProps>(function Modal({ className, ...props }, ref) {
  return (
    <RACModal {...props} ref={ref} className={composeRenderProps(className, (cn) => cx('ui-modal', cn))} />
  )
})

export interface DialogProps extends RACDialogProps {
  title?: ReactNode
  closeLabel?: string
  showClose?: boolean
  alert?: boolean
  body?: 'default' | 'flush'
}

export const Dialog = forwardRef<HTMLElement, DialogProps>(function Dialog(
  { title, closeLabel, showClose = true, alert = false, body = 'default', className, children, ...props },
  ref
) {
  const t = useOptionalT()
  const token = useRef(Symbol('v3-dialog'))
  useEffect(() => {
    const current = token.current
    pushModal(current)
    return () => popModal(current)
  }, [])
  return (
    <RACDialog
      {...props}
      role={alert ? 'alertdialog' : props.role}
      ref={ref}
      className={cx('ui-dialog', alert && 'ui-dialog--alert', className)}
    >
      {(renderProps) => (
        <>
          {title != null || (showClose && !alert) ? (
            <div className="ui-dialog__head">
              {title != null ? (
                <Heading slot="title" className="ui-dialog__title">
                  {title}
                </Heading>
              ) : (
                <span />
              )}
              {showClose && !alert ? (
                <CloseButton
                  aria-label={closeLabel ?? t('ui.close')}
                  size="md"
                  className="ui-dialog__close"
                  onPress={renderProps.close}
                />
              ) : null}
            </div>
          ) : null}
          <div className={cx('ui-dialog__body', body === 'flush' && 'ui-dialog__body--flush')}>
            {typeof children === 'function' ? children(renderProps) : children}
          </div>
        </>
      )}
    </RACDialog>
  )
})

export interface DialogFooterProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'bar' | 'bare'
  align?: 'end' | 'between'
}

export function DialogFooter({ variant = 'bare', align = 'end', className, ...rest }: DialogFooterProps) {
  return (
    <div
      {...rest}
      className={cx('ui-dialog__footer', `ui-dialog__footer--${variant}`, className)}
      data-align={align === 'between' ? 'between' : undefined}
    />
  )
}

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl'

export interface ConfirmDialogProps {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  confirmLabel?: ReactNode
  cancelLabel?: ReactNode
  tone?: 'default' | 'danger'
  onConfirm: () => void | Promise<unknown>
  onCancel?: () => void
  isConfirmDisabled?: boolean
  isPending?: boolean
  closeOnConfirm?: boolean
  size?: DialogSize
  footerVariant?: DialogFooterProps['variant']
  'aria-label'?: string
}

export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  onConfirm,
  onCancel,
  isConfirmDisabled = false,
  isPending: isPendingProp,
  closeOnConfirm = true,
  size = 'sm',
  footerVariant = 'bare',
  'aria-label': ariaLabel
}: ConfirmDialogProps) {
  const t = useOptionalT()
  const [running, setRunning] = useState(false)
  const pending = isPendingProp ?? running
  const confirm = (): void => {
    const result = onConfirm()
    if (result != null && typeof (result as Promise<unknown>).then === 'function') {
      setRunning(true)
      ;(result as Promise<unknown>).then(
        () => {
          setRunning(false)
          if (closeOnConfirm) onOpenChange(false)
        },
        () => setRunning(false)
      )
      return
    }
    if (closeOnConfirm) onOpenChange(false)
  }
  const cancel = (): void => {
    onCancel?.()
    onOpenChange(false)
  }
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={(open) => (open ? onOpenChange(true) : cancel())} isDismissable={!pending}>
      <Modal data-dialog-size={size}>
        <Dialog alert title={title} aria-label={ariaLabel} className="ui-confirm">
          {description != null ? <p className="ui-confirm__desc">{description}</p> : null}
          {children}
          <DialogFooter variant={footerVariant}>
            <Button variant="ghost" onPress={cancel} isDisabled={pending}>
              {cancelLabel ?? t('ui.cancel')}
            </Button>
            <Button
              variant={tone === 'danger' ? 'destructive' : 'primary'}
              onPress={confirm}
              isDisabled={isConfirmDisabled}
              isPending={pending}
              autoFocus={tone !== 'danger'}
            >
              {confirmLabel ?? t('ui.confirm')}
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}
