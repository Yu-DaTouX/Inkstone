import type { DiffLine } from './types'

export type DiffSideRowKind = 'context' | 'replace' | 'add' | 'del'

export interface DiffSideRow {
  kind: DiffSideRowKind
  left: DiffLine | null
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
