import type { Element, ElementContent, Root, RootContent, Text } from 'hast'

export const FADE_MS = 200
export const FADE_SKIP_INITIAL_CHARS = 400
const FADE_REWRITE_TAIL_CHARS = 16

export interface FadeMark {
  from: number
  at: number
}

export interface FadeTrack {
  text: string
  marks: FadeMark[]
}

export interface FadeSpan {
  from: number
  to: number
  age: number
}

function emptyFadeTrack(text = ''): FadeTrack {
  return { text, marks: [] }
}

function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let at = 0
  while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) at += 1
  return at
}

export function trackReveal(previous: FadeTrack | null, text: string, now: number): FadeTrack {
  if (!previous) return text && text.length <= FADE_SKIP_INITIAL_CHARS ? { text, marks: [{ from: 0, at: now }] } : emptyFadeTrack(text)
  if (text === previous.text) return previous
  if (!previous.text && text.length > FADE_SKIP_INITIAL_CHARS) return emptyFadeTrack(text)
  const shared = sharedPrefixLength(previous.text, text)
  if ((shared === 0 && previous.text) || previous.text.length - shared > FADE_REWRITE_TAIL_CHARS) return emptyFadeTrack(text)
  const marks = previous.marks.filter((mark) => now - mark.at < FADE_MS && mark.from < shared)
  return { text, marks: [...marks, { from: shared, at: now }] }
}

export function fadeSpans(track: FadeTrack, now: number): FadeSpan[] {
  const spans: FadeSpan[] = []
  const live = track.marks.filter((mark) => now - mark.at < FADE_MS)
  for (let i = 0; i < live.length; i += 1) {
    const to = i + 1 < live.length ? live[i + 1].from : track.text.length
    if (to > live[i].from) spans.push({ from: live[i].from, to, age: Math.max(0, now - live[i].at) })
  }
  return spans
}

export function spansForBlock(spans: readonly FadeSpan[], offset: number, length: number): FadeSpan[] {
  const end = offset + length
  const out: FadeSpan[] = []
  for (const span of spans) {
    if (span.to <= offset || span.from >= end) continue
    out.push({ from: Math.max(0, span.from - offset), to: Math.min(length, span.to - offset), age: span.age })
  }
  return out
}

const SKIP_TAGS = new Set(['pre', 'code', 'svg', 'math'])

function fadeElement(value: string, age: number): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['v3-fade'], style: `animation-delay:-${Math.round(age)}ms` },
    children: [{ type: 'text', value }]
  }
}

function splitText(node: Text, spans: readonly FadeSpan[]): ElementContent[] | null {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (start === undefined || end === undefined) return null
  const value = node.value
  const pieces: ElementContent[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.to <= start || span.from >= end) continue
    const a = Math.min(value.length, Math.max(0, span.from - start))
    const b = Math.min(value.length, Math.max(a, span.to - start))
    if (b <= a) continue
    if (a > cursor) pieces.push({ type: 'text', value: value.slice(cursor, a) })
    pieces.push(fadeElement(value.slice(a, b), span.age))
    cursor = b
  }
  if (!pieces.length) return null
  if (cursor < value.length) pieces.push({ type: 'text', value: value.slice(cursor) })
  return pieces
}

function walk(parent: Root | Element, spans: readonly FadeSpan[]): void {
  const next: Array<RootContent | ElementContent> = []
  let changed = false
  for (const child of parent.children) {
    if (child.type === 'text') {
      const pieces = splitText(child, spans)
      if (pieces) {
        next.push(...pieces)
        changed = true
        continue
      }
    } else if (child.type === 'element' && !SKIP_TAGS.has(child.tagName)) {
      walk(child, spans)
    }
    next.push(child)
  }
  if (changed) parent.children = next as typeof parent.children
}

export function rehypeRevealFade(options: { spans?: readonly FadeSpan[] } = {}) {
  const spans = options.spans ?? []
  return (tree: Root): void => {
    if (spans.length) walk(tree, spans)
  }
}
