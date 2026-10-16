/**
 * 折叠 hunk 里成片的未改动行。纯函数，无 IO。
 *
 * git 默认只给 3 行上下文，本来没什么可折的；但 `-U10` / `format-patch`
 * 会给出很长的上下文，全画出来会淹没真正的改动。规则与常见 diff 工具一致：
 * 改动前后各保留 `keep` 行，其余折成一条「展开 N 行」。
 */
import { DIFF_LIMITS } from './limits'
import type { DiffLine } from './types'

export type FoldRow =
  | { kind: 'line'; line: DiffLine }
  | {
      kind: 'gap'
      /** 被折起来的行数。 */
      count: number
      /** 这段折叠区第一行的旧 / 新行号；不可信时为 null。 */
      oldStart: number | null
      newStart: number | null
      /** 被折起来的原始行，展开时原样放回（只含未改动行）。 */
      lines: DiffLine[]
    }

/**
 * @param lines  单个 hunk 的行
 * @param keep   改动前后各保留的上下文行数
 */
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
