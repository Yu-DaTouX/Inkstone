import type { FileDiff, UIToolCall } from '../../../../shared/ipc'

export function readFileDiff(details: unknown): FileDiff | null {
  if (!details || typeof details !== 'object') return null
  const d = (details as { fileDiff?: unknown }).fileDiff
  if (!d || typeof d !== 'object') return null
  const diff = d as Partial<FileDiff>
  if (typeof diff.path !== 'string' || !diff.before || !diff.after || typeof diff.patch !== 'string') return null
  return diff as FileDiff
}

export type CallDiffLineKind = 'add' | 'del' | 'context' | 'skip'

export interface CallDiffLine {
  kind: CallDiffLineKind
  num: number | null
  text: string
}

export interface PiDiff {
  lines: CallDiffLine[]
  added: number
  removed: number
}

const PI_DIFF_NUMBERED = /^\s*(\d+) ([\s\S]*)$/

export function parsePiDiff(diff: string): PiDiff | null {
  const lines: CallDiffLine[] = []
  let added = 0
  let removed = 0
  for (const raw of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (!raw) continue
    const sign = raw[0]
    if (sign !== '+' && sign !== '-' && sign !== ' ') return null
    const rest = raw.slice(1)
    const numbered = PI_DIFF_NUMBERED.exec(rest) ?? (/^\s*\d+$/.test(rest) ? [rest, rest.trim(), ''] : null)
    if (!numbered) {
      if (sign === ' ' && rest.trim() === '...') {
        lines.push({ kind: 'skip', num: null, text: '' })
        continue
      }
      return null
    }
    const kind: CallDiffLineKind = sign === '+' ? 'add' : sign === '-' ? 'del' : 'context'
    if (kind === 'add') added += 1
    if (kind === 'del') removed += 1
    lines.push({ kind, num: Number(numbered[1]), text: numbered[2] })
  }
  return lines.length ? { lines, added, removed } : null
}

const piDiffs = new WeakMap<object, { diff: string; parsed: PiDiff | null }>()

export function readPiDiff(details: unknown): PiDiff | null {
  if (!details || typeof details !== 'object') return null
  const diff = (details as { diff?: unknown }).diff
  if (typeof diff !== 'string' || !diff.trim()) return null
  const known = piDiffs.get(details)
  if (known && known.diff === diff) return known.parsed
  const parsed = parsePiDiff(diff)
  piDiffs.set(details, { diff, parsed })
  return parsed
}

function stringArg(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) if (typeof source[key] === 'string') return source[key] as string
  return null
}

function splitLines(text: string): string[] {
  return text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []
}

export function editArgLines(args: unknown): CallDiffLine[] | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  const pairs = Array.isArray(record.edits) ? record.edits : [record]
  const lines: CallDiffLine[] = []
  for (const raw of pairs) {
    if (!raw || typeof raw !== 'object') continue
    const edit = raw as Record<string, unknown>
    const before = stringArg(edit, ['oldText', 'old_string', 'old_str'])
    const after = stringArg(edit, ['newText', 'new_string', 'new_str'])
    if (before === null || after === null) continue
    if (lines.length) lines.push({ kind: 'skip', num: null, text: '' })
    for (const text of splitLines(before)) lines.push({ kind: 'del', num: null, text })
    for (const text of splitLines(after)) lines.push({ kind: 'add', num: null, text })
  }
  return lines.length ? lines : null
}

export function callPath(call: UIToolCall): string {
  const a = (call.args ?? {}) as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'Path', 'FilePath', 'TargetFile']) {
    if (typeof a[key] === 'string') return a[key] as string
  }
  return ''
}

export type TurnFileStatus = 'created' | 'modified' | 'deleted'

export interface TurnFileChange {
  path: string
  status: TurnFileStatus
  added: number
  removed: number
}

export interface TurnChanges {
  files: TurnFileChange[]
  counts: Record<TurnFileStatus, number>
  added: number
  removed: number
}

function settled(call: UIToolCall): boolean {
  return call.status !== 'running' && call.status !== 'pending'
}

function normalizeParts(path: string): { root: string; parts: string[] } {
  const slashed = path.replace(/\\/g, '/')
  const drive = /^[a-zA-Z]:/.exec(slashed)
  const share = /^\/\/[^/]+\/[^/]+(?=\/|$)/.exec(slashed)?.[0]
  const folds = !!share || !slashed.startsWith('/')
  const root = share?.toLowerCase() ?? (drive ? drive[0].toLowerCase() : slashed.startsWith('/') ? '/' : '')
  const parts: string[] = []
  for (const part of slashed.slice(share?.length ?? (drive ? 2 : 0)).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(folds ? part.toLowerCase() : part)
  }
  return { root, parts }
}

export function scopedPathKey(path: string, cwd?: string): string | null {
  if (!cwd?.trim()) return path
  const base = normalizeParts(cwd)
  const absolute = /^[a-zA-Z]:[\\/]|^[\\/]/.test(path)
  const target = normalizeParts(absolute ? path : `${cwd.replace(/[\\/]+$/, '')}/${path}`)
  if (target.root !== base.root || !base.parts.every((part, i) => target.parts[i] === part)) return null
  return `${target.root}/${target.parts.join('/')}`
}

export function isInsideCwd(path: string, cwd?: string): boolean {
  return scopedPathKey(path, cwd) !== null
}

export function callFileDiffs(call: UIToolCall): FileDiff[] {
  const acp = call.details as { antigravity?: boolean; antigravityDiffs?: FileDiff[] } | undefined
  if (acp?.antigravity && call.status === 'ok' && Array.isArray(acp.antigravityDiffs)) return acp.antigravityDiffs
  const diff = readFileDiff(call.details)
  return diff ? [diff] : []
}

export function collectTurnChanges(tools: readonly UIToolCall[], cwd?: string, fallback?: (call: UIToolCall) => TurnFileChange | null): TurnChanges | null {
  const byPath = new Map<string, TurnFileChange>()
  let countable = true
  for (const call of tools) {
    if (!settled(call)) continue
    const diffs = callFileDiffs(call)
    for (const diff of !diffs.length && fallback ? [fallback(call)] : diffs) {
      if (!diff || diff.status === 'unchanged') continue
      const path = diff.path || callPath(call) || call.id
      const key = scopedPathKey(path, cwd)
      if (key === null) continue
      const known = diff.added >= 0 && diff.removed >= 0
      if (!known) countable = false
      const prev = byPath.get(key)
      const status: TurnFileStatus = diff.status === 'created' || diff.status === 'deleted'
        ? diff.status
        : prev?.status === 'created' ? 'created' : 'modified'
      const row: TurnFileChange = prev ?? { path, status, added: 0, removed: 0 }
      row.status = status
      row.added = known && row.added >= 0 ? row.added + diff.added : -1
      row.removed = known && row.removed >= 0 ? row.removed + diff.removed : -1
      byPath.set(key, row)
    }
  }
  if (!byPath.size) return null
  const files = [...byPath.values()]
  const counts: Record<TurnFileStatus, number> = { created: 0, modified: 0, deleted: 0 }
  for (const file of files) counts[file.status] += 1
  return {
    files,
    counts,
    added: countable ? files.reduce((sum, f) => sum + f.added, 0) : -1,
    removed: countable ? files.reduce((sum, f) => sum + f.removed, 0) : -1
  }
}

export function splitChangePath(path: string, cwd?: string): { dir: string; base: string } {
  let shown = path.replace(/\\/g, '/')
  const root = cwd?.replace(/\\/g, '/').replace(/\/+$/, '')
  let relative = !/^[a-zA-Z]:\//.test(shown) && !shown.startsWith('/')
  if (root && shown.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    shown = shown.slice(root.length + 1)
    relative = true
  }
  const cut = shown.lastIndexOf('/')
  if (cut < 0) return { dir: '', base: shown }
  const base = shown.slice(cut + 1)
  let dir = shown.slice(0, cut + 1)
  if (!relative) {
    const parts = dir.split('/').filter(Boolean)
    if (parts.length >= 2) dir = `…/${parts[parts.length - 1]}/`
  }
  return { dir, base }
}

export interface TurnChangeRow {
  file: TurnFileChange
  dir: string
  base: string
}

export function changeRows(files: readonly TurnFileChange[], cwd?: string): TurnChangeRow[] {
  const rows = files.map((file) => ({ file, ...splitChangePath(file.path, cwd) }))
  const key = (row: TurnChangeRow): string => `${row.dir}${row.base}`.toLowerCase()
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}
