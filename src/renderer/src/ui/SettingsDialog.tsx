import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { Dialog as RACDialog, Heading, Modal as RACModal } from 'react-aria-components'
import { Search, SearchX, X } from 'lucide-react'
import { popModal, pushModal } from '../lib/modalLayer'
import { useOptionalT } from '../i18n'
import { cx } from './cx'
import { IconButton } from './IconButton'
import { ModalOverlay } from './Dialog'

const NARROW_QUERY = '(max-width: 767px)'

function ModalLayerToken(): null {
  const token = useRef(Symbol('settings-dialog'))
  useEffect(() => {
    const current = token.current
    pushModal(current)
    return () => popModal(current)
  }, [])
  return null
}

export function useSettingsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY)
    const update = (): void => setNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return narrow
}

export interface SettingsDialogProps {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  title: string
  closeLabel?: string
  nav: ReactNode
  narrowNav?: ReactNode
  narrow?: boolean
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
  narrowNav,
  narrow,
  children,
  onKeyDown,
  'data-testid': testId
}: SettingsDialogProps): ReactElement {
  const t = useOptionalT()
  const stacked = narrow === true && narrowNav != null
  return (
    <ModalOverlay isOpen={isOpen} onOpenChange={onOpenChange} isDismissable className="ui-settings-overlay">
      <RACModal className="ui-settings-modal">
        <RACDialog className="ui-settings-dialog">
          {({ close }) => {
            const closeButton = (
              <IconButton
                aria-label={closeLabel ?? t('ui.close')}
                variant="ghost"
                className="ui-settings__close"
                onPress={close}
                data-testid="settings-close"
              >
                <X size={16} aria-hidden="true" />
              </IconButton>
            )
            return (
              <div
                className="ui-settings"
                data-density-scope="comfortable"
                data-layout={stacked ? 'stacked' : 'split'}
                data-testid={testId}
                onKeyDown={onKeyDown}
              >
                <ModalLayerToken />
                <Heading slot="title" className="ui-settings__title">
                  {title}
                </Heading>
                {stacked ? (
                  <header className="ui-settings-narrow">
                    <div className="ui-settings-narrow__head">
                      <strong className="ui-settings-narrow__title" aria-hidden="true">
                        {title}
                      </strong>
                      {closeButton}
                    </div>
                    {narrowNav}
                  </header>
                ) : (
                  nav
                )}
                <div className="ui-settings__pane">
                  {stacked ? null : <div className="ui-settings__head">{closeButton}</div>}
                  <div className="ui-settings__content">{children}</div>
                </div>
              </div>
            )
          }}
        </RACDialog>
      </RACModal>
    </ModalOverlay>
  )
}

const NAV_ITEM = '.ui-settings-nav__item'

function moveNavFocus(event: KeyboardEvent<HTMLElement>): void {
  const forward = event.key === 'ArrowDown'
  const backward = event.key === 'ArrowUp'
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
  current?: boolean
  onPress: () => void
  className?: string
  'data-testid'?: string
}

export function SettingsNavItem({ label, icon, current, onPress, className, 'data-testid': testId }: SettingsNavItemProps): ReactElement {
  return (
    <li className="ui-settings-nav__entry">
      <button
        type="button"
        className={cx('ui-settings-nav__item', className)}
        data-active={current ? '1' : '0'}
        aria-current={current ? 'page' : undefined}
        data-testid={testId}
        onClick={onPress}
      >
        {icon != null ? <span className="ui-settings-nav__icon">{icon}</span> : null}
        <span className="ui-settings-nav__label">{label}</span>
      </button>
    </li>
  )
}

const TAB_ITEM = '[role="tab"]'

function moveTabFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
  const rtl = getComputedStyle(event.currentTarget).direction === 'rtl'
  const forwardKey = rtl ? 'ArrowLeft' : 'ArrowRight'
  const backwardKey = rtl ? 'ArrowRight' : 'ArrowLeft'
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>(TAB_ITEM)]
  const at = tabs.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return
  const next =
    event.key === forwardKey
      ? (at + 1) % tabs.length
      : event.key === backwardKey
        ? (at - 1 + tabs.length) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : -1
  if (next < 0) return
  event.preventDefault()
  for (const tab of tabs) tab.tabIndex = -1
  const target = tabs[next]
  if (!target) return
  target.tabIndex = 0
  target.focus()
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

export function SettingsTabBar({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="ui-settings-tabs" role="tablist" aria-label={label} onKeyDown={moveTabFocus}>
      {children}
    </div>
  )
}

export interface SettingsTabProps {
  label: ReactNode
  selected?: boolean
  onPress: () => void
  'data-testid'?: string
}

export function SettingsTab({ label, selected, onPress, 'data-testid': testId }: SettingsTabProps): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      className="ui-settings-tab"
      aria-selected={selected ? 'true' : 'false'}
      tabIndex={selected ? 0 : -1}
      data-testid={testId}
      onClick={onPress}
    >
      {label}
    </button>
  )
}

export type SettingsSearchResultKind = 'hit' | 'child' | 'more'

export interface SettingsSearchResult {
  key: string
  kind: SettingsSearchResultKind
  icon?: ReactNode
  primary: string
  secondary?: string
  label: string
  'data-testid'?: string
}

function matchRange(text: string, query: string): [number, number] | null {
  const needle = query.trim().toLowerCase()
  if (!needle) return null
  const start = text.toLowerCase().indexOf(needle)
  if (start < 0 || text.toLowerCase().length !== text.length) return null
  return [start, start + needle.length]
}

export function SettingsSearchMatch({ text, query }: { text: string; query: string }): ReactElement {
  const range = matchRange(text, query)
  if (!range) return <>{text}</>
  return (
    <>
      {text.slice(0, range[0])}
      <mark className="ui-settings-search__match">{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  )
}

export interface SettingsSearchProps {
  value: string
  onChange: (value: string) => void
  results: readonly SettingsSearchResult[]
  onSelect: (result: SettingsSearchResult) => void
  label: string
  placeholder?: string
  resultsLabel: string
  emptyLabel: string
  isDisabled?: boolean
  'data-testid'?: string
}

export const SettingsSearch = forwardRef<HTMLInputElement, SettingsSearchProps>(function SettingsSearch(
  { value, onChange, results, onSelect, label, placeholder, resultsLabel, emptyLabel, isDisabled, 'data-testid': testId },
  ref
) {
  const listId = useId()
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const open = focused && value.trim() !== ''
  const safeActive = results.length === 0 ? -1 : Math.min(active, results.length - 1)

  useEffect(() => {
    setActive(0)
  }, [value])

  useEffect(() => {
    if (!open || safeActive < 0) return
    list.current?.querySelector<HTMLElement>(`[data-index="${safeActive}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, safeActive])

  const choose = (result: SettingsSearchResult | undefined, input: HTMLInputElement): void => {
    if (!result) return
    onSelect(result)
    input.blur()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) {
      if (event.key === 'Escape') event.stopPropagation()
      return
    }
    if (!open) return
    const input = event.currentTarget
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onChange('')
      input.blur()
    } else if (event.key === 'Tab') {
      onChange('')
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const size = Math.max(1, results.length)
      setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + size) % size)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(results[safeActive], input)
    }
  }

  return (
    <div
      className="ui-settings-search"
      data-disabled={isDisabled ? '1' : undefined}
      data-testid={testId}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('.ui-settings-search__results') || target.tagName === 'INPUT') return
        event.preventDefault()
        event.currentTarget.querySelector('input')?.focus()
      }}
    >
      <Search className="ui-settings-search__icon" size={20} aria-hidden="true" />
      <input
        ref={ref}
        className="ui-settings-search__input"
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && safeActive >= 0 ? `${listId}-${safeActive}` : undefined}
        placeholder={placeholder}
        value={value}
        disabled={isDisabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          onChange('')
        }}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <div
          ref={list}
          id={listId}
          className="ui-settings-search__results"
          role={results.length > 0 ? 'listbox' : undefined}
          aria-label={resultsLabel}
        >
          {results.length > 0 ? (
            results.map((result, index) => (
              <div
                key={result.key}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === safeActive}
                aria-label={result.label}
                className="ui-settings-search__result"
                data-kind={result.kind}
                data-index={index}
                data-highlighted={index === safeActive ? '' : undefined}
                data-testid={result['data-testid']}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(index)}
                onClick={() => {
                  const input = list.current?.parentElement?.querySelector('input')
                  onSelect(result)
                  input?.blur()
                }}
              >
                {result.kind === 'hit' ? (
                  <span className="ui-settings-search__hit">
                    <span className="ui-settings-search__heading">
                      {result.icon != null ? <span className="ui-settings-search__glyph">{result.icon}</span> : null}
                      <span className="ui-settings-search__primary">
                        <SettingsSearchMatch text={result.primary} query={value} />
                      </span>
                    </span>
                    {result.secondary ? (
                      <span className="ui-settings-search__via">
                        <SettingsSearchMatch text={result.secondary} query={value} />
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="ui-settings-search__child">
                    {result.kind === 'child' ? <SettingsSearchMatch text={result.primary} query={value} /> : result.primary}
                  </span>
                )}
              </div>
            ))
          ) : (
            <div className="ui-settings-search__empty" role="status">
              <SearchX size={28} aria-hidden="true" />
              <span>{emptyLabel}</span>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
})
