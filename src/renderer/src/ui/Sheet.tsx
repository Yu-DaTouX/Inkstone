import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { Dialog as RACDialog, Modal as RACModal, ModalOverlay as RACModalOverlay } from 'react-aria-components'
import { FocusScope, Overlay, useModalOverlay } from 'react-aria'
import { popModal, pushModal } from '../lib/modalLayer'
import { cx } from './cx'
import './PanelTabs.css'

export interface SheetProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  label: string
  className?: string
  overlayClassName?: string
  testId?: string
  keepMounted?: boolean
  transitionMs?: number
  children: ReactNode
}

const AUTOFOCUS_SELECTORS = [
  '[data-autofocus]',
  '[role="tab"][aria-selected="true"]',
  'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
]

function autofocusTarget(root: HTMLElement): HTMLElement | null {
  for (const selector of AUTOFOCUS_SELECTORS) {
    const found = root.querySelector<HTMLElement>(selector)
    if (found) return found
  }
  return null
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

function RetainedSheet({ isOpen, onOpenChange, label, className, overlayClassName, testId, transitionMs, children }: SheetProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const state = useMemo(
    () => ({
      isOpen,
      setOpen: onOpenChange,
      open: () => onOpenChange(true),
      close: () => onOpenChange(false),
      toggle: () => onOpenChange(!isOpen),
      point: null,
      setPoint: () => {}
    }),
    [isOpen, onOpenChange]
  )
  const { modalProps, underlayProps } = useModalOverlay({ isDismissable: true }, state, ref)

  useEffect(() => {
    if (!isOpen) return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    restoreRef.current = previous
    const frame = requestAnimationFrame(() => {
      const root = ref.current
      if (!root || root.contains(document.activeElement)) return
      ;(autofocusTarget(root) ?? root).focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      const target = restoreRef.current
      restoreRef.current = null
      const root = ref.current
      if (target?.isConnected && (!document.activeElement || document.activeElement === document.body || root?.contains(document.activeElement))) {
        target.focus({ preventScroll: true })
      }
    }
  }, [isOpen])

  const style = transitionMs === undefined ? undefined : ({ '--ui-sheet-ms': `${transitionMs}ms` } as CSSProperties)

  return (
    <Overlay disableFocusManagement>
      <div
        {...underlayProps}
        data-open={isOpen ? '' : undefined}
        aria-hidden={isOpen ? undefined : true}
        className={cx('ui-sheet-overlay', 'ui-sheet-overlay--retained', overlayClassName)}
        style={style}
      >
        <FocusScope contain={isOpen}>
          <div
            {...modalProps}
            ref={ref}
            role="dialog"
            aria-modal={isOpen ? true : undefined}
            aria-label={label}
            tabIndex={-1}
            data-testid={testId}
            className={cx('ui-sheet', 'ui-sheet--retained', className)}
          >
            {isOpen ? <SheetModalToken /> : null}
            <div className="ui-sheet__dialog">{children}</div>
          </div>
        </FocusScope>
      </div>
    </Overlay>
  )
}

export function Sheet(props: SheetProps) {
  if (props.keepMounted) return <RetainedSheet {...props} />
  const { isOpen, onOpenChange, label, className, overlayClassName, testId, children } = props
  return (
    <RACModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className={cx('ui-sheet-overlay', overlayClassName)}>
      <RACModal className={cx('ui-sheet', className)} data-testid={testId}>
        <RACDialog aria-label={label} className="ui-sheet__dialog">
          <SheetModalToken />
          {children}
        </RACDialog>
      </RACModal>
    </RACModalOverlay>
  )
}
