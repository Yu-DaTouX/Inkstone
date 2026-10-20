import { isAuxTile, splitColumns, type SplitSessionRef } from '../../state/split-view'

export type SplitDirection = 'left' | 'right' | 'up' | 'down'

const isSession = (tile: SplitSessionRef | undefined): boolean => !!tile && !isAuxTile(tile) && !!(tile.sessionId || tile.path)

export function splitReadingOrder(tiles: readonly SplitSessionRef[]): number[] {
  return splitColumns(tiles).flat().filter((index) => isSession(tiles[index]))
}

export function nextSplitPane(tiles: readonly SplitSessionRef[], live: number, step: 1 | -1): number | null {
  const order = splitReadingOrder(tiles)
  if (order.length < 2) return null
  const at = order.indexOf(live)
  const from = at === -1 ? 0 : at
  const next = order[(from + step + order.length) % order.length]
  return next === live ? null : next
}

export function neighbourSplitPane(tiles: readonly SplitSessionRef[], live: number, direction: SplitDirection): number | null {
  const columns = splitColumns(tiles)
  const col = columns.findIndex((column) => column.includes(live))
  if (col === -1) return null
  const row = columns[col].indexOf(live)
  let found: number | undefined
  if (direction === 'up' && row === 1) found = columns[col][0]
  else if (direction === 'down' && row === 0) found = columns[col][1]
  else if (direction === 'left' || direction === 'right') {
    const step = direction === 'left' ? -1 : 1
    for (let at = col + step; at >= 0 && at < columns.length; at += step) {
      const column = columns[at]
      const candidates = [column[Math.min(row, column.length - 1)], ...column].filter((index) => isSession(tiles[index]))
      if (candidates.length) {
        found = candidates[0]
        break
      }
    }
  }
  return found === undefined || found === live || !isSession(tiles[found]) ? null : found
}

export function sessionPaneCount(tiles: readonly SplitSessionRef[]): number {
  return tiles.filter(isSession).length
}
