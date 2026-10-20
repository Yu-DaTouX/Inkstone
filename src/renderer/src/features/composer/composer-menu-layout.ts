export interface MenuAnchor {
  left: number
  top: number
  bottom: number
  right: number
}

export interface MenuViewport {
  width: number
  height: number
}

export interface MenuSize {
  width: number
  height: number
}

export interface MenuPlacement {
  left: number
  top: number
  width: number
  height: number
  maxHeight: number
  maxWidth: number
}

export interface TooltipPlacement {
  left: number
  top: number
  side: 'right' | 'left'
}

export interface HighlightPart {
  text: string
  hit: boolean
}

export const MENU_MAX_HEIGHT = 384
export const MENU_HEADROOM = 34
export const MENU_GAP = 10
export const MENU_EDGE = 8
export const MENU_MIN_WIDTH = 240
export const MENU_MAX_WIDTH = 512
export const TOOLTIP_OFFSET = 8

export function menuMaxHeight(anchor: Pick<MenuAnchor, 'top'>): number {
  return Math.max(0, Math.min(MENU_MAX_HEIGHT, anchor.top - MENU_HEADROOM))
}

export function menuMaxWidth(viewport: MenuViewport): number {
  return Math.max(0, Math.min(MENU_MAX_WIDTH, viewport.width - MENU_EDGE * 2))
}

export function placeMenu(input: {
  anchor: MenuAnchor
  size: MenuSize
  viewport: MenuViewport
}): MenuPlacement {
  const { anchor, size, viewport } = input
  const maxHeight = menuMaxHeight(anchor)
  const maxWidth = menuMaxWidth(viewport)
  const height = Math.max(0, Math.min(size.height, maxHeight))
  const width = Math.max(0, Math.min(size.width, maxWidth))
  const top = Math.max(MENU_EDGE, anchor.top - MENU_GAP - height)
  const left = Math.max(MENU_EDGE, Math.min(anchor.left, viewport.width - width - MENU_EDGE))
  return { left, top, width, height, maxHeight, maxWidth }
}

function tooltipRooms(menu: { left: number; width: number }, viewport: MenuViewport): { left: number; right: number } {
  return {
    left: Math.max(0, menu.left - TOOLTIP_OFFSET - MENU_EDGE),
    right: Math.max(0, viewport.width - MENU_EDGE - (menu.left + menu.width + TOOLTIP_OFFSET))
  }
}

export function tooltipMaxWidth(menu: { left: number; width: number }, viewport: MenuViewport): number {
  const rooms = tooltipRooms(menu, viewport)
  return Math.max(rooms.left, rooms.right)
}

export function placeTooltip(input: {
  menu: { left: number; width: number }
  row: { top: number; height: number }
  tooltip: MenuSize
  viewport: MenuViewport
}): TooltipPlacement {
  const { menu, row, tooltip, viewport } = input
  const rooms = tooltipRooms(menu, viewport)
  const right = menu.left + menu.width + TOOLTIP_OFFSET
  const side: TooltipPlacement['side'] =
    tooltip.width <= rooms.right ? 'right' : tooltip.width <= rooms.left ? 'left' : rooms.right >= rooms.left ? 'right' : 'left'
  const left = side === 'right' ? right : Math.max(MENU_EDGE, menu.left - TOOLTIP_OFFSET - tooltip.width)
  const top = Math.max(
    MENU_EDGE,
    Math.min(row.top + row.height / 2 - tooltip.height / 2, viewport.height - tooltip.height - MENU_EDGE)
  )
  return { left, top, side }
}

export function highlightParts(text: string, query: string): HighlightPart[] {
  if (!text) return []
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text, hit: false }]
  const haystack = text.toLowerCase()
  const parts: HighlightPart[] = []
  let at = 0
  for (;;) {
    const found = haystack.indexOf(needle, at)
    if (found < 0) break
    if (found > at) parts.push({ text: text.slice(at, found), hit: false })
    parts.push({ text: text.slice(found, found + needle.length), hit: true })
    at = found + needle.length
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false })
  return parts
}
