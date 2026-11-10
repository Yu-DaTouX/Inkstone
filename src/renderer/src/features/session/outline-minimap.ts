import type { OutlineTurn } from '../../../../shared/outline-turns'

export const MINIMAP_MIN_TURNS = 2
export const MINIMAP_PAGE_STEP = 10
const PREVIEW_SOURCE_CHARS = 400
const VALUE_TEXT_CHARS = 120

export interface TurnPreview {
  line: string
  answer: string
}

export interface TurnRange {
  first: number
  last: number
}

export function minimapTopPercent(index: number, count: number): number {
  if (count <= 1) return 0
  return (Math.max(0, Math.min(index, count - 1)) / (count - 1)) * 100
}

export function minimapIndexAt(offset: number, size: number, count: number): number {
  if (count <= 0) return -1
  if (count === 1 || size <= 0) return 0
  const ratio = Math.max(0, Math.min(1, offset / size))
  return Math.round(ratio * (count - 1))
}

export function clampTurn(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, index))
}

export function firstLine(text: string): string {
  let start = 0
  while (start <= text.length) {
    const end = text.indexOf('\n', start)
    const line = text.slice(start, end < 0 ? text.length : end).trim()
    if (line) return line
    if (end < 0) break
    start = end + 1
  }
  return ''
}

export function valueTextLine(text: string): string {
  return text.length > VALUE_TEXT_CHARS ? `${text.slice(0, VALUE_TEXT_CHARS)}…` : text
}

function tableCells(line: string): string {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean)
    .join(' · ')
}

function inlinePlain(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:>\s?)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1')
}

export function plainPreview(markdown: string): string {
  const parts: string[] = []
  let fenced = false
  for (const raw of markdown.slice(0, PREVIEW_SOURCE_CHARS).split('\n')) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    let line = raw
    if (!fenced) {
      if (/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) continue
      if (/^\s*\$\$\s*$/.test(line)) continue
      if (/^\s*\|.*\|\s*$/.test(line)) line = tableCells(line)
      line = inlinePlain(line)
    }
    const trimmed = line.trim()
    if (trimmed) parts.push(trimmed)
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

const lineCache = new WeakMap<OutlineTurn, string>()
const previewCache = new WeakMap<OutlineTurn, TurnPreview>()

export function turnLine(turn: OutlineTurn): string {
  const saved = lineCache.get(turn)
  if (saved !== undefined) return saved
  const line = firstLine(turn.user)
  lineCache.set(turn, line)
  return line
}

export function turnPreview(turn: OutlineTurn): TurnPreview {
  const saved = previewCache.get(turn)
  if (saved) return saved
  const preview = { line: turnLine(turn), answer: plainPreview(turn.assistant) }
  previewCache.set(turn, preview)
  return preview
}
