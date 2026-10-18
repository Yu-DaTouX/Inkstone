import { useEffect, useRef, type ReactNode } from 'react'
import { cx } from './cx'
import { joinShimmer, sweepOnce } from './shimmer-clock'
import './Shimmer.css'

export interface ShimmerTextProps {
  children: string
  active?: boolean
  lead?: ReactNode
  className?: string
}

export function ShimmerText({ children, active = true, lead, className }: ShimmerTextProps) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!active || !el) return undefined
    return joinShimmer(el)
  }, [active])
  return (
    <span ref={ref} className={cx('ui-shimmer', className)} data-active={active || undefined}>
      <span className="ui-shimmer__base">{lead}{children}</span>
      {active ? (
        <span className="ui-shimmer__win" aria-hidden="true">
          <span className="ui-shimmer__hi">{lead}{children}</span>
        </span>
      ) : null}
    </span>
  )
}

const FRESH_SETTLE_MS = 1200

export interface CompletionSweepProps {
  done: boolean
  settledAt?: number
}

export function CompletionSweep({ done, settledAt }: CompletionSweepProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const wasDone = useRef(done)
  useEffect(() => {
    const el = ref.current
    const fresh = typeof settledAt === 'number' && Date.now() - settledAt < FRESH_SETTLE_MS
    if (done && el && (!wasDone.current || fresh)) sweepOnce(el)
    wasDone.current = done
  }, [done, settledAt])
  return (
    <span className="ui-sweep" aria-hidden="true">
      <span ref={ref} className="ui-sweep__light" />
    </span>
  )
}
