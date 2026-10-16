import type { FileDiff, UIToolCall } from '../../../../shared/ipc'

export function readFileDiff(details: unknown): FileDiff | null {
  if (!details || typeof details !== 'object') return null
  const d = (details as { fileDiff?: unknown }).fileDiff
  if (!d || typeof d !== 'object') return null
  const diff = d as Partial<FileDiff>
  if (typeof diff.path !== 'string' || !diff.before || !diff.after || typeof diff.patch !== 'string') return null
  return diff as FileDiff
}

export function callPath(call: UIToolCall): string {
  const a = (call.args ?? {}) as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath']) {
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

export function collectTurnChanges(tools: readonly UIToolCall[]): TurnChanges | null {
  const byPath = new Map<string, TurnFileChange>()
  let countable = true
  for (const call of tools) {
    if (!settled(call)) continue
    const diff = readFileDiff(call.details)
    if (!diff || diff.status === 'unchanged') continue
    const path = diff.path || callPath(call) || call.id
    const known = diff.added >= 0 && diff.removed >= 0
    if (!known) countable = false
    const prev = byPath.get(path)
    const status: TurnFileStatus = diff.status === 'created' || diff.status === 'deleted'
      ? diff.status
      : prev?.status === 'created' ? 'created' : 'modified'
    const row: TurnFileChange = prev ?? { path, status, added: 0, removed: 0 }
    row.status = status
    if (known) {
      row.added += diff.added
      row.removed += diff.removed
    }
    byPath.set(path, row)
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
