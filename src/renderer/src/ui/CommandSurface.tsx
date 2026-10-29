import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react'
import { Dialog as RACDialog, Modal as RACModal, ModalOverlay as RACModalOverlay } from 'react-aria-components'
import { popModal, pushModal } from '../lib/modalLayer'
import { cx } from './cx'

export interface CommandSurfaceProps {
  isOpen?: boolean
  onOpenChange?: (isOpen: boolean) => void
  'aria-label': string
  width?: 'md' | 'lg'
  isDismissable?: boolean
  className?: string
  children: ReactNode
  'data-testid'?: string
}

function ModalToken() {
  const token = useRef(Symbol('ui-command'))
  useEffect(() => {
    const current = token.current
    pushModal(current)
    return () => popModal(current)
  }, [])
  return null
}

export function CommandSurface({
  isOpen,
  onOpenChange,
  'aria-label': ariaLabel,
  width = 'md',
  isDismissable = true,
  className,
  children,
  'data-testid': testId
}: CommandSurfaceProps) {
  return (
    <RACModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable={isDismissable} className="ui-command-overlay">
      <RACModal className={cx('ui-command', `ui-command--${width}`, className)} data-testid={testId}>
        <RACDialog aria-label={ariaLabel} className="ui-command__dialog">
          <ModalToken />
          {children}
        </RACDialog>
      </RACModal>
    </RACModalOverlay>
  )
}

export function CommandSurfacePanel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('ui-command', 'ui-command--inline', className)} />
}

export function CommandSurfaceHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('ui-command__head', className)} />
}

export function CommandSurfaceBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('ui-command__body', className)} />
}

export function CommandSurfaceFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} className={cx('ui-command__foot', className)} />
}
