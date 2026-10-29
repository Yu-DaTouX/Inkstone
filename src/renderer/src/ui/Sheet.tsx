import { useEffect, useRef, type ReactNode } from 'react'
import { Dialog as RACDialog, Modal as RACModal, ModalOverlay as RACModalOverlay } from 'react-aria-components'
import { popModal, pushModal } from '../lib/modalLayer'
import { cx } from './cx'
import './PanelTabs.css'

export interface SheetProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  label: string
  className?: string
  testId?: string
  children: ReactNode
}

function SheetModalToken() {
  const token = useRef(Symbol('ui-sheet'))
  useEffect(() => {
    const current = token.current
    pushModal(current)
    return () => popModal(current)
  }, [])
  return null
}

export function Sheet({ isOpen, onOpenChange, label, className, testId, children }: SheetProps) {
  return (
    <RACModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className="ui-sheet-overlay">
      <RACModal className={cx('ui-sheet', className)} data-testid={testId}>
        <RACDialog aria-label={label} className="ui-sheet__dialog">
          <SheetModalToken />
          {children}
        </RACDialog>
      </RACModal>
    </RACModalOverlay>
  )
}
