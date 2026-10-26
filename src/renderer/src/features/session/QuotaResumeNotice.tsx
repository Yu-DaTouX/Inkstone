import { useEffect, useState, type JSX } from 'react'
import { QUOTA_RESUME_PROMPT } from '../../../../shared/quota-resume'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button } from '../../ui'
import { Card, CardActions, CardBody, CardHead, CardStatus, CardTitle } from '../../ui/Card'
import { Icon } from './Icon'
import './wrap-up.css'

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

export function QuotaResumeNotice({ sessionId }: { sessionId: string | null | undefined }): JSX.Element | null {
  const t = useT()
  const wait = useStore((s) => s.quotaResume)
  const cancel = useStore((s) => s.cancelQuotaResume)
  const visible = !!wait && !!sessionId && wait.sessionId === sessionId
  const now = useMinuteClock(visible)
  if (!visible || !wait) return null

  const minutesLeft = wait.resetAt ? Math.max(0, Math.ceil((wait.resetAt - now) / MINUTE_MS)) : null
  const left = minutesLeft === null
    ? null
    : minutesLeft >= 60
      ? t('quota.resume.leftHM', { h: Math.floor(minutesLeft / 60), m: minutesLeft % 60 })
      : t('quota.resume.leftM', { m: minutesLeft })
  const eta = wait.resetAt && left ? t('quota.resume.eta', { time: clockTime(wait.resetAt), left }) : t('quota.resume.etaUnknown')
  const resumeNow = (): void => {
    cancel()
    void useStore.getState().send(QUOTA_RESUME_PROMPT)
  }

  return (
    <Card as="section" padding="md" className="v3-wrapup" data-pending="" aria-label={t('quota.resume.kicker')} data-testid="quota-resume-bar">
      <CardHead>
        <CardStatus tone="run" icon={<Icon name="clock" size={14} />}>{t('quota.resume.kicker')}</CardStatus>
        <CardTitle>{t('quota.resume.title')}</CardTitle>
      </CardHead>
      <CardBody className="v3-wrapup-body">
        <p className="v3-wrapup-recap" role="status" aria-live="polite">{eta}</p>
        <p className="v3-wrapup-recap">{t('quota.resume.hint')}</p>
      </CardBody>
      <CardActions
        className="v3-wrapup-actions"
        lead={
          <Button variant="secondary" onPress={cancel} data-testid="quota-resume-cancel">
            {t('quota.resume.cancelAuto')}
          </Button>
        }
      >
        <Button variant="secondary" onPress={resumeNow} data-testid="quota-resume-now">
          {t('quota.resume.now')}
        </Button>
      </CardActions>
    </Card>
  )
}
