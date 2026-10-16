/**
 * 并排（side-by-side）视图的行对齐。纯函数，无 IO。
 *
 * git 的 hunk 是「先列所有删除、再列所有新增」的顺序（`-` 成组、`+` 成组），
 * 并排视图要把它们两两对上。这里用最朴素也最可预期的策略：一段连续的
 * 删除 / 新增按位置配对成 `replace`，多出来的一侧用空行补齐。刻意不做
 * Myers / 相似度匹配 —— 那会让同一份补丁在不同尺寸窗口下换一种对法，
 * 用户刚记住的行会跳位置。
 */
import type { DiffLine } from './types'

export type DiffSideRowKind = 'context' | 'replace' | 'add' | 'del'

export interface DiffSideRow {
  kind: DiffSideRowKind
  /** 左侧（旧文件）那一行；空位为 `null`。 */
  left: DiffLine | null
  /** 右侧（新文件）那一行；空位为 `null`。 */
  right: DiffLine | null
}

export function alignHunk(lines: DiffLine[]): DiffSideRow[] {
  const rows: DiffSideRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []

  const flush = (): void => {
    const paired = Math.min(dels.length, adds.length)
    for (let i = 0; i < paired; i++) rows.push({ kind: 'replace', left: dels[i], right: adds[i] })
    for (let i = paired; i < dels.length; i++) rows.push({ kind: 'del', left: dels[i], right: null })
    for (let i = paired; i < adds.length; i++) rows.push({ kind: 'add', left: null, right: adds[i] })
    dels = []
    adds = []
  }

  for (const line of lines) {
    if (line.kind === 'del') dels.push(line)
    else if (line.kind === 'add') adds.push(line)
    else {
      flush()
      rows.push({ kind: 'context', left: line, right: line })
    }
  }
  flush()
  return rows
}
