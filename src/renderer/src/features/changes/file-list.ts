import type { ChangeItem } from './types'

export const FILE_LIST_WIDTH = { DEFAULT: 240, MIN: 160, MAX: 640 } as const
export const FILE_LIST_MIN_PANE = FILE_LIST_WIDTH.DEFAULT + 160
export const LARGE_DIFF_LINES = 5000
export const LARGE_DIFF_FILES = 300
export const SPLIT_MIN_WIDTH = 560

export function clampFileListWidth(value: number, limit: number = FILE_LIST_WIDTH.MAX): number {
  const max = Math.max(FILE_LIST_WIDTH.MIN, Math.min(FILE_LIST_WIDTH.MAX, limit))
  if (!Number.isFinite(value)) return Math.min(FILE_LIST_WIDTH.DEFAULT, max)
  return Math.round(Math.min(max, Math.max(FILE_LIST_WIDTH.MIN, value)))
}

export function fileListLimit(paneWidth: number): number {
  return Math.max(FILE_LIST_WIDTH.MIN, Math.min(FILE_LIST_WIDTH.MAX, (paneWidth || 0) - 160))
}

export function canFitFileList(paneWidth: number): boolean {
  return !(paneWidth > 0) || paneWidth >= FILE_LIST_MIN_PANE
}

export function isLargeDiff(items: readonly { added?: number; removed?: number }[]): boolean {
  if (items.length > LARGE_DIFF_FILES) return true
  let total = 0
  for (const item of items) total += (item.added ?? 0) + (item.removed ?? 0)
  return total > LARGE_DIFF_LINES
}

let segmentCollator: Intl.Collator | null = null

function compareSegment(a: string, b: string): number {
  if (a === b) return 0
  segmentCollator ??= new Intl.Collator(undefined, { numeric: true })
  return segmentCollator.compare(a, b) || (a < b ? -1 : 1)
}

export function compareFilePaths(a: string, b: string): number {
  let i = 0
  let j = 0
  for (;;) {
    const x = a.indexOf('/', i)
    const y = b.indexOf('/', j)
    const aLast = x === -1
    const bLast = y === -1
    if (aLast !== bLast) return aLast ? 1 : -1
    const order = compareSegment(aLast ? a.slice(i) : a.slice(i, x), bLast ? b.slice(j) : b.slice(j, y))
    if (order !== 0 || aLast) return order
    i = x + 1
    j = y + 1
  }
}

export function sortChangeItems(items: readonly ChangeItem[]): ChangeItem[] {
  return [...items].sort((a, b) => compareFilePaths(a.path, b.path))
}

export type FileNode =
  | { kind: 'dir'; name: string; path: string; children: FileNode[] }
  | { kind: 'file'; name: string; path: string }

function fileNode(item: ChangeItem): FileNode {
  const cut = item.path.lastIndexOf('/')
  return { kind: 'file', name: cut === -1 ? item.path : item.path.slice(cut + 1), path: item.path }
}

function compactFolders(nodes: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.kind !== 'dir') return node
    const children = compactFolders(node.children)
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0]
      return { kind: 'dir', name: `${node.name}/${only.name}`, path: only.path, children: only.children }
    }
    return { ...node, children }
  })
}

export function buildFileTree(items: readonly ChangeItem[]): FileNode[] {
  const root: FileNode[] = []
  const folders = new Map<string, FileNode[]>([['', root]])
  for (const item of sortChangeItems(items)) {
    const parts = item.path.split('/')
    parts.pop()
    let prefix = ''
    let level = root
    for (const part of parts) {
      const path = prefix ? `${prefix}/${part}` : part
      let children = folders.get(path)
      if (!children) {
        children = []
        folders.set(path, children)
        level.push({ kind: 'dir', name: part, path, children })
      }
      prefix = path
      level = children
    }
    level.push(fileNode(item))
  }
  return compactFolders(root)
}

export interface FileRow {
  kind: 'dir' | 'file'
  name: string
  path: string
  depth: number
}

export function flattenFileTree(nodes: readonly FileNode[], collapsed: ReadonlySet<string>): FileRow[] {
  const rows: FileRow[] = []
  const walk = (list: readonly FileNode[], depth: number): void => {
    for (const node of list) {
      rows.push({ kind: node.kind, name: node.name, path: node.path, depth })
      if (node.kind === 'dir' && !collapsed.has(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return rows
}

export interface QueuedTask {
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export function createLimitedQueue(limit = 4): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: QueuedTask[] = []
  const pump = (): void => {
    while (active < limit && waiting.length > 0) {
      const job = waiting.shift()
      if (!job) return
      active += 1
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1
          pump()
        })
    }
  }
  return <T,>(run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      waiting.push({
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      pump()
    })
}
