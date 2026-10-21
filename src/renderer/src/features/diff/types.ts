export type DiffLineKind = 'add' | 'del' | 'context'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  raw: string
  oldLine: number | null
  newLine: number | null
  noNewline?: boolean
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  section: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  hunks: DiffHunk[]
  binary: boolean
  newFile: boolean
  deletedFile: boolean
  renamed: boolean
  headers: string[]
}

export interface DiffParseResult {
  files: DiffFile[]
  preamble: string[]
}

export type DiffViewMode = 'unified' | 'split'
