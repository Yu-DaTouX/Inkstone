import type { DirEntry } from '../../../../shared/ipc'

export interface BreadcrumbCrumb {
  path: string
  label: string
}

export interface FoldedCrumbs {
  visible: BreadcrumbCrumb[]
  hidden: BreadcrumbCrumb[]
}

export const BREADCRUMB_FOLD_AT = 5

export function breadcrumbParts(relPath: string): string[] {
  return relPath.split(/[\\/]+/).filter(Boolean)
}

export function breadcrumbCrumbs(rootLabel: string, relPath: string): BreadcrumbCrumb[] {
  const parts = breadcrumbParts(relPath)
  const crumbs: BreadcrumbCrumb[] = [{ path: '', label: rootLabel }]
  let accumulated = ''
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part
    crumbs.push({ path: accumulated, label: part })
  }
  return crumbs
}

export function breadcrumbParent(path: string): string | null {
  const parts = breadcrumbParts(path)
  if (!parts.length) return null
  parts.pop()
  return parts.join('/')
}

export function breadcrumbDirectory(focusPath: string, focusIsDir: boolean): string {
  if (!focusPath) return ''
  if (focusIsDir) return breadcrumbParts(focusPath).join('/')
  return breadcrumbParent(focusPath) ?? ''
}

export function foldBreadcrumbs(crumbs: readonly BreadcrumbCrumb[], limit = BREADCRUMB_FOLD_AT): FoldedCrumbs {
  const all = [...crumbs]
  if (all.length <= 2) return { visible: all, hidden: [] }
  const tailCount = Math.max(1, limit - 2)
  if (all.length <= tailCount + 1) return { visible: all, hidden: [] }
  const hidden = all.slice(1, all.length - tailCount)
  if (!hidden.length) return { visible: all, hidden: [] }
  return { visible: [all[0], ...all.slice(all.length - tailCount)], hidden }
}

export function breadcrumbChildDirs(
  entries: readonly DirEntry[] | null | undefined,
  dir: string
): BreadcrumbCrumb[] {
  if (!entries) return []
  const base = breadcrumbParts(dir).join('/')
  const out: BreadcrumbCrumb[] = []
  for (const entry of entries) {
    if (!entry.dir) continue
    if (entry.link && entry.link.state !== 'ok') continue
    out.push({ path: base ? `${base}/${entry.name}` : entry.name, label: entry.name })
  }
  return out
}

export interface CrumbWidthOptions {
  maxCrumbWidth?: number
  asciiWidth?: number
  wideWidth?: number
  crumbPadding?: number
  separatorWidth?: number
  foldWidth?: number
}

const CRUMB_MAX_WIDTH = 160
const ASCII_CHAR_WIDTH = 6.8
const WIDE_CHAR_WIDTH = 12
const CRUMB_PADDING = 10
const SEPARATOR_WIDTH = 16
const FOLD_TRIGGER_WIDTH = 28

export function estimateCrumbWidth(label: string, options: CrumbWidthOptions = {}): number {
  const ascii = options.asciiWidth ?? ASCII_CHAR_WIDTH
  const wide = options.wideWidth ?? WIDE_CHAR_WIDTH
  const max = options.maxCrumbWidth ?? CRUMB_MAX_WIDTH
  let width = options.crumbPadding ?? CRUMB_PADDING
  for (const char of label) width += (char.codePointAt(0) ?? 0) > 0x2e7f ? wide : ascii
  return Math.min(max, Math.round(width))
}

export function foldBreadcrumbsToWidth(
  crumbs: readonly BreadcrumbCrumb[],
  available: number,
  options: CrumbWidthOptions = {}
): FoldedCrumbs {
  const all = [...crumbs]
  if (all.length <= 2) return { visible: all, hidden: [] }
  const separator = options.separatorWidth ?? SEPARATOR_WIDTH
  const foldWidth = options.foldWidth ?? FOLD_TRIGGER_WIDTH
  const root = all[0]
  const tail = all.slice(1)
  let width = estimateCrumbWidth(root.label, options)
  for (let count = tail.length; count >= 1; count -= 1) {
    const shown = tail.slice(tail.length - count)
    const hiddenCount = tail.length - count
    const total =
      width +
      (hiddenCount ? foldWidth : 0) +
      shown.reduce((sum, item) => sum + separator + estimateCrumbWidth(item.label, options), 0)
    if (total <= available) {
      return hiddenCount ? { visible: [root, ...shown], hidden: tail.slice(0, hiddenCount) } : { visible: all, hidden: [] }
    }
  }
  return { visible: [root, tail[tail.length - 1]], hidden: tail.slice(0, tail.length - 1) }
}
