import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react'
import { cx } from './cx'

export interface InlineRenameProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'size'> {
  defaultValue: string
  'aria-label': string
  onCommit: (value: string) => void
  onCancel?: () => void
  select?: 'all' | 'stem' | 'none'
  commitOnBlur?: boolean
  allowEmpty?: boolean
  commitUnchanged?: boolean
}

export function isImeComposing(event: KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

function stemEnd(value: string): number {
  const dot = value.lastIndexOf('.')
  return dot > 0 ? dot : value.length
}

export const InlineRename = forwardRef<HTMLInputElement, InlineRenameProps>(function InlineRename(
  {
    defaultValue,
    onCommit,
    onCancel,
    select = 'all',
    commitOnBlur = true,
    allowEmpty = false,
    commitUnchanged = false,
    autoFocus = true,
    className,
    onKeyDown,
    onBlur,
    onCompositionStart,
    onCompositionEnd,
    ...rest
  },
  ref
) {
  const inputRef = useRef<HTMLInputElement>(null)
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement)
  const [value, setValue] = useState(defaultValue)
  const composing = useRef(false)
  const settled = useRef(false)

  useEffect(() => {
    const input = inputRef.current
    if (!input || !autoFocus) return
    input.focus()
    if (select === 'all') input.select()
    else if (select === 'stem') input.setSelectionRange(0, stemEnd(input.value))
  }, [autoFocus, select])

  const cancel = (): void => {
    if (settled.current) return
    settled.current = true
    onCancel?.()
  }

  const commit = (): void => {
    if (settled.current) return
    const next = value.trim()
    if ((!allowEmpty && next === '') || (!commitUnchanged && next === defaultValue.trim())) {
      cancel()
      return
    }
    settled.current = true
    onCommit(next)
  }

  return (
    <input
      {...rest}
      ref={inputRef}
      type="text"
      spellCheck={false}
      autoComplete="off"
      value={value}
      className={cx('ui-inline-rename', className)}
      onChange={(event) => setValue(event.currentTarget.value)}
      onCompositionStart={(event) => {
        composing.current = true
        onCompositionStart?.(event)
      }}
      onCompositionEnd={(event) => {
        composing.current = false
        onCompositionEnd?.(event)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (composing.current || isImeComposing(event)) return
        if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          cancel()
        }
      }}
      onBlur={(event) => {
        onBlur?.(event)
        if (commitOnBlur) commit()
        else cancel()
      }}
    />
  )
})
