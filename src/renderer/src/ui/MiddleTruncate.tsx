import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'

export interface MiddleTruncatePart {
  text: string
  hit: boolean
}

export interface MiddleTruncateProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  value: string
  tail?: number
  showTitle?: boolean
  parts?: readonly MiddleTruncatePart[]
}

function sliceParts(parts: readonly MiddleTruncatePart[], from: number, to: number): MiddleTruncatePart[] {
  const out: MiddleTruncatePart[] = []
  let at = 0
  for (const part of parts) {
    const start = Math.max(from, at)
    const end = Math.min(to, at + part.text.length)
    if (end > start) out.push({ text: part.text.slice(start - at, end - at), hit: part.hit })
    at += part.text.length
  }
  return out
}

function renderParts(parts: readonly MiddleTruncatePart[] | undefined, text: string, from: number): ReactNode {
  if (!parts) return text
  return sliceParts(parts, from, from + text.length).map((part, index) => (part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))
}

export function MiddleTruncate({ value, tail, showTitle = true, parts, className, ...rest }: MiddleTruncateProps) {
  const split = splitForMiddleTruncate(value, tail)
  const headRef = useRef<HTMLSpanElement>(null)
  const head = split?.head
  const partsKey = parts ? parts.map((part) => `${part.hit ? 1 : 0}${part.text.length}`).join(',') : ''
  useLayoutEffect(() => {
    const element = headRef.current
    if (!element || head === undefined) return
    fitHead(element)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fitHead(element))
    observer.observe(element)
    return () => observer.disconnect()
  }, [head, partsKey])
  return (
    <span {...rest} title={showTitle ? value : rest.title} className={cx('ui-middle-truncate', className)}>
      {split ? (
        <>
          <span ref={headRef} className="ui-middle-truncate__head">
            {renderParts(parts, split.head, 0)}
          </span>
          <span className="ui-middle-truncate__tail">{renderParts(parts, split.tail, split.head.length)}</span>
        </>
      ) : (
        <span key="whole" className="ui-middle-truncate__whole">
          {renderParts(parts, value, 0)}
        </span>
      )}
    </span>
  )
}

interface HeadFit {
  overflowing: boolean
  slack: number
}

function textNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  return nodes
}

function locate(nodes: readonly Text[], index: number): { node: Text; offset: number } {
  let at = 0
  for (const node of nodes) {
    if (index <= at + node.length) return { node, offset: index - at }
    at += node.length
  }
  const last = nodes[nodes.length - 1]
  return { node: last, offset: last.length }
}

function measureHead(head: HTMLElement): HeadFit {
  const nodes = textNodes(head)
  const overflowing = head.scrollWidth > head.clientWidth && nodes.length > 0
  let slack = 0
  if (overflowing) {
    const range = document.createRange()
    const left = head.getBoundingClientRect().left
    const width = head.clientWidth
    const total = nodes.reduce((sum, node) => sum + node.length, 0)
    const widthTo = (end: number): number => {
      const stop = locate(nodes, end)
      range.setStart(nodes[0], 0)
      range.setEnd(stop.node, stop.offset)
      return range.getBoundingClientRect().right - left
    }
    let fits = 0
    let over = total
    while (over - fits > 1) {
      const mid = (fits + over) >> 1
      if (widthTo(mid) <= width) fits = mid
      else over = mid
    }
    const before = fits > 0 ? locate(nodes, fits) : null
    if (before && before.offset > 0 && /[\uD800-\uDBFF]/.test(before.node.data[before.offset - 1] ?? '')) fits -= 1
    slack = Math.max(0, width - widthTo(fits))
  }
  return { overflowing, slack }
}

function applyHead(head: HTMLElement, fit: HeadFit): void {
  head.toggleAttribute('data-overflow', fit.overflowing)
  head.style.clipPath = fit.slack > 0 ? `inset(-0.25em ${fit.slack}px -0.25em 0)` : ''
  const tailNode = head.nextElementSibling
  if (tailNode instanceof HTMLElement) tailNode.style.translate = fit.slack > 0 ? `-${fit.slack}px 0` : ''
}

const queuedHeads = new Set<HTMLElement>()

function flushHeads(): void {
  const heads = [...queuedHeads].filter((head) => head.isConnected)
  queuedHeads.clear()
  const fits = heads.map(measureHead)
  heads.forEach((head, index) => applyHead(head, fits[index]))
}

function fitHead(head: HTMLElement): void {
  if (queuedHeads.size === 0) queueMicrotask(flushHeads)
  queuedHeads.add(head)
}

const DEFAULT_TAIL = 10
const MAX_SEGMENT_TAIL = 16
const MIN_WORD_TAIL = 4
const WORD_BREAK = /[-_./\\]/

export function splitForMiddleTruncate(value: string, tail?: number): { head: string; tail: string } | null {
  const chars = Array.from(value)
  let keep = tail ?? DEFAULT_TAIL
  if (tail === undefined) {
    const slash = Math.max(chars.lastIndexOf('/'), chars.lastIndexOf('\\'))
    if (slash > 0 && slash < chars.length - 1) {
      const segment = chars.length - slash - 1
      keep = segment <= MAX_SEGMENT_TAIL ? segment : DEFAULT_TAIL
    }
  }
  if (keep <= 0 || chars.length <= keep + 4) return null
  let cut = chars.length - keep
  if (tail === undefined && !WORD_BREAK.test(chars[cut - 1] ?? '')) {
    const startsWord = (index: number): boolean => WORD_BREAK.test(chars[index - 1] ?? '')
    let snapped = -1
    for (let index = cut + 1; index <= chars.length - MIN_WORD_TAIL; index++) {
      if (startsWord(index)) {
        snapped = index
        break
      }
    }
    for (let index = cut - 1; snapped < 0 && index >= chars.length - MAX_SEGMENT_TAIL && index > 4; index--) {
      if (startsWord(index)) snapped = index
    }
    if (snapped > 0) cut = snapped
  }
  return { head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('') }
}
