import { useEffect, useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { FindBar } from '../../ui'
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
      data-testid="terminal-find"
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <FindBar
        value={query}
        onChange={onQuery}
        onNext={() => onStep('next')}
        onPrevious={() => onStep('previous')}
        onClose={onClose}
        matchCount={noResults && query !== '' ? 0 : null}
        status={noResults && query !== '' ? text.noResults : undefined}
        placeholder={text.findPlaceholder}
        labels={{ input: text.find, previous: text.findPrev, next: text.findNext, close: text.findClose }}
        autoFocus={false}
        inputRef={inputRef}
      />
    </div>
  )
}
