export const OUTLINE_MIN_HEADINGS = 2
export const OUTLINE_MAX_DEPTH = 3
export const OUTLINE_CORNER = 6
export const READING_LINE_PX = 96

export interface OutlineHeading {
  text: string
  depth: number
}

export function outlineHeadings(raw: readonly { level: number; text: string }[]): OutlineHeading[] {
  const items = raw.map((item) => ({ level: item.level, text: item.text.replace(/\s+/g, ' ').trim() })).filter((item) => item.text)
  if (items.length === 0) return []
  const top = Math.min(...items.map((item) => item.level))
  return items.map((item) => ({ text: item.text, depth: Math.min(OUTLINE_MAX_DEPTH, item.level - top) }))
}

export function activeHeading(tops: readonly number[], line: number, atEnd: boolean): number {
  if (tops.length === 0) return -1
  if (atEnd) return tops.length - 1
  let found = 0
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= line) found = i
    else break
  }
  return found
}

export interface RailSpan {
  from: number
  y: number
  visible: boolean
}

export function hoverRail(activeY: number | null, hoverY: number | null, hovering: boolean, hoverIndex: number | null, activeIndex: number): RailSpan {
  if (!hovering || hoverY === null || hoverIndex === null || hoverIndex === activeIndex) return { from: 0, y: hoverY ?? 0, visible: false }
  const from = activeY !== null && hoverY <= activeY ? Math.max(0, hoverY - OUTLINE_CORNER) : activeY ?? 0
  return { from, y: hoverY, visible: true }
}

export function tickWidth(depth: number): number {
  return Math.max(6, 14 - depth * 3)
}
