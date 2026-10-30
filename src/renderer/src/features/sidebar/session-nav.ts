export interface JumpViewport {
  top: number
  bottom: number
}

export interface JumpRowBox {
  path: string
  top: number
  bottom: number
  viewport: JumpViewport
}

export function visibleJumpPaths(rows: readonly JumpRowBox[], limit = 9): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of rows) {
    if (out.length >= limit) break
    if (!row.path || seen.has(row.path)) continue
    if (row.bottom <= row.top) continue
    const shown = Math.min(row.bottom, row.viewport.bottom) - Math.max(row.top, row.viewport.top)
    if (shown < (row.bottom - row.top) / 2) continue
    seen.add(row.path)
    out.push(row.path)
  }
  return out
}

export function jumpIndexMap(paths: readonly string[]): ReadonlyMap<string, number> {
  return new Map(paths.map((path, index) => [path, index + 1]))
}

const comparable = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

export function sameSessionPathLoose(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && comparable(a) === comparable(b)
}

export function nextSessionAfter(order: readonly string[], removed: string): string | null {
  const at = order.findIndex((path) => sameSessionPathLoose(path, removed))
  const rest = order.filter((path) => !sameSessionPathLoose(path, removed))
  if (!rest.length) return null
  if (at < 0) return rest[0]
  return rest[Math.min(at, rest.length - 1)]
}

export interface DropTargetNode {
  closest(selector: string): DropTargetNode | null
  getAttribute(name: string): string | null
}

export const SESSION_FILE_DROP_ROW = '[data-session-path]'

export function fileDropRowPath(target: DropTargetNode | null | undefined): string | null {
  const row = target?.closest(SESSION_FILE_DROP_ROW)
  return row?.getAttribute('data-session-path') || null
}
