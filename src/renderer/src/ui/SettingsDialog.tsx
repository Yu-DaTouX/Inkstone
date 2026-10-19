import { useEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { Dialog as RACDialog, Heading, Modal as RACModal } from 'react-aria-components'
import { X } from 'lucide-react'
import { popModal, pushModal } from '../lib/modalLayer'
import { useOptionalT } from '../i18n'
import { cx } from './cx'
import { IconButton } from './IconButton'
import { ModalOverlay } from './Dialog'

function ModalLayerToken(): null {
  const token = useRef(Symbol('settings-dialog'))
  useEffect(() => {
    const current = token.current
    pushModal(current)
    return () => popModal(current)
  }, [])
  return null
}

export interface SettingsDialogProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  title: string
  closeLabel?: string
  nav: ReactNode
  children: ReactNode
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  'data-testid'?: string
}

export function SettingsDialog({
  isOpen,
  onOpenChange,
  title,
  closeLabel,
  nav,
  children,
  onKeyDown,
  'data-testid': testId
}: SettingsDialogProps): ReactElement {
  const t = useOptionalT()
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className="ui-settings-overlay">
      <RACModal className="ui-settings-modal">
        <RACDialog className="ui-settings-dialog">
          {({ close }) => (
            <div className="ui-settings" data-testid={testId} onKeyDown={onKeyDown}>
              <ModalLayerToken />
              <Heading slot="title" className="ui-settings__title">
                {title}
              </Heading>
              {nav}
              <div className="ui-settings__pane">
                <div className="ui-settings__head">
                  <IconButton
                    aria-label={closeLabel ?? t('ui.close')}
                    variant="ghost"
                    className="ui-settings__close"
                    onPress={close}
                    data-testid="settings-close"
                  >
                    <X size={16} aria-hidden="true" />
                  </IconButton>
                </div>
                <div className="ui-settings__content">{children}</div>
              </div>
            </div>
          )}
        </RACDialog>
      </RACModal>
    </ModalOverlay>
  )
}

const NAV_ITEM = '.ui-settings-nav__item'

function moveNavFocus(event: KeyboardEvent<HTMLElement>): void {
  const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight'
  const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
  const edge = event.key === 'Home' || event.key === 'End'
  if (!forward && !backward && !edge) return
  const target = event.target as HTMLElement
  if (!target.matches(NAV_ITEM)) return
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(NAV_ITEM)]
  const at = items.indexOf(target)
  if (at < 0 || items.length === 0) return
  event.preventDefault()
  const next =
    event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (forward ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}

export interface SettingsNavProps {
  label: string
  search?: ReactNode
  children: ReactNode
}

export function SettingsNav({ label, search, children }: SettingsNavProps): ReactElement {
  return (
    <nav className="ui-settings-nav" aria-label={label} onKeyDown={moveNavFocus}>
      {search != null ? <div className="ui-settings-nav__search">{search}</div> : null}
      <div className="ui-settings-nav__scroll">{children}</div>
    </nav>
  )
}

export function SettingsNavGroup({ title, children }: { title?: string; children: ReactNode }): ReactElement {
  return (
    <div className="ui-settings-nav__group" role="group" aria-label={title}>
      {title ? (
        <p className="ui-settings-nav__title" aria-hidden="true">
          {title}
        </p>
      ) : null}
      <ul className="ui-settings-nav__list">{children}</ul>
    </div>
  )
}

export interface SettingsNavItemProps {
  label: ReactNode
  icon?: ReactNode
  hint?: ReactNode
  current?: boolean
  onPress: () => void
  className?: string
  'data-testid'?: string
}

export function SettingsNavItem({ label, icon, hint, current, onPress, className, 'data-testid': testId }: SettingsNavItemProps): ReactElement {
  return (
    <li className="ui-settings-nav__entry">
      <button
        type="button"
        className={cx('ui-settings-nav__item', className)}
        data-active={current ? '1' : '0'}
        data-hint={hint != null ? '1' : undefined}
        aria-current={current ? 'page' : undefined}
        data-testid={testId}
        onClick={onPress}
      >
        {icon != null ? <span className="ui-settings-nav__icon">{icon}</span> : null}
        <span className="ui-settings-nav__text">
          <span className="ui-settings-nav__label">{label}</span>
          {hint != null ? <span className="ui-settings-nav__hint">{hint}</span> : null}
        </span>
      </button>
    </li>
  )
}

export function SettingsNavEmpty({ children }: { children: ReactNode }): ReactElement {
  return (
    <p className="ui-settings-nav__empty" role="status">
      {children}
    </p>
  )
}
