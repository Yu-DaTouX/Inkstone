import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { formatDuration } from '../../../../shared/duration'
import { Collapsible, CollapsibleHeader, CollapsiblePanel, ShimmerText } from '../../ui'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { showsThinkingInline } from './transcript-view-model'
import { useToolExpansion, useTranscriptViewScope } from './use-tool-run'

function peekText(text: string): string {
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line) return line.length > 160 ? line.slice(-160) : line
  }
  return ''
}

export function ThinkingAside({ text, ms, live, stacked = false }: { text: string; ms?: number; live?: boolean; stacked?: boolean }): JSX.Element | null {
  const t = useT()
  const tt = useSessionText()
  const followRef = useRef(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [text])

  if (!text) return null
  const secs = ms && ms > 0 ? Math.max(1, Math.round(ms / 1000)) : null
  const label = live ? t('reason.now') : secs ? t('proc.reason', { n: secs }) : t('reason.past')

  return (
    <aside className="v3-think-aside" data-live={live || undefined} aria-label={label} data-testid="v3-thinking-aside">
      <div className="v3-think-aside-head">
        <Icon name="brain" size={13} />
        <ShimmerText className="v3-think-label" active={live}>{label}</ShimmerText>
        {stacked ? <span className="v3-think-aside-hint" data-testid="v3-thinking-aside-stacked">{tt('asideStacked')}</span> : null}
      </div>
      <div
        ref={bodyRef}
        className="v3-think-aside-body"
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
        }}
      >
        {text}
      </div>
    </aside>
  )
}

function useLiveElapsed(live: boolean): number | null {
  const startRef = useRef<number | null>(live ? Date.now() : null)
  const [now, setNow] = useState(() => Date.now())
  if (live && startRef.current === null) startRef.current = Date.now()
  if (!live && startRef.current !== null) startRef.current = null
  useEffect(() => {
    if (!live) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])
  return live && startRef.current !== null ? Math.max(0, now - startRef.current) : null
}

export function ThinkingLine({ text, ms, live, defaultOpen = false, step, expansionId }: { text: string; ms?: number; live?: boolean; defaultOpen?: boolean; step?: boolean; expansionId?: string }): JSX.Element | null {
  const t = useT()
  const inlineView = showsThinkingInline(useTranscriptViewScope())
  const asStep = step ?? inlineView
  const touchedRef = useRef(false)
  const [localOpen, setLocalOpen] = useState(defaultOpen && !live)
  const [stored, setStored] = useToolExpansion(expansionId ? `think:${expansionId}` : '')
  const open = expansionId && stored !== undefined ? stored : localOpen
  const setOpen = (next: boolean): void => {
    setLocalOpen(next)
    if (expansionId && touchedRef.current) setStored(next)
  }
  const followRef = useRef(true)
  const liveRef = useRef(!!live)
  liveRef.current = !!live
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const elapsed = useLiveElapsed(!!live)

  useEffect(() => {
    if (!touchedRef.current) setOpen(defaultOpen && !liveRef.current)
  }, [defaultOpen])

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
    <Collapsible ref={rootRef} className={asStep ? 'v3-think v3-step' : 'v3-think'} data-live={live || undefined} data-open={open || undefined} data-row={asStep ? 'step' : undefined} data-testid="v3-thinking" isExpanded={open} onExpandedChange={toggle}>
      <CollapsibleHeader className={asStep ? 'v3-step-head v3-think-step' : 'v3-think-head'} size="compact" chevron="end" icon={<Icon name="brain" size={13} />} data-testid="v3-thinking-toggle">
        <span className="v3-step-line">
          {asStep ? (
            <span className="v3-step-label"><ShimmerText active={!!live}>{label}</ShimmerText></span>
          ) : (
            <ShimmerText className="v3-think-label" active={live}>{label}</ShimmerText>
          )}
          {elapsed !== null ? <span className="v3-step-time v3-think-time" data-testid="v3-thinking-elapsed">{formatDuration(elapsed)}</span> : null}
          {peek ? (
            <span className={asStep ? 'v3-step-target v3-think-peek' : 'v3-think-peek'} dir="rtl" data-testid="v3-thinking-peek">
              <span dir="ltr">{peek}</span>
            </span>
          ) : null}
        </span>
      </CollapsibleHeader>
      <CollapsiblePanel animated className="v3-step-panel">
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
      </CollapsiblePanel>
    </Collapsible>
  )
}
