import { useEffect, useState, type JSX } from 'react'
import { useStore } from '../../state/store'
import { refreshLiveQuota, useLiveQuota } from '../../state/live-quota'
import { blockedQuotaWindows } from '../../../../shared/quota-resume'
import { viewMatchesProjectedSession, sessionViewIdentity } from './view-state'
import { Button, IconButton } from '../../ui'
import { Card, CardActions, CardBody, CardChevron, CardControl, CardHead, CardStatus, CardSummary, CardTitle } from '../../ui/Card'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { forgetToolExpansion } from './tool-expansion'
import { errorCardModel, errorTitleKey, promptForTurn, type ErrorCardAction } from './turn-lines'
import './error-card.css'

const PRIMARY_ACTIONS: ReadonlySet<ErrorCardAction> = new Set<ErrorCardAction>(['retry', 'wait'])

export function ErrorCard({ sourceIds, error, readOnly = false, recovered = false }: { sourceIds: readonly string[]; error: string; readOnly?: boolean; recovered?: boolean }): JSX.Element | null {
  const tt = useSessionText()
  const send = useStore((s) => s.send)
  const cycleModel = useStore((s) => s.cycleModel)
  const compact = useStore((s) => s.compact)
  const hasPrompt = useStore((s) => promptForTurn(sourceIds, s.messages) !== null)
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const armQuotaResume = useStore((s) => s.armQuotaResume)
  const quotaResume = useStore((s) => s.quotaResume)
  const provider = session?.model?.provider
  const liveQuota = useLiveQuota((s) => (provider ? s.entries[provider]?.snapshot : undefined))
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const parsed = errorCardModel(error)
  const rateLimited = parsed?.kind === 'quota' && parsed.quotaScope === 'rate' && !readOnly && !recovered
  useEffect(() => {
    if (rateLimited && provider) void refreshLiveQuota(provider, { force: true })
  }, [rateLimited, provider])
  if (!parsed) return null
  const windowFull = parsed.kind === 'quota' && parsed.quotaScope === 'rate' && !!liveQuota?.windows?.length && !liveQuota.staleError && blockedQuotaWindows(liveQuota.windows).length > 0
  const model = windowFull ? { ...parsed, quotaScope: 'usage' as const, actions: ['wait', 'model'] as ErrorCardAction[] } : parsed

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const active = viewMatchesProjectedSession(view, session)
  const actions = active && !readOnly && !recovered
    ? model.actions.filter((action) => (action !== 'retry' || hasPrompt) && (action !== 'wait' || !quotaResume))
    : []

  const run = (action: ErrorCardAction): void => {
    if (action === 'retry') {
      const prompt = promptForTurn(sourceIds, useStore.getState().messages)
      if (!prompt) return
      forgetToolExpansion(view.key)
      void send(prompt.text, prompt.images.length ? prompt.images : undefined)
      return
    }
    if (action === 'model') {
      void cycleModel()
      return
    }
    if (action === 'wait') {
      void armQuotaResume()
      return
    }
    void compact()
  }

  const copy = (): void => {
    void navigator.clipboard.writeText(model.body).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      },
      () => undefined
    )
  }

  const LABEL: Record<ErrorCardAction, string> = {
    retry: tt('errorRetry'),
    model: tt('errorModel'),
    compact: tt('errorCompact'),
    wait: tt('errorWaitQuota')
  }

  const title = tt(errorTitleKey(model))
  const toggle = (): void => setDetailsOpen((open) => !open)
  const details = detailsOpen ? (
    <CardBody className="v3-errorcard-details" data-testid="v3-error-body">
      {windowFull ? <p className="v3-errorcard-body">{tt('errorQuotaWindowFull')}</p> : null}
      <p className="v3-errorcard-body">{model.body}</p>
      <div className="v3-errorcard-detail-foot">
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name={copied ? 'check' : 'copy'} size={14} />}
          data-testid="v3-error-copy"
          onPress={copy}
        >
          {copied ? tt('msgCopied') : tt('errCopyDetails')}
        </Button>
        <span className="v3-errorcard-status" role="status" aria-live="polite">
          {copied ? tt('msgCopied') : ''}
        </span>
      </div>
    </CardBody>
  ) : null

  if (recovered) {
    return (
      <Card receipt padding="none" className="v3-errorcard" role="status" data-testid="v3-error-card" data-kind={model.kind} data-recovered>
        <CardSummary expanded={detailsOpen} onPress={toggle} title={tt('errViewDetails')} data-testid="v3-error-toggle">
          <CardStatus tone="muted" icon={<Icon name="refresh" size={14} />}>{tt('errRecoveredStatus')}</CardStatus>
          <CardTitle clamp data-testid="v3-error-title">{title}</CardTitle>
        </CardSummary>
        {details}
      </Card>
    )
  }

  const ordered = [...actions.filter((action) => !PRIMARY_ACTIONS.has(action)), ...actions.filter((action) => PRIMARY_ACTIONS.has(action))]
  return (
    <Card tone="fail" padding="md" className="v3-errorcard" role="alert" data-testid="v3-error-card" data-kind={model.kind}>
      <CardHead>
        <CardStatus tone="fail" icon={<Icon name="warn" size={14} />}>{tt('errStatus')}</CardStatus>
        <CardTitle data-testid="v3-error-title">{title}</CardTitle>
        <CardControl>
          <IconButton size="sm" aria-label={tt('errViewDetails')} aria-expanded={detailsOpen} onPress={toggle} data-testid="v3-error-toggle">
            <CardChevron />
          </IconButton>
        </CardControl>
      </CardHead>
      {details}
      {ordered.length ? (
        <CardActions className="v3-errorcard-actions">
          {ordered.map((action) => (
            <Button
              key={action}
              variant={PRIMARY_ACTIONS.has(action) ? 'primary' : 'ghost'}
              data-testid={`v3-error-${action}`}
              onPress={() => run(action)}
            >
              {LABEL[action]}
            </Button>
          ))}
        </CardActions>
      ) : null}
    </Card>
  )
}
