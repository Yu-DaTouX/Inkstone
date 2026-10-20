import { useEffect, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { IconButton } from '../../ui'
import { terminalFindKeyAction, type TerminalFindDirection } from './terminal-find'
import type { TerminalText } from './terminal-text'

export interface TerminalFindBarProps {
  query: string
  noResults: boolean
  text: TerminalText
  onQuery: (query: string) => void
  onStep: (direction: TerminalFindDirection) => void
  onClose: () => void
}

export function TerminalFindBar({ query, noResults, text, onQuery, onStep, onClose }: TerminalFindBarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const action = terminalFindKeyAction(event.nativeEvent)
    if (!action) return
    if (action === 'close') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (action === 'focus') {
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onStep(action)
  }

  return (
    <div
      className="term-find"
      role="search"
      aria-label={text.find}
      data-testid="terminal-find"
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="term-find-input"
        value={query}
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder={text.findPlaceholder}
        aria-label={text.find}
        onChange={(event) => onQuery(event.target.value)}
      />
      <span className="term-find-status" aria-live="polite">
        {noResults ? text.noResults : ''}
      </span>
      <IconButton size="sm" aria-label={text.findPrev} title={text.findPrev} isDisabled={query === ''} onPress={() => onStep('previous')}>
        <ChevronUp size={14} />
      </IconButton>
      <IconButton size="sm" aria-label={text.findNext} title={text.findNext} isDisabled={query === ''} onPress={() => onStep('next')}>
        <ChevronDown size={14} />
      </IconButton>
      <IconButton size="sm" aria-label={text.findClose} title={text.findClose} onPress={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
