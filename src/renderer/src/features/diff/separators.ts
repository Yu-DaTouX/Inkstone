import type { DiffHunk, DiffLine } from './types'

export interface DiffSeparator {
  kind: 'lines' | 'metadata'
  text: string
  count: number
}

function before(start: number, count: number): number {
  return count === 0 ? start : start - 1
}

function after(start: number, count: number): number {
  return count === 0 ? start : start + count - 1
}

export function hunkSeparators(
  hunks: readonly DiffHunk[],
  linesLabel: (count: number) => string
): (DiffSeparator | null)[] {
  let oldEnd = 0
  let newEnd = 0
  return hunks.map((hunk) => {
    const oldGap = before(hunk.oldStart, hunk.oldCount) - oldEnd
    const newGap = before(hunk.newStart, hunk.newCount) - newEnd
    oldEnd = after(hunk.oldStart, hunk.oldCount)
    newEnd = after(hunk.newStart, hunk.newCount)
    if (oldGap === 0 && newGap === 0) return null
    if (!Number.isSafeInteger(oldGap) || oldGap < 0 || oldGap !== newGap) {
      return { kind: 'metadata', text: hunk.header, count: 0 }
    }
    return { kind: 'lines', text: linesLabel(oldGap), count: oldGap }
  })
}

export function unifiedLineNumber(line: DiffLine): number | null {
  return line.newLine ?? line.oldLine
}
