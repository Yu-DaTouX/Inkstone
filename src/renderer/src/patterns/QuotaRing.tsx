import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Dialog } from 'react-aria-components'
import { RefreshCw } from 'lucide-react'
import { Button, IconButton, Popover, Spinner } from '../ui'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { useUiV3 } from '../state/ui-v3'
import { LIVE_QUOTA_POLL_MS, liveQuotaSupported, refreshLiveQuota, useLiveQuota } from '../state/live-quota'
import {
  bindingQuotaWindow,
  forecastProjectionPct,
  quotaReadingStale,
  windowAwaitingReset,
  windowUsedPct
} from '../../../shared/quota-forecast'
import { QuotaWindowRow, quotaReadAgo, quotaShortLabel, quotaWindowTone, type QuotaWindowTone } from './QuotaWindowRow'
import './context-ring.css'
import './quota-ring.css'

const TICK_MS = 30_000
const R = 5
const C = 2 * Math.PI * R

const arcDash = (percent: number): string => `${(Math.max(0, Math.min(100, percent)) / 100) * C} ${C}`

function refreshFor(provider: string, force = false): Promise<unknown> {
  if (!liveQuotaSupported(provider)) return Promise.resolve(null)
  return refreshLiveQuota(provider, { force, budget: useStore.getState().settings?.providerBudgets?.[provider] })
}

function QuotaArc({
  percent,
  projected,
  tone,
  exhaust
}: {
  percent: number | null
  projected: number | null
  tone: QuotaWindowTone
  exhaust: boolean
}): ReactElement {
  return (
    <svg className="ctx-ring-svg" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle className="ctx-ring-track" cx="7" cy="7" r={R} fill="none" strokeWidth="2" />
      {projected !== null && percent !== null && projected > percent ? (
        <circle
          className="quota-ring-projection"
          data-tone={tone}
          data-forecast={exhaust ? 'exhaust' : undefined}
          data-testid="quota-ring-projection"
          cx="7"
          cy="7"
          r={R}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={arcDash(projected)}
          transform="rotate(-90 7 7)"
        />
      ) : null}
      {percent !== null && percent > 0 ? (
        <circle
          className="quota-ring-arc"
          data-tone={tone}
          cx="7"
          cy="7"
          r={R}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={arcDash(percent)}
          transform="rotate(-90 7 7)"
        />
      ) : null}
    </svg>
  )
}

export function QuotaRing(): ReactElement | null {
  const t = useT()
  const provider = useStore((s) => s.session?.model?.provider ?? '')
  const running = useStore((s) => !!s.session?.isAgentRunning)
  const entry = useLiveQuota((s) => s.entries[provider])
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasRunning = useRef(running)
  const supported = liveQuotaSupported(provider)

  useEffect(() => {
    setOpen(false)
    void refreshFor(provider).then(() => setNow(Date.now()))
  }, [provider])

  useEffect(() => {
    if (wasRunning.current && !running) void refreshFor(provider).then(() => setNow(Date.now()))
    wasRunning.current = running
  }, [running, provider])

  useEffect(() => {
    if (!supported) return
    const timer = setInterval(() => {
      setNow(Date.now())
      const fetchedAt = useLiveQuota.getState().entries[provider]?.fetchedAt ?? 0
      if (document.visibilityState === 'visible' && Date.now() - fetchedAt >= LIVE_QUOTA_POLL_MS) void refreshFor(provider)
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [provider, supported])

  const snapshot = entry?.snapshot
  const windows = snapshot?.windows ?? []
  const binding = bindingQuotaWindow(windows.filter((w) => !windowAwaitingReset(w, now))) ?? bindingQuotaWindow(windows)
  if (!supported || !snapshot || !binding) return null

  const stale = quotaReadingStale(snapshot.checkedAt, now, !!snapshot.staleError)
  const awaiting = windowAwaitingReset(binding, now)
  const pct = windowUsedPct(binding) ?? 0
  const tone = quotaWindowTone(binding, stale, now)
  const projected = stale || awaiting ? null : forecastProjectionPct(binding.forecast)
  const ago = quotaReadAgo(t, snapshot.checkedAt, now)
  const title = stale
    ? t('quota.ring.staleTip', { win: binding.label, pct: Math.round(pct), ago })
    : t('quota.ring.tip', { win: binding.label, pct: Math.round(pct) })

  const openPopover = (): void => {
    const next = !open
    setOpen(next)
    if (next) void refreshFor(provider).then(() => setNow(Date.now()))
  }

  const openAllAccounts = (): void => {
    setOpen(false)
    const ui = useUiV3.getState()
    ui.setWorkspaceTab('quota')
    ui.setWorkspaceOpen(true)
  }

  return (
    <div className="quota-ring-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="ctx-ring quota-ring"
        data-tone={tone}
        data-testid="quota-ring"
        aria-label={t('quota.ring.label')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={openPopover}
      >
        <QuotaArc
          percent={awaiting ? null : pct}
          projected={projected}
          tone={tone}
          exhaust={!stale && !awaiting && binding.forecast?.kind === 'exhaust'}
        />
        <span className="quota-ring-text ui-meta-num" data-testid="quota-ring-text">
          {`${quotaShortLabel(t, binding)} ${awaiting ? '—' : `${Math.round(pct)}%`}`}
        </span>
      </button>
      <Popover className="qr-pop" isOpen={open} onOpenChange={setOpen} triggerRef={triggerRef} placement="top start" offset={8}>
        <Dialog className="qr-dialog" aria-label={t('quota.ring.title')} data-testid="quota-ring-details">
          <div className="qr-head">
            <span className="qr-title">{t('quota.ring.title')}</span>
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={t('quota.refresh')}
              isDisabled={!!entry?.loading}
              onPress={() => void refreshFor(provider, true).then(() => setNow(Date.now()))}
              data-testid="quota-ring-refresh"
            >
              {entry?.loading ? <Spinner size={12} /> : <RefreshCw size={14} />}
            </IconButton>
          </div>
          <p className="qr-read" data-stale={stale ? '1' : undefined} title={stale ? t('quota.staleTip') : undefined} data-testid="quota-ring-read">
            {[ago, snapshot.staleError ? t('quota.readFailed', { msg: snapshot.staleError }) : ''].filter(Boolean).join(' · ')}
          </p>
          <div className="qr-wins">
            {windows.map((window) => (
              <QuotaWindowRow key={window.id} window={window} stale={stale} now={now} testId={`quota-ring-win-${window.id}`} />
            ))}
          </div>
          <div className="qr-actions">
            <Button size="sm" variant="secondary" onPress={openAllAccounts} data-testid="quota-ring-all">
              {t('quota.ring.all')}
            </Button>
          </div>
        </Dialog>
      </Popover>
    </div>
  )
}
