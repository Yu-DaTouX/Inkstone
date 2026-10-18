import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { ShimmerText } from '../../ui'
import { Icon } from './Icon'

function peekText(text: string): string {
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line) return line.length > 160 ? line.slice(-160) : line
  }
  return ''
}

export function ThinkingLine({ text, ms, live, defaultOpen = false }: { text: string; ms?: number; live?: boolean; defaultOpen?: boolean }): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen || !!live)
  const touchedRef = useRef(false)
  const followRef = useRef(true)
  const wasLiveRef = useRef(!!live)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!touchedRef.current) {
      if (live && !wasLiveRef.current) setOpen(true)
      if (!live && wasLiveRef.current) setOpen(false)
    }
    wasLiveRef.current = !!live
  }, [live])

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && open && followRef.current) el.scrollTop = el.scrollHeight
  }, [text, open])

  const secs = ms && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : null
  if (!text) return null

  const toggle = (): void => {
    touchedRef.current = true
    followRef.current = true
    const next = !open
    setOpen(next)
    if (next) requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'nearest' }))
  }

  const label = live ? t('reason.now') : secs ? t('proc.reason', { n: secs }) : t('reason.past')
  const peek = open ? '' : peekText(text)

  return (
    <div ref={rootRef} className="v3-think" data-live={live || undefined} data-open={open || undefined} data-testid="v3-thinking">
      <button className="v3-think-head" aria-expanded={open} onClick={toggle} data-testid="v3-thinking-toggle">
        <Icon name="brain" size={13} />
        <ShimmerText className="v3-think-label" active={live}>{label}</ShimmerText>
        {peek ? (
          <span className="v3-think-peek" dir="rtl" data-testid="v3-thinking-peek">
            <span dir="ltr">{peek}</span>
          </span>
        ) : null}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} className="v3-chev" />
      </button>
      {open ? (
        <div
          ref={bodyRef}
          className="v3-think-body"
          tabIndex={0}
          data-testid="v3-thinking-body"
          onScroll={(event) => {
            const el = event.currentTarget
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  )
}
