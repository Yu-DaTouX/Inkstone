import { useEffect, useState, type ReactElement } from 'react'
import { Hourglass } from 'lucide-react'
import { Button } from '../../ui'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import './composer.css'

const MINUTE_MS = 60_000

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function QuotaResumeBar(): ReactElement | null {
  const t = useT()
  const wait = useStore((s) => s.quotaResume)
  const sessionId = useStore((s) => s.peekedSessionId ?? s.session?.sessionId ?? null)
  const cancel = useStore((s) => s.cancelQuotaResume)
  const visible = !!wait && wait.sessionId === sessionId
  const now = useMinuteClock(visible)
  if (!visible || !wait) return null

  const minutesLeft = wait.resetAt ? Math.max(0, Math.ceil((wait.resetAt - now) / MINUTE_MS)) : null
  const left = minutesLeft === null
    ? null
    : minutesLeft >= 60
      ? t('quota.resume.leftHM', { h: Math.floor(minutesLeft / 60), m: minutesLeft % 60 })
      : t('quota.resume.leftM', { m: minutesLeft })
  const eta = wait.resetAt && left ? t('quota.resume.eta', { time: clockTime(wait.resetAt), left }) : t('quota.resume.etaUnknown')

  return (
    <div className="quota-wait" role="status" data-testid="quota-resume-bar">
      <Hourglass className="quota-wait-icon" size={18} aria-hidden />
      <div className="quota-wait-body">
        <span className="quota-wait-title">{t('quota.resume.title')}</span>
        <span className="quota-wait-eta">{eta}</span>
        <span className="quota-wait-hint">{t('quota.resume.hint')}</span>
      </div>
      <Button variant="secondary" size="sm" className="quota-wait-cancel" data-testid="quota-resume-cancel" onPress={cancel}>
        {t('quota.resume.cancelAuto')}
      </Button>
    </div>
  )
}
