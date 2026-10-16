import { DIFF_LIMITS } from './limits'
import type { DiffLine } from './types'

export type FoldRow =
  | { kind: 'line'; line: DiffLine }
  | {
      kind: 'gap'
      count: number
      oldStart: number | null
      newStart: number | null
      lines: DiffLine[]
    }

export function foldLines(lines: DiffLine[], keep: number = DIFF_LIMITS.contextLines): FoldRow[] {
  const out: FoldRow[] = []
  if (lines.length === 0) return out

  const changed = lines.map((line) => line.kind !== 'context')
  if (!changed.some(Boolean)) {
    out.push({ kind: 'gap', count: lines.length, oldStart: lines[0].oldLine, newStart: lines[0].newLine, lines })
    return out
  }

  let i = 0
  while (i < lines.length) {
    if (changed[i]) {
      out.push({ kind: 'line', line: lines[i] })
      i += 1
      continue
    }
    let j = i
    while (j < lines.length && !changed[j]) j += 1

    const isHead = i === 0
    const isTail = j === lines.length
    let collapseFrom = i
    let collapseTo = j
    if (isHead) collapseTo = Math.max(i, j - keep)
    else if (isTail) collapseFrom = Math.min(j, i + keep)
    else {
      collapseFrom = i + keep
      collapseTo = j - keep
    }

    if (collapseTo > collapseFrom) {
      out.push({
        kind: 'gap',
        count: collapseTo - collapseFrom,
        oldStart: lines[collapseFrom].oldLine,
        newStart: lines[collapseFrom].newLine,
        lines: lines.slice(collapseFrom, collapseTo)
      })
    }
    for (let k = i; k < j; k++) {
      if (k >= collapseFrom && k < collapseTo) continue
      out.push({ kind: 'line', line: lines[k] })
    }
    i = j
  }
  return out
}
