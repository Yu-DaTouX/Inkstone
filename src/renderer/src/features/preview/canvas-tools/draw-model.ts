import { rectClamp, rectExpand, rectIntersect, rectNormalize, visibleBoxRegion } from '../canvas-region'
import type { CanvasRegionSize } from '../canvas-region'

export { rectClamp, rectExpand, rectIntersect, rectNormalize, visibleBoxRegion }

export type DrawPen = 'free' | 'rect' | 'ellipse' | 'arrow' | 'text'

export interface DrawPoint {
  x: number
  y: number
}

export interface DrawRect {
  x: number
  y: number
  w: number
  h: number
}

export type DrawShape =
  | { kind: 'free'; points: DrawPoint[]; color: string; width: number }
  | { kind: 'rect'; rect: DrawRect; color: string; width: number }
  | { kind: 'ellipse'; rect: DrawRect; color: string; width: number }
  | { kind: 'arrow'; from: DrawPoint; to: DrawPoint; color: string; width: number }
  | { kind: 'text'; at: DrawPoint; text: string; color: string; halo: string; size: number }

export interface DrawPaletteSpec {
  key: string
  variable: string
  fallback: string
}

export type DrawStageSize = CanvasRegionSize

export const DRAW_PENS: readonly DrawPen[] = ['free', 'rect', 'ellipse', 'arrow', 'text']

export const DRAW_STROKE_WIDTH = 3
export const DRAW_TEXT_SIZE = 15
export const DRAW_TEXT_LINE = 1.35
export const DRAW_MIN_SIZE = 2
export const DRAW_FOCUS_PADDING = 72
export const DRAW_REGION_MARGIN = 16
export const DRAW_DEFAULT_COLOR = 'accent'

export const DRAW_PALETTE: readonly DrawPaletteSpec[] = [
  { key: 'accent', variable: '--accent', fallback: '#2A78D6' },
  { key: 'fail', variable: '--fail', fallback: '#D03B3B' },
  { key: 'ok', variable: '--ok', fallback: '#009300' },
  { key: 'ask', variable: '--ask-t', fallback: '#734500' },
  { key: 'stall', variable: '--stall', fallback: '#E0702E' }
]

export const DRAW_HALO_SPEC: DrawPaletteSpec = { key: 'halo', variable: '--bg', fallback: '#FCFCFB' }

const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', sans-serif"

export function isCssColor(value: string | null | undefined): boolean {
  const text = (value ?? '').trim().toLowerCase()
  if (!text || text.includes('(') && !/^(rgba?|hsla?)\(/.test(text)) return false
  return /^#[0-9a-f]{3,8}$/.test(text) || /^(rgba?|hsla?)\(/.test(text) || /^[a-z]{3,20}$/.test(text)
}

export function drawColor(key: string, colors: Record<string, string>): string {
  const spec = DRAW_PALETTE.find((candidate) => candidate.key === key) ?? DRAW_PALETTE[0]
  return colors[spec.key] ?? spec.fallback
}

export function resolveDrawColors(read: (variable: string) => string | null): Record<string, string> {
  const colors: Record<string, string> = {}
  for (const spec of DRAW_PALETTE) {
    const value = read(spec.variable)
    colors[spec.key] = isCssColor(value) ? (value as string).trim() : spec.fallback
  }
  const halo = read(DRAW_HALO_SPEC.variable)
  colors.halo = isCssColor(halo) ? (halo as string).trim() : DRAW_HALO_SPEC.fallback
  return colors
}

export function num(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value * 100) / 100)
}

export function distance(a: DrawPoint, b: DrawPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function rectFromPoints(a: DrawPoint, b: DrawPoint): DrawRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y)
  }
}

export function rectUnion(a: DrawRect, b: DrawRect): DrawRect {
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.w, b.x + b.w)
  const bottom = Math.max(a.y + a.h, b.y + b.h)
  return { x: left, y: top, w: right - left, h: bottom - top }
}

export function rectIsTiny(rect: DrawRect, min = DRAW_MIN_SIZE): boolean {
  const normal = rectNormalize(rect)
  return normal.w < min || normal.h < min
}

function perpendicularDistance(point: DrawPoint, from: DrawPoint, to: DrawPoint): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) return distance(point, from)
  return Math.abs(dy * (point.x - from.x) - dx * (point.y - from.y)) / length
}

export function dedupePoints(points: readonly DrawPoint[], min = 0.01): DrawPoint[] {
  const out: DrawPoint[] = []
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    const last = out[out.length - 1]
    if (last && distance(last, point) < min) continue
    out.push({ x: point.x, y: point.y })
  }
  return out
}

export function simplifyPoints(points: readonly DrawPoint[], tolerance: number): DrawPoint[] {
  const source = dedupePoints(points)
  if (source.length <= 2 || !(tolerance > 0)) return source
  const keep = new Array<boolean>(source.length).fill(false)
  keep[0] = true
  keep[source.length - 1] = true
  const stack: Array<[number, number]> = [[0, source.length - 1]]
  while (stack.length) {
    const span = stack.pop() as [number, number]
    let index = -1
    let far = 0
    for (let i = span[0] + 1; i < span[1]; i++) {
      const value = perpendicularDistance(source[i], source[span[0]], source[span[1]])
      if (value > far) {
        far = value
        index = i
      }
    }
    if (index > 0 && far > tolerance) {
      keep[index] = true
      stack.push([span[0], index], [index, span[1]])
    }
  }
  return source.filter((_, index) => keep[index])
}

export function strokePath(points: readonly DrawPoint[]): string {
  const source = dedupePoints(points)
  if (!source.length) return ''
  if (source.length === 1) {
    const only = source[0]
    return `M ${num(only.x)} ${num(only.y)} l 0.01 0`
  }
  let path = `M ${num(source[0].x)} ${num(source[0].y)}`
  if (source.length === 2) return `${path} L ${num(source[1].x)} ${num(source[1].y)}`
  for (let i = 0; i < source.length - 1; i++) {
    const previous = source[i - 1] ?? source[i]
    const current = source[i]
    const next = source[i + 1]
    const following = source[i + 2] ?? next
    const c1 = { x: current.x + (next.x - previous.x) / 6, y: current.y + (next.y - previous.y) / 6 }
    const c2 = { x: next.x - (following.x - current.x) / 6, y: next.y - (following.y - current.y) / 6 }
    path += ` C ${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(next.x)} ${num(next.y)}`
  }
  return path
}

export function arrowGeometry(
  from: DrawPoint,
  to: DrawPoint,
  width: number,
  unit: number
): { line: DrawPoint[]; head: DrawPoint[] } {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (!(length > 0.01)) return { line: [from, to], head: [] }
  const head = Math.min(length * 0.6, Math.max(10, width * 4) * unit)
  const angle = Math.atan2(dy, dx)
  const spread = 0.42
  const base = { x: to.x - Math.cos(angle) * head * 0.82, y: to.y - Math.sin(angle) * head * 0.82 }
  return {
    line: [from, base],
    head: [
      { x: to.x, y: to.y },
      { x: to.x - Math.cos(angle - spread) * head, y: to.y - Math.sin(angle - spread) * head },
      { x: to.x - Math.cos(angle + spread) * head, y: to.y - Math.sin(angle + spread) * head }
    ]
  }
}

export function textLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim())
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines
}

function charRatio(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code >= 0x2e80) return 1
  if (char === ' ') return 0.3
  if ("il.,:;'!|".includes(char)) return 0.32
  if ('MW@%'.includes(char)) return 0.92
  return 0.58
}

export function estimateTextWidth(text: string, size: number): number {
  let width = 0
  for (const char of text) width += charRatio(char) * size
  return width
}

export function shapeBounds(shape: DrawShape): DrawRect {
  if (shape.kind === 'free') {
    if (!shape.points.length) return { x: 0, y: 0, w: 0, h: 0 }
    let left = shape.points[0].x
    let top = shape.points[0].y
    let right = left
    let bottom = top
    for (const point of shape.points) {
      left = Math.min(left, point.x)
      top = Math.min(top, point.y)
      right = Math.max(right, point.x)
      bottom = Math.max(bottom, point.y)
    }
    return { x: left, y: top, w: right - left, h: bottom - top }
  }
  if (shape.kind === 'rect' || shape.kind === 'ellipse') return rectNormalize(shape.rect)
  if (shape.kind === 'arrow') return rectFromPoints(shape.from, shape.to)
  const lines = textLines(shape.text)
  const width = lines.reduce((widest, line) => Math.max(widest, estimateTextWidth(line, shape.size)), 0)
  return { x: shape.at.x, y: shape.at.y, w: width, h: lines.length * shape.size * DRAW_TEXT_LINE }
}

export function shapesBounds(shapes: readonly DrawShape[]): DrawRect | null {
  let bounds: DrawRect | null = null
  for (const shape of shapes) {
    const next = shapeBounds(shape)
    bounds = bounds ? rectUnion(bounds, next) : next
  }
  return bounds
}

export function shapeTextLabels(shapes: readonly DrawShape[]): string[] {
  const labels: string[] = []
  for (const shape of shapes) {
    if (shape.kind !== 'text') continue
    const text = textLines(shape.text).join(' ').trim()
    if (text) labels.push(text)
  }
  return labels
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export interface DrawSvgOptions {
  unit: number
}

export function shapeSvg(shape: DrawShape, options: DrawSvgOptions): string {
  const unit = options.unit > 0 ? options.unit : 1
  const color = escapeXml(shape.color)
  if (shape.kind === 'free') {
    const path = strokePath(shape.points)
    if (!path) return ''
    return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${num(shape.width * unit)}" stroke-linecap="round" stroke-linejoin="round"/>`
  }
  if (shape.kind === 'rect') {
    const rect = rectNormalize(shape.rect)
    return `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(rect.h)}" rx="${num(4 * unit)}" fill="none" stroke="${color}" stroke-width="${num(shape.width * unit)}" stroke-linejoin="round"/>`
  }
  if (shape.kind === 'ellipse') {
    const rect = rectNormalize(shape.rect)
    return `<ellipse cx="${num(rect.x + rect.w / 2)}" cy="${num(rect.y + rect.h / 2)}" rx="${num(rect.w / 2)}" ry="${num(rect.h / 2)}" fill="none" stroke="${color}" stroke-width="${num(shape.width * unit)}"/>`
  }
  if (shape.kind === 'arrow') {
    const geometry = arrowGeometry(shape.from, shape.to, shape.width, unit)
    const line = geometry.line
    const head = geometry.head
    const stroke = `fill="none" stroke="${color}" stroke-width="${num(shape.width * unit)}" stroke-linecap="round"`
    const lineSvg = `<path d="M ${num(line[0].x)} ${num(line[0].y)} L ${num(line[1].x)} ${num(line[1].y)}" ${stroke}/>`
    if (head.length !== 3) return lineSvg
    const points = head.map((point) => `${num(point.x)},${num(point.y)}`).join(' ')
    return `${lineSvg}<polygon points="${points}" fill="${color}" stroke="${color}" stroke-width="${num(unit / 2)}" stroke-linejoin="round"/>`
  }
  const lines = textLines(shape.text)
  if (!lines.length) return ''
  const size = shape.size > 0 ? shape.size : 1
  const lineHeight = size * DRAW_TEXT_LINE
  const halo = escapeXml(shape.halo)
  return lines
    .map((line, index) => {
      const y = shape.at.y + lineHeight * (index + 1) - size * 0.28
      return `<text x="${num(shape.at.x)}" y="${num(y)}" font-family="${FONT_STACK}" font-size="${num(size)}" font-weight="600" fill="${color}" stroke="${halo}" stroke-width="${num(3 * unit)}" stroke-linejoin="round" paint-order="stroke">${escapeXml(line)}</text>`
    })
    .join('')
}

export function shapesSvg(shapes: readonly DrawShape[], options: DrawSvgOptions): string {
  return shapes.map((shape) => shapeSvg(shape, options)).join('')
}

export function exportSvg(shapes: readonly DrawShape[], rect: DrawRect, unit: number): string {
  const width = Math.max(1, rect.w)
  const height = Math.max(1, rect.h)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(rect.x)} ${num(rect.y)} ${num(width)} ${num(height)}" preserveAspectRatio="none">${shapesSvg(shapes, { unit })}</svg>`
}

export function captureRegion(
  shapes: readonly DrawShape[],
  visible: DrawRect,
  frame: DrawStageSize,
  margin = DRAW_REGION_MARGIN
): DrawRect {
  const bounds = shapesBounds(shapes)
  const union = bounds ? rectUnion(visible, rectExpand(bounds, margin)) : visible
  return rectClamp(union, { x: 0, y: 0, w: frame.width, h: frame.height })
}
