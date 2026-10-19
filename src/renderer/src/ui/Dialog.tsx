import { forwardRef, useEffect, useRef, type ReactNode } from 'react'
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
import { X } from 'lucide-react'
import { useOptionalT } from '../i18n'
import { cx } from './cx'
import { IconButton } from './IconButton'

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
}

export const Dialog = forwardRef<HTMLElement, DialogProps>(function Dialog(
  { title, closeLabel, showClose = true, className, children, ...props },
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
    <RACDialog {...props} ref={ref} className={cx('ui-dialog', className)}>
      {(renderProps) => (
        <>
          {title != null || showClose ? (
            <div className="ui-dialog__head">
              {title != null ? (
                <Heading slot="title" className="ui-dialog__title">
                  {title}
                </Heading>
              ) : (
                <span />
              )}
              {showClose ? (
                <IconButton
                  aria-label={closeLabel ?? t('ui.close')}
                  variant="ghost"
                  className="ui-dialog__close"
                  onPress={renderProps.close}
                >
                  <X size={16} aria-hidden="true" />
                </IconButton>
              ) : null}
            </div>
          ) : null}
          <div className="ui-dialog__body">
            {typeof children === 'function' ? children(renderProps) : children}
          </div>
        </>
      )}
    </RACDialog>
  )
})
