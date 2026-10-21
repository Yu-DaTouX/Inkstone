import type { ElementContent, Root, RootContent } from 'hast'

export interface CodeToken {
  text: string
  classes: readonly string[]
}

export type CodeLine = CodeToken[]

export interface JumpRange {
  first: number
  last: number
}

export const JUMP_RANGE_MAX = 200
export const MIN_NUMBER_DIGITS = 3
export const CODE_LINE_LIMIT = 20_000

const NO_CLASSES: readonly string[] = []

function classNameOf(node: ElementContent | RootContent): string {
  if (node.type !== 'element') return ''
  const value = node.properties?.className
  if (Array.isArray(value)) return value.map(String).join(' ')
  return typeof value === 'string' ? value : ''
}

function sameClasses(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function stripCarriageReturn(line: CodeLine): CodeLine {
  const last = line[line.length - 1]
  if (!last || !last.text.endsWith('\r')) return line
  const text = last.text.slice(0, -1)
  return text ? [...line.slice(0, -1), { text, classes: last.classes }] : line.slice(0, -1)
}

export function plainCodeLines(text: string): CodeLine[] {
  return text.split('\n').map((line) => {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line
    return clean ? [{ text: clean, classes: NO_CLASSES }] : []
  })
}

export function splitHighlightedLines(tree: Root | null, text: string): CodeLine[] {
  if (!tree) return plainCodeLines(text)
  const lines: CodeLine[] = [[]]
  const push = (value: string, classes: readonly string[]): void => {
    const parts = value.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (!part) return
      const line = lines[lines.length - 1]
      const previous = line[line.length - 1]
      if (previous && sameClasses(previous.classes, classes)) previous.text += part
      else line.push({ text: part, classes })
    })
  }
  const walk = (nodes: readonly (ElementContent | RootContent)[], classes: readonly string[]): void => {
    for (const node of nodes) {
      if (node.type === 'text') push(node.value, classes)
      else if (node.type === 'element') {
        const name = classNameOf(node)
        walk(node.children, name ? [...classes, name] : classes)
      }
    }
  }
  walk(tree.children, NO_CLASSES)
  return lines.map(stripCarriageReturn)
}

export function lineText(line: CodeLine): string {
  let value = ''
  for (const token of line) value += token.text
  return value
}

export function numberColumnWidth(lineCount: number, firstNumber = 1): number {
  const last = Math.max(1, firstNumber + Math.max(0, lineCount) - 1)
  return Math.max(MIN_NUMBER_DIGITS, String(last).length)
}

export function jumpRange(line: number | undefined, lineEnd?: number): JumpRange | null {
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null
  const last =
    typeof lineEnd === 'number' && Number.isInteger(lineEnd) && lineEnd > line ? Math.min(lineEnd, line + JUMP_RANGE_MAX - 1) : line
  return { first: line, last }
}

export function capCodeText(text: string, limit = CODE_LINE_LIMIT): { text: string; capped: boolean } {
  let index = -1
  for (let i = 0; i < limit; i += 1) {
    index = text.indexOf('\n', index + 1)
    if (index < 0) return { text, capped: false }
  }
  return { text: text.slice(0, index), capped: true }
}

export function scrollPastEndPadding(viewportHeight: number, lineHeight: number, paddingTop: number): number {
  return Math.max(0, viewportHeight - lineHeight - paddingTop - 0.5)
}

export function leadingColumns(text: string, tabSize: number): number | null {
  let columns = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    if (ch === 32) columns += 1
    else if (ch === 9) columns += tabSize - (columns % tabSize)
    else return columns
  }
  return null
}

export function indentUnit(texts: readonly string[], tabSize: number): number {
  let unit = 0
  for (const text of texts) {
    if (text.charCodeAt(0) !== 32) continue
    const columns = leadingColumns(text, tabSize)
    if (columns && (unit === 0 || columns < unit)) unit = columns
    if (unit === 1) break
  }
  return unit > 0 ? Math.min(unit, 8) : tabSize
}

export function indentColumns(texts: readonly string[], tabSize: number): number[] {
  const raw = texts.map((text) => leadingColumns(text, tabSize))
  const following = new Array<number>(texts.length).fill(0)
  let next = 0
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const value = raw[i]
    if (value !== null) next = value
    following[i] = next
  }
  const result = new Array<number>(texts.length).fill(0)
  let previous = 0
  for (let i = 0; i < raw.length; i += 1) {
    const value = raw[i]
    if (value !== null) {
      result[i] = value
      previous = value
      continue
    }
    result[i] = Math.min(previous, following[i])
  }
  return result
}

export function guideLevels(texts: readonly string[], tabSize: number): { unit: number; levels: number[] } {
  const unit = indentUnit(texts, tabSize)
  const levels = indentColumns(texts, tabSize).map((columns) => Math.floor(columns / unit))
  return { unit, levels }
}

export function wrapIndentColumns(texts: readonly string[], tabSize: number): number[] {
  return texts.map((text) => leadingColumns(text, tabSize) ?? 0)
}

export function foldRegions(texts: readonly string[], tabSize: number): Map<number, number> {
  const raw = texts.map((text) => leadingColumns(text, tabSize))
  const regions = new Map<number, number>()
  const open: { index: number; indent: number }[] = []
  const close = (end: number): void => {
    const entry = open.pop()
    if (entry && end > entry.index) regions.set(entry.index, end)
  }
  let last = -1
  for (let i = 0; i < raw.length; i += 1) {
    const indent = raw[i]
    if (indent === null) continue
    while (open.length && open[open.length - 1].indent >= indent) close(last)
    open.push({ index: i, indent })
    last = i
  }
  while (open.length) close(last)
  return regions
}

export function visibleLineIndexes(count: number, regions: ReadonlyMap<number, number>, folded: ReadonlySet<number>): number[] {
  const rows: number[] = []
  for (let i = 0; i < count; i += 1) {
    rows.push(i)
    if (folded.has(i)) {
      const end = regions.get(i)
      if (end !== undefined && end > i) i = end
    }
  }
  return rows
}

export function rowIndexOfLine(rows: readonly number[], lineIndex: number): number {
  let low = 0
  let high = rows.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const value = rows[mid]
    if (value === lineIndex) return mid
    if (value < lineIndex) low = mid + 1
    else high = mid - 1
  }
  return -1
}

export function unfoldToReveal(regions: ReadonlyMap<number, number>, folded: ReadonlySet<number>, lineIndex: number): Set<number> {
  const next = new Set(folded)
  for (const start of folded) {
    const end = regions.get(start)
    if (end !== undefined && start < lineIndex && lineIndex <= end) next.delete(start)
  }
  return next
}
