import { useLayoutEffect, useRef, type HTMLAttributes } from 'react'
import { cx } from './cx'

export interface MiddleTruncateProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  value: string
  tail?: number
  showTitle?: boolean
}

export function MiddleTruncate({ value, tail, showTitle = true, className, ...rest }: MiddleTruncateProps) {
  const split = splitForMiddleTruncate(value, tail)
  const headRef = useRef<HTMLSpanElement>(null)
  const head = split?.head
  useLayoutEffect(() => {
    const element = headRef.current
    if (!element || head === undefined) return
    fitHead(element)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fitHead(element))
    observer.observe(element)
    return () => observer.disconnect()
  }, [head])
  return (
    <span {...rest} title={showTitle ? value : rest.title} className={cx('ui-middle-truncate', className)}>
      {split ? (
        <>
          <span ref={headRef} className="ui-middle-truncate__head">
            {split.head}
          </span>
          <span className="ui-middle-truncate__tail">{split.tail}</span>
        </>
      ) : (
        <span key="whole" className="ui-middle-truncate__whole">
          {value}
        </span>
      )}
    </span>
  )
}

function fitHead(head: HTMLElement): void {
  const text = head.firstChild
  const overflowing = head.scrollWidth > head.clientWidth && text instanceof Text
  head.toggleAttribute('data-overflow', overflowing)
  let slack = 0
  if (overflowing) {
    const range = document.createRange()
    const left = head.getBoundingClientRect().left
    const widthTo = (end: number): number => {
      range.setStart(text, 0)
      range.setEnd(text, end)
      return range.getBoundingClientRect().right - left
    }
    let fits = 0
    let over = text.length
    while (over - fits > 1) {
      const mid = (fits + over) >> 1
      if (widthTo(mid) <= head.clientWidth) fits = mid
      else over = mid
    }
    if (/[\uD800-\uDBFF]/.test(text.data[fits - 1] ?? '')) fits -= 1
    slack = Math.max(0, head.clientWidth - widthTo(fits))
  }
  head.style.clipPath = slack > 0 ? `inset(-0.25em ${slack}px -0.25em 0)` : ''
  const tailNode = head.nextElementSibling
  if (tailNode instanceof HTMLElement) tailNode.style.translate = slack > 0 ? `-${slack}px 0` : ''
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
