import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import { Search } from './icons'
import { cx } from './cx'
import { StaticListBox, StaticListBoxItem } from './ListBox'
import { ScrollArea } from './ScrollArea'
import './Combobox.css'

interface ComboboxState {
  listId: string
  highlighted: string | null
  setHighlighted: (key: string | null) => void
  indexOf: (key: string) => number
  select: (key: string) => void
  move: (delta: number | 'first' | 'last') => void
  selectHighlighted: () => boolean
}

const ComboboxContext = createContext<ComboboxState | null>(null)

function useCombobox(): ComboboxState {
  const state = useContext(ComboboxContext)
  if (!state) throw new Error('Combobox parts must be rendered inside <Combobox>')
  return state
}

export interface ComboboxProps {
  keys: readonly string[]
  onValueChange: (key: string) => void
  onHighlightChange?: (key: string | null) => void
  autoHighlight?: boolean
  children: ReactNode
}

export function Combobox({ keys, onValueChange, onHighlightChange, autoHighlight = false, children }: ComboboxProps) {
  const listId = useId()
  const [highlighted, setHighlightedState] = useState<string | null>(null)
  const signature = keys.join('\u0000')
  const onHighlightRef = useRef(onHighlightChange)
  onHighlightRef.current = onHighlightChange

  const setHighlighted = useCallback((key: string | null) => {
    setHighlightedState(key)
    onHighlightRef.current?.(key)
  }, [])

  useEffect(() => {
    const next = autoHighlight ? (keys[0] ?? null) : null
    setHighlighted(next)
  }, [signature, autoHighlight, setHighlighted])

  const indexes = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys])
  const indexOf = useCallback((key: string) => indexes.get(key) ?? -1, [indexes])

  const move = useCallback(
    (delta: number | 'first' | 'last') => {
      if (keys.length === 0) return
      const current = highlighted === null ? -1 : (indexes.get(highlighted) ?? -1)
      let next: number
      if (delta === 'first') next = 0
      else if (delta === 'last') next = keys.length - 1
      else if (current < 0) next = delta > 0 ? 0 : keys.length - 1
      else next = (current + delta + keys.length) % keys.length
      setHighlighted(keys[next] ?? null)
    },
    [highlighted, indexes, keys, setHighlighted]
  )

  const select = useCallback((key: string) => onValueChange(key), [onValueChange])
  const selectHighlighted = useCallback(() => {
    if (highlighted === null || !indexes.has(highlighted)) return false
    onValueChange(highlighted)
    return true
  }, [highlighted, indexes, onValueChange])

  const state = useMemo<ComboboxState>(
    () => ({ listId, highlighted, setHighlighted, indexOf, select, move, selectHighlighted }),
    [listId, highlighted, setHighlighted, indexOf, select, move, selectHighlighted]
  )
  return <ComboboxContext value={state}>{children}</ComboboxContext>
}

export interface ComboboxSearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void
  'aria-label'?: string
}

export const ComboboxSearchInput = forwardRef<HTMLInputElement, ComboboxSearchInputProps>(function ComboboxSearchInput(
  { className, onKeyDown, ...props },
  ref
) {
  const state = useCombobox()
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      state.move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      state.move(-1)
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault()
      state.move('first')
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault()
      state.move('last')
    } else if (event.key === 'Enter') {
      if (state.selectHighlighted()) event.preventDefault()
    }
  }
  const activeIndex = state.highlighted === null ? -1 : state.indexOf(state.highlighted)
  return (
    <div className="ui-combobox__search">
      <Search aria-hidden="true" className="ui-combobox__search-icon" size={15} />
      <input
        {...props}
        ref={ref}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={state.listId}
        aria-activedescendant={activeIndex >= 0 ? `${state.listId}-${activeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
        className={cx('ui-combobox__input', className)}
        onKeyDown={handleKeyDown}
      />
    </div>
  )
})

export interface ComboboxListProps extends HTMLAttributes<HTMLDivElement> {
  'aria-label'?: string
}

export function ComboboxList({ className, children, ...props }: ComboboxListProps) {
  const state = useCombobox()
  return (
    <ScrollArea fade className="ui-combobox__scroll">
      <StaticListBox {...props} id={state.listId} aria-label={props['aria-label'] ?? ''} className={cx('ui-combobox__list', className)}>
        {children}
      </StaticListBox>
    </ScrollArea>
  )
}

export interface ComboboxItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  value: string
  selected?: boolean
  disabled?: boolean
}

export const ComboboxItem = forwardRef<HTMLDivElement, ComboboxItemProps>(function ComboboxItem(
  { value, selected, disabled, className, onClick, onPointerMove, onPointerDown, children, ...props },
  ref
) {
  const state = useCombobox()
  const index = state.indexOf(value)
  const active = state.highlighted === value
  const localRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (active) localRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <StaticListBoxItem
      {...props}
      id={index >= 0 ? `${state.listId}-${index}` : undefined}
      ref={(node) => {
        localRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) (ref as { current: HTMLDivElement | null }).current = node
      }}
      active={active}
      disabled={disabled}
      aria-selected={selected ?? false}
      data-combobox-selected={selected ? '' : undefined}
      className={cx('ui-combobox__item', className)}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        if (!(event.target as HTMLElement).closest('input, textarea')) event.preventDefault()
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event)
        if (!disabled && !active) state.setHighlighted(value)
      }}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || disabled) return
        if ((event.target as HTMLElement).closest('button, a')) return
        state.select(value)
      }}
    >
      {children}
    </StaticListBoxItem>
  )
})

export function ComboboxEmpty({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={cx('ui-combobox__empty', className)}>
      {children}
    </div>
  )
}
