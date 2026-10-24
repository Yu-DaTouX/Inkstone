import { useEffect, useState, type JSX } from 'react'
import { useStore } from '../../state/store'
import { refreshLiveQuota, useLiveQuota } from '../../state/live-quota'
import { blockedQuotaWindows } from '../../../../shared/quota-resume'
import { viewMatchesProjectedSession, sessionViewIdentity } from './view-state'
import { Button } from '../../ui'
import { Icon } from './Icon'
import { useSessionText } from './text'
import { forgetToolExpansion } from './tool-expansion'
import { errorCardModel, errorTitleKey, promptForTurn, type ErrorCardAction } from './turn-lines'

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

  return (
    <div className="v3-errorcard" role={recovered ? 'status' : 'alert'} data-testid="v3-error-card" data-kind={model.kind} data-recovered={recovered || undefined}>
      <div className="v3-errorcard-head">
        <Icon name="warn" size={14} />
        <span className="v3-errorcard-title" data-testid="v3-error-title">{recovered ? tt('errRecovered', { title: tt(errorTitleKey(model)) }) : tt(errorTitleKey(model))}</span>
        <span className="v3-code-sp" />
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={detailsOpen}
          data-testid="v3-error-toggle"
          trailingIcon={<Icon name={detailsOpen ? 'chevron-down' : 'chevron-right'} size={14} />}
          onPress={() => setDetailsOpen((open) => !open)}
        >
          {tt('errViewDetails')}
        </Button>
      </div>
      {detailsOpen ? (
        <div className="v3-errorcard-details" data-testid="v3-error-body">
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
        </div>
      ) : null}
      {actions.length ? (
        <div className="v3-errorcard-actions">
          {actions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === 'retry' || action === 'wait' ? 'primary' : 'ghost'}
              data-testid={`v3-error-${action}`}
              onPress={() => run(action)}
            >
              {LABEL[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
