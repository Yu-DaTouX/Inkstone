export interface TerminalFindMatch {
  line: number
  column: number
  length: number
}

export type TerminalFindDirection = 'next' | 'previous'

export interface TerminalFindKeyEvent {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}

export type TerminalFindKeyAction = 'focus' | 'close' | 'next' | 'previous'

export function findTerminalMatches(lines: readonly string[], query: string): TerminalFindMatch[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const matches: TerminalFindMatch[] = []
  for (let line = 0; line < lines.length; line += 1) {
    const text = (lines[line] ?? '').toLowerCase()
    let from = 0
    while (from <= text.length - needle.length) {
      const column = text.indexOf(needle, from)
      if (column < 0) break
      matches.push({ line, column, length: needle.length })
      from = column + needle.length
    }
  }
  return matches
}

export function sameMatch(a: TerminalFindMatch | null, b: TerminalFindMatch | null): boolean {
  if (!a || !b) return a === b
  return a.line === b.line && a.column === b.column && a.length === b.length
}

function compareMatches(a: TerminalFindMatch, b: TerminalFindMatch): number {
  return a.line !== b.line ? a.line - b.line : a.column - b.column
}

export function stepTerminalMatchIndex(
  matches: readonly TerminalFindMatch[],
  current: TerminalFindMatch | null,
  direction: TerminalFindDirection
): number {
  const count = matches.length
  if (count === 0) return -1
  if (!current) return direction === 'next' ? 0 : count - 1
  let index = matches.findIndex((match) => sameMatch(match, current))
  if (index < 0) {
    const ordered = matches
    let insert = 0
    while (insert < ordered.length && compareMatches(ordered[insert], current) < 0) insert += 1
    index = insert
    if (direction === 'next') return index >= count ? 0 : index
    return (index - 1 + count) % count
  }
  return direction === 'next' ? (index + 1) % count : (index - 1 + count) % count
}

export function lastTerminalMatchIndex(matches: readonly TerminalFindMatch[]): number {
  return matches.length - 1
}

export function terminalFindKeyAction(event: TerminalFindKeyEvent): TerminalFindKeyAction | null {
  if (event.isComposing) return null
  const mod = !!(event.ctrlKey || event.metaKey)
  if (event.key === 'Escape') return 'close'
  if (mod && !event.altKey && !event.shiftKey && event.code === 'KeyF') return 'focus'
  if (event.key === 'Enter') return event.shiftKey ? 'previous' : 'next'
  if (mod && !event.altKey && event.code === 'KeyG') return event.shiftKey ? 'previous' : 'next'
  return null
}
