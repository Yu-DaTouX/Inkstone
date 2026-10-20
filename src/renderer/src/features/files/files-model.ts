import type { DirEntry, DirEntryLink, DirListing, FileListingStatus } from '../../../../shared/ipc'

export interface FilesOwner {
  readonly key: string
  readonly sessionId: string | null
  readonly sessionFile?: string
  readonly cwd: string
  readonly runId?: string
  readonly generation?: number
  readonly active: boolean
}

export const DEFAULT_ROW_HEIGHT = 24
export const OVERSCAN = 6
export const TREE_INDENT_BASE = 8
export const TREE_INDENT_STEP = 10
export const CHAIN_EXPAND_LIMIT = 16
export const REVEAL_FLASH_MS = 1200

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
  link?: DirEntryLink
  blocked?: boolean
}

export interface FilesTreeState {
  ownerKey: string
  cwd: string
  generation: number
  showHidden: boolean
  listings: Record<string, DirListing | null>
  loading: Record<string, true>
  open: Record<string, true>
  chain: Record<string, number>
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
  | { type: 'reveal'; path: string }
  | { type: 'collapseAll' }

export function freshTreeState(
  ownerKey: string,
  cwd: string,
  generation: number,
  showHidden = false
): FilesTreeState {
  return {
    ownerKey,
    cwd,
    generation,
    showHidden,
    listings: {},
    loading: {},
    open: { '': true },
    chain: {},
    focusPath: ''
  }
}

export function isDescendantPath(child: string, parent: string): boolean {
  if (child === parent) return false
  return parent === '' ? child !== '' : child.startsWith(`${parent}/`)
}

export function joinTreePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

export function linkBlocked(link: DirEntryLink | undefined): boolean {
  return !!link && link.state !== 'ok'
}

function entryExpandable(entry: DirEntry): boolean {
  return entry.dir && !linkBlocked(entry.link)
}

export function expandChain(
  open: Record<string, true>,
  chain: Record<string, number>,
  listings: Record<string, DirListing | null>,
  start: string,
  budget: number
): { open: Record<string, true>; chain: Record<string, number> } {
  const nextOpen = { ...open }
  const nextChain = { ...chain }
  delete nextChain[start]
  let current = start
  let left = budget
  while (left > 0) {
    const listing = listings[current]
    if (listing === undefined) {
      nextChain[current] = left
      break
    }
    if (!listing || listing.entries.length !== 1 || !entryExpandable(listing.entries[0])) break
    const child = joinTreePath(current, listing.entries[0].name)
    nextOpen[child] = true
    current = child
    left -= 1
  }
  return { open: nextOpen, chain: nextChain }
}

export function ancestorPaths(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const out: string[] = ['']
  for (let index = 1; index < parts.length; index += 1) out.push(parts.slice(0, index).join('/'))
  return out
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
      const listings = { ...state.listings, [action.path]: action.listing }
      const budget = state.chain[action.path]
      if (budget && state.open[action.path]) {
        const chained = expandChain(state.open, state.chain, listings, action.path, budget)
        return { ...state, loading, listings, open: chained.open, chain: chained.chain }
      }
      return { ...state, loading, listings }
    }
    case 'loadError': {
      if (action.generation !== state.generation) return state
      const loading = { ...state.loading }
      delete loading[action.path]
      const chain = { ...state.chain }
      delete chain[action.path]
      return { ...state, loading, chain, listings: { ...state.listings, [action.path]: null } }
    }
    case 'toggle': {
      if (state.open[action.path]) {
        const open = { ...state.open }
        delete open[action.path]
        const chain = { ...state.chain }
        delete chain[action.path]
        const focusPath = isDescendantPath(state.focusPath, action.path) ? action.path : state.focusPath
        return { ...state, open, chain, focusPath }
      }
      const opened = expandChain({ ...state.open, [action.path]: true }, state.chain, state.listings, action.path, CHAIN_EXPAND_LIMIT)
      return { ...state, open: opened.open, chain: opened.chain }
    }
    case 'reveal': {
      const open = { ...state.open }
      for (const dir of ancestorPaths(action.path)) open[dir] = true
      return { ...state, open, focusPath: action.path }
    }
    case 'collapseAll':
      if (Object.keys(state.open).length <= 1 && state.open['']) return state
      return { ...state, open: { '': true }, chain: {}, focusPath: '' }
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
  const from = rows.findIndex((row) => row.focusable && row.path === anchor)
  const to = rows.findIndex((row) => row.focusable && row.path === path)
  if (from < 0 || to < 0) return new Set([path])
  const next = new Set<string>()
  for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) {
    const row = rows[index]
    if (row.focusable) next.add(row.path)
  }
  return next
}

export function rootLabel(cwd: string, rootName?: string): string {
  if (rootName) return rootName
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || cwd || '/'
}

function listingState(listing: DirListing | null | undefined): FilesRowState | null {
  if (listing === undefined) return 'loading'
  if (listing === null) return 'error'
  const status: FileListingStatus = listing.status ?? (listing.entries.length ? 'ok' : 'empty')
  if (status !== 'ok' && status !== 'empty') return status
  return listing.entries.length === 0 ? 'empty' : null
}

export type FilesRootStatus = 'none' | 'loading' | 'error' | 'empty' | 'ready'

export function rootStatus(state: FilesTreeState): FilesRootStatus {
  if (!state.cwd) return 'none'
  const value = listingState(state.listings[''])
  if (value === null) return 'ready'
  if (value === 'loading') return 'loading'
  if (value === 'empty') return 'empty'
  return 'error'
}

export function flattenRows(state: FilesTreeState): FileTreeRow[] {
  const rows: FileTreeRow[] = []
  if (rootStatus(state) !== 'ready') return rows
  appendChildren(rows, state, '', 0)
  return rows
}

function appendChildren(rows: FileTreeRow[], state: FilesTreeState, parent: string, depth: number): void {
  const listing = state.listings[parent]
  const blocker = listingState(listing)
  if (blocker) {
    rows.push({ path: parent, name: '', dir: false, depth, kind: 'state', focusable: false, state: blocker })
    return
  }
  if (!listing) return
  for (const entry of listing.entries) {
    const child = joinTreePath(parent, entry.name)
    const blocked = linkBlocked(entry.link)
    const isDir = entry.dir
    const expandable = isDir && !blocked
    rows.push({
      path: child,
      name: entry.name,
      dir: isDir,
      depth,
      kind: isDir ? 'dir' : 'file',
      focusable: true,
      ...(expandable ? { open: !!state.open[child] } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.link ? { link: entry.link } : {}),
      ...(blocked ? { blocked: true } : {})
    })
    if (expandable && state.open[child]) appendChildren(rows, state, child, depth + 1)
  }
  if (listing.truncated) {
    rows.push({ path: parent, name: '', dir: false, depth, kind: 'state', focusable: false, state: 'partial' })
  }
}

export function treeIndent(depth: number): number {
  return TREE_INDENT_BASE + depth * TREE_INDENT_STEP
}

export function focusablePaths(rows: FileTreeRow[]): string[] {
  return rows.filter((row) => row.focusable).map((row) => row.path)
}

export function tabbablePath(rows: FileTreeRow[], focusPath: string): string | undefined {
  const list = focusablePaths(rows)
  return list.includes(focusPath) ? focusPath : list[0]
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
  const expandable = !!row?.dir && !row.blocked

  if (key === 'ArrowRight') {
    if (!expandable) return { type: 'none' }
    if (row?.open) {
      const list = focusablePaths(rows)
      const index = list.indexOf(currentPath)
      const next = list[index + 1]
      return next === undefined || !isDescendantPath(next, currentPath) ? { type: 'none' } : { type: 'focus', path: next }
    }
    return { type: 'toggle', path: currentPath }
  }

  if (key === 'ArrowLeft') {
    if (expandable && row?.open) return { type: 'toggle', path: currentPath }
    const parent = parentPath(currentPath)
    return parent === undefined || parent === '' ? { type: 'none' } : { type: 'focus', path: parent }
  }

  if (key === 'Enter' || key === ' ') {
    if (!row || row.blocked) return { type: 'none' }
    if (altKey && !ctrlKey && !metaKey && !row.dir && canAdd) return { type: 'add', path: currentPath }
    return row.dir ? { type: 'toggle', path: currentPath } : { type: 'preview', path: currentPath }
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

export function toRelativePath(cwd: string, abs: string): string | null {
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = abs.replace(/\\/g, '/')
  if (!root) return null
  const windows = /^[A-Za-z]:/.test(root)
  const same = windows ? target.toLowerCase().startsWith(`${root.toLowerCase()}/`) : target.startsWith(`${root}/`)
  if (!same) return null
  return target.slice(root.length + 1).replace(/\/+$/, '')
}

export function canAttachToContext(owner: FilesOwner, activeSessionId: string | null | undefined): boolean {
  if (!owner.active) return false
  if (!owner.sessionId) return false
  return owner.sessionId === activeSessionId
}
