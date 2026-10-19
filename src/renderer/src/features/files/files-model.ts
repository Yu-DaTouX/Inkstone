import type { DirListing, FileListingStatus } from '../../../../shared/ipc'

export interface FilesOwner {
  readonly key: string
  readonly sessionId: string | null
  readonly sessionFile?: string
  readonly cwd: string
  readonly runId?: string
  readonly generation?: number
  readonly active: boolean
}

export const DEFAULT_ROW_HEIGHT = 32
export const OVERSCAN = 6

export type FilesRowKind = 'dir' | 'file' | 'state'
export type FilesRowState =
  | 'loading'
  | 'empty'
  | 'error'
  | 'permission'
  | 'missing'
  | 'invalid'
  | 'partial'

export interface FileTreeRow {
  path: string
  name: string
  dir: boolean
  depth: number
  kind: FilesRowKind
  focusable: boolean
  open?: boolean
  size?: number
  state?: FilesRowState
}

export interface FilesTreeState {
  ownerKey: string
  cwd: string
  generation: number
  showHidden: boolean
  listings: Record<string, DirListing | null>
  loading: Record<string, true>
  open: Record<string, true>
  focusPath: string
}

export type FilesTreeAction =
  | { type: 'reset'; ownerKey: string; cwd: string; generation: number }
  | { type: 'toggleHidden'; generation: number }
  | { type: 'loadStart'; path: string; generation: number }
  | { type: 'loadOk'; path: string; generation: number; listing: DirListing }
  | { type: 'loadError'; path: string; generation: number }
  | { type: 'toggle'; path: string }
  | { type: 'focus'; path: string }
  | { type: 'collapseAll' }

export function freshTreeState(
  ownerKey: string,
  cwd: string,
  generation: number,
  showHidden: boolean
): FilesTreeState {
  return {
    ownerKey,
    cwd,
    generation,
    showHidden,
    listings: {},
    loading: {},
    open: { '': true },
    focusPath: ''
  }
}

export function isDescendantPath(child: string, parent: string): boolean {
  if (child === parent) return false
  return parent === '' ? child !== '' : child.startsWith(`${parent}/`)
}

export function filesTreeReducer(state: FilesTreeState, action: FilesTreeAction): FilesTreeState {
  switch (action.type) {
    case 'reset':
      return freshTreeState(action.ownerKey, action.cwd, action.generation, state.showHidden)
    case 'toggleHidden':
      return freshTreeState(state.ownerKey, state.cwd, action.generation, !state.showHidden)
    case 'loadStart':
      if (action.generation !== state.generation) return state
      return { ...state, loading: { ...state.loading, [action.path]: true } }
    case 'loadOk': {
      if (action.generation !== state.generation) return state
      const loading = { ...state.loading }
      delete loading[action.path]
      return { ...state, loading, listings: { ...state.listings, [action.path]: action.listing } }
    }
    case 'loadError': {
      if (action.generation !== state.generation) return state
      const loading = { ...state.loading }
      delete loading[action.path]
      return { ...state, loading, listings: { ...state.listings, [action.path]: null } }
    }
    case 'toggle': {
      const open = { ...state.open }
      if (open[action.path]) delete open[action.path]
      else open[action.path] = true
      let focusPath = state.focusPath
      if (!open[action.path] && isDescendantPath(focusPath, action.path)) focusPath = action.path
      return { ...state, open, focusPath }
    }
    case 'collapseAll':
      if (Object.keys(state.open).length <= 1 && state.open['']) return state
      return { ...state, open: { '': true }, focusPath: '' }
    case 'focus':
      return state.focusPath === action.path ? state : { ...state, focusPath: action.path }
    default:
      return state
  }
}

export function toggleSelected(selected: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(selected)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

export function rangeSelected(rows: FileTreeRow[], anchor: string, path: string): ReadonlySet<string> {
  const from = rows.findIndex((row) => row.path === anchor)
  const to = rows.findIndex((row) => row.path === path)
  if (from < 0 || to < 0) return new Set([path])
  const next = new Set<string>()
  for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) {
    const row = rows[index]
    if (row.kind === 'file') next.add(row.path)
  }
  return next
}

export function rootLabel(cwd: string, rootName?: string): string {
  if (rootName) return rootName
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || cwd || '/'
}

function statusRowState(status: FileListingStatus | 'partial'): FilesRowState | null {
  if (status === 'ok' || status === 'empty') return null
  return status
}

export function flattenRows(state: FilesTreeState): FileTreeRow[] {
  const rootListing = state.listings[''] ?? undefined
  const rootName = rootLabel(state.cwd, rootListing?.rootName)
  const rows: FileTreeRow[] = [
    {
      path: '',
      name: rootName,
      dir: true,
      depth: 0,
      kind: 'dir',
      focusable: true,
      open: !!state.open['']
    }
  ]
  if (state.open['']) appendChildren(rows, state, '', 1)
  return rows
}

function appendChildren(rows: FileTreeRow[], state: FilesTreeState, parent: string, depth: number): void {
  const listing = state.listings[parent]
  if (listing === undefined) {
    rows.push({ path: parent, name: '', dir: false, depth, kind: 'state', focusable: false, state: 'loading' })
    return
  }
  if (listing === null) {
    rows.push({ path: parent, name: '', dir: false, depth, kind: 'state', focusable: false, state: 'error' })
    return
  }
  const status = listing.status ?? (listing.entries.length ? 'ok' : 'empty')
  const states = statusRowState(status)
  if (states) {
    rows.push({ path: parent, name: '', dir: false, depth, kind: 'state', focusable: false, state: states })
    return
  }
  if (listing.entries.length === 0) {
    rows.push({ path: parent, name: '', dir: false, depth, kind: 'state', focusable: false, state: 'empty' })
    return
  }
  for (const entry of listing.entries) {
    const child = parent ? `${parent}/${entry.name}` : entry.name
    const isDir = entry.dir
    rows.push({
      path: child,
      name: entry.name,
      dir: isDir,
      depth,
      kind: isDir ? 'dir' : 'file',
      focusable: true,
      ...(isDir ? { open: !!state.open[child] } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {})
    })
    if (isDir && state.open[child]) appendChildren(rows, state, child, depth + 1)
  }
  if (listing.truncated) {
    rows.push({ path: parent, name: '', dir: false, depth, kind: 'state', focusable: false, state: 'partial' })
  }
}

export function focusablePaths(rows: FileTreeRow[]): string[] {
  return rows.filter((row) => row.focusable).map((row) => row.path)
}

export function rowForPath(rows: FileTreeRow[], path: string): FileTreeRow | undefined {
  return rows.find((row) => row.focusable && row.path === path)
}

export function parentPath(path: string): string | undefined {
  if (path === '') return undefined
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export function moveFocus(rows: FileTreeRow[], currentPath: string, key: string): string | undefined {
  const list = focusablePaths(rows)
  if (!list.length) return undefined
  const index = list.indexOf(currentPath)
  switch (key) {
    case 'ArrowDown':
      return list[index < 0 ? 0 : Math.min(index + 1, list.length - 1)]
    case 'ArrowUp':
      return list[index < 0 ? 0 : Math.max(index - 1, 0)]
    case 'Home':
      return list[0]
    case 'End':
      return list[list.length - 1]
    default:
      return undefined
  }
}

export interface FilesKeyInput {
  rows: FileTreeRow[]
  currentPath: string
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
  canAdd: boolean
}

export type FilesKeyEffect =
  | { type: 'none' }
  | { type: 'focus'; path: string }
  | { type: 'toggle'; path: string }
  | { type: 'preview'; path: string }
  | { type: 'add'; path: string }

export function handleTreeKey(input: FilesKeyInput): FilesKeyEffect {
  const { rows, currentPath, key, altKey, ctrlKey, metaKey, isComposing, canAdd } = input
  if (isComposing) return { type: 'none' }

  if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
    const path = moveFocus(rows, currentPath, key)
    return path === undefined ? { type: 'none' } : { type: 'focus', path }
  }

  const row = rowForPath(rows, currentPath)

  if (key === 'ArrowRight') {
    if (!row?.dir) return { type: 'none' }
    if (row.open) {
      const list = focusablePaths(rows)
      const index = list.indexOf(currentPath)
      const next = list[index + 1]
      return next === undefined ? { type: 'none' } : { type: 'focus', path: next }
    }
    return { type: 'toggle', path: currentPath }
  }

  if (key === 'ArrowLeft') {
    if (row?.dir && row.open) return { type: 'toggle', path: currentPath }
    const parent = parentPath(currentPath)
    return parent === undefined ? { type: 'none' } : { type: 'focus', path: parent }
  }

  if (key === 'Enter' || key === ' ') {
    if (altKey && !ctrlKey && !metaKey && !row?.dir && canAdd) return { type: 'add', path: currentPath }
    if (!row) return { type: 'none' }
    return row.dir ? { type: 'toggle', path: currentPath } : { type: 'preview', path: currentPath }
  }

  if (key.toLowerCase() === 'a' && !altKey && !ctrlKey && !metaKey) {
    if (!row?.dir && canAdd) return { type: 'add', path: currentPath }
    return { type: 'none' }
  }

  return { type: 'none' }
}

export interface FilesWindowInput {
  count: number
  scrollTop: number
  viewportHeight: number
  rowHeight: number
  overscan?: number
  includeIndex?: number
}

export interface FilesWindow {
  start: number
  end: number
  padTop: number
  padBottom: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function computeWindow(input: FilesWindowInput): FilesWindow {
  const { count, scrollTop, viewportHeight, rowHeight, includeIndex } = input
  const overscan = input.overscan ?? OVERSCAN
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  const total = count * rowHeight
  const maxTop = Math.max(0, total - viewportHeight)
  const top = clamp(scrollTop, 0, maxTop)
  let start = Math.max(0, Math.floor(top / rowHeight) - overscan)
  let end = Math.min(count, Math.ceil((top + viewportHeight) / rowHeight) + overscan)
  if (includeIndex !== undefined && includeIndex >= 0 && includeIndex < count) {
    if (includeIndex < start) start = includeIndex
    if (includeIndex >= end) end = includeIndex + 1
  }
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight }
}

export function toAbsolutePath(cwd: string, rel: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  if (!rel) return root
  const sep = /^[A-Za-z]:\\/.test(root) || (root.includes('\\') && !root.includes('/')) ? '\\' : '/'
  return `${root}${sep}${rel.replace(/[\\/]+/g, sep)}`
}

export function canAttachToContext(owner: FilesOwner, activeSessionId: string | null | undefined): boolean {
  if (!owner.active) return false
  if (!owner.sessionId) return false
  return owner.sessionId === activeSessionId
}
