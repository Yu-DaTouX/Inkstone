/**
 * 文件树纯逻辑：目录响应 reducer、可见行展开、键盘模型与虚拟化窗口。
 *
 * 这里没有 React、DOM、`window.yan` 依赖，所以可以在 Node 里直接测
 *（`scripts/test-v3-files.mjs`）。组件只负责把它接到 IPC 与真实焦点上。
 *
 * 边界：
 *   · 只处理**相对 cwd** 的路径（根 = `''`）；是否越界、软链接指向哪里，
 *     全部由主进程 `listDir` 的授权链决定，这里不 stat、不拼接系统调用。
 *   · `owner` 用结构类型，与 R0 的 `features/workbench/types.ts#WorkspaceOwner`
 *     字段一致；叶子不新建 R0 的文件，等 R0 接线时可直接传它的类型。
 */
import type { DirListing, FileListingStatus } from '../../../../shared/ipc'

/** 与合同 `WorkspaceOwner` 结构一致；`key` 不是可绕权的授权，只用于识别归属。 */
export interface FilesOwner {
  readonly key: string
  readonly sessionId: string | null
  readonly sessionFile?: string
  readonly cwd: string
  readonly runId?: string
  readonly generation?: number
  readonly active: boolean
}

/** 一行展开的高度默认值；组件会从 `--d-row` 读真实值覆盖。 */
export const DEFAULT_ROW_HEIGHT = 32
/** 上下各多渲染几行，滚动时不至于露白。 */
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

/** 展平后的一行：`state` 行是目录的加载 / 空 / 失败提示，不可聚焦。 */
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
  /**
   * 请求代次：owner / cwd / 隐藏开关变化时递增。
   * 旧代次的 loadStart / loadOk / loadError 一律丢弃，旧 A 的目录列表
   * 不可能覆盖 B（这是「切项目时树串味」的根因修复）。
   */
  generation: number
  showHidden: boolean
  /** `undefined` = 没加载过；`null` = 请求失败；否则是宿主回包 */
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

/** 路径 `child` 是否在目录 `parent` 之内（含自身之外的子层）。 */
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
      /*
       * 收起目录时，如果焦点在它的子树里，焦点退回这个目录行 ——
       * 否则焦点会留在已被卸载的行上，键盘游走从 body 重新开始。
       */
      let focusPath = state.focusPath
      if (!open[action.path] && isDescendantPath(focusPath, action.path)) focusPath = action.path
      return { ...state, open, focusPath }
    }
    case 'focus':
      return state.focusPath === action.path ? state : { ...state, focusPath: action.path }
    default:
      return state
  }
}

/** cwd 的末段作为根标题；宿主回了 `rootName` 就用它的（Windows 根 `C:\` 也照顾）。 */
export function rootLabel(cwd: string, rootName?: string): string {
  if (rootName) return rootName
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || cwd || '/'
}

function statusRowState(status: FileListingStatus | 'partial'): FilesRowState | null {
  if (status === 'ok' || status === 'empty') return null
  return status
}

/** 展平成渲染与键盘共用的**同一份**顺序；只读已加载内容，不触发任何 IO。 */
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
    /* 还没回包：显示加载行；加载由 hook 的 effect 触发。 */
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

/** 可聚焦行的 path（根 + 目录/文件行），键盘游走与 tabIndex 用同一份顺序。 */
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

/** 方向键的落点；`currentPath` 不在列表里（等于没有焦点）时从上下文推断。 */
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
  /** 当前 owner 是否就是活动会话：不是就不显示「加入上下文」。 */
  canAdd: boolean
}

export type FilesKeyEffect =
  | { type: 'none' }
  | { type: 'focus'; path: string }
  | { type: 'toggle'; path: string }
  | { type: 'preview'; path: string }
  | { type: 'add'; path: string }

/**
 * 键盘模型（纯）：把一次按键翻成焦点移动 / 展开 / 预览 / 加入上下文。
 *
 * 与 v2 FileTree 的含义一致，但不含 DOM：`ArrowLeft` 收起或回到父行，
 * `ArrowRight` 展开已收起目录、或移到下一个可见行；Enter/Space 目录展开、文件预览；
 * Alt+Enter 与 `a` 是显式的「加入上下文」动作（仅在 `canAdd` 时）。
 * 不做任何写操作键（Del/F2 等一律无动作），首版不发假按钮。
 */
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
  /** 焦点行即使滚出视口也要留在渲染窗口里，否则键盘一按就找不到节点。 */
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

/** 虚拟化窗口（纯）：只渲染视口内（含 overscan 与焦点行）的行。 */
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

/**
 * 相对 cwd 的 posix 相对路径 → 正式绝对路径（交给宿主授权链，不自己读盘）。
 * Windows 盘符或已知反斜杠根用 `\`，其余用 `/`。
 */
export function toAbsolutePath(cwd: string, rel: string): string {
  const root = cwd.replace(/[\\/]+$/, '')
  if (!rel) return root
  const sep = /^[A-Za-z]:\\/.test(root) || (root.includes('\\') && !root.includes('/')) ? '\\' : '/'
  return `${root}${sep}${rel.replace(/[\\/]+/g, sep)}`
}

/**
 * 只有「这个 owner 就是当前活动会话」时才允许把文件加进上下文：
 * 否则会在 owner 已经切走之后，把文件悄悄加给另一条会话。
 */
export function canAttachToContext(owner: FilesOwner, activeSessionId: string | null | undefined): boolean {
  if (!owner.active) return false
  if (!owner.sessionId) return false
  return owner.sessionId === activeSessionId
}
