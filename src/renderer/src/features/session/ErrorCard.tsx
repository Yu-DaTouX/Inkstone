import { useEffect, useState, type JSX } from 'react'
import { useI18n } from '../../i18n'
import { pushNotice, useStore } from '../../state/store'
import { refreshLiveQuota, useLiveQuota } from '../../state/live-quota'
import { blockedQuotaWindows } from '../../../../shared/quota-resume'
import { EMPTY_MODEL_ERROR_NOTICE, modelErrorCause, modelErrorResetTime, type ModelErrorCause } from '../../../../shared/model-errors'
import { viewMatchesProjectedSession, sessionViewIdentity } from './view-state'
import { Button } from '../../ui'
import { Card, CardActions, CardBody, CardCode, CardHead, CardStatus, CardSummary, CardTitle } from '../../ui/Card'
import { Icon } from './Icon'
import { useSessionText, type SessionTextKey } from './text'
import { forgetToolExpansion, toolExpansionScopeOf } from './tool-expansion'
import { errorCardModel, errorTitleKey, promptForTurn, type ErrorCardAction } from './turn-lines'
import './error-card.css'

const PRIMARY_ACTIONS: ReadonlySet<ErrorCardAction> = new Set<ErrorCardAction>(['retry', 'wait'])

const RAW_MARK = '原因：'

const CAUSE_HINT: Record<ModelErrorCause, SessionTextKey> = {
  empty: 'errHintEmpty',
  refused: 'errHintRefused',
  quotaRate: 'errHintQuotaRate',
  quotaBalance: 'errHintQuotaBalance',
  quotaUsage: 'errHintQuotaUsage',
  auth: 'errHintAuth',
  context: 'errHintContext',
  aborted: 'errHintAborted',
  request: 'errHintRequest',
  restart: 'errHintRestart',
  stream: 'errHintStream',
  timeout: 'errHintTimeout',
  overload: 'errHintOverload',
  unreachable: 'errHintUnreachable',
  unknown: 'errHintUnknown'
}

function splitErrorBody(body: string): { explanation: string; raw: string } {
  if (body === EMPTY_MODEL_ERROR_NOTICE) return { explanation: body, raw: '' }
  const at = body.lastIndexOf(RAW_MARK)
  if (at < 0) return { explanation: '', raw: body }
  return { explanation: body.slice(0, at).trim(), raw: body.slice(at + RAW_MARK.length).trim() }
}

function errorHint(raw: string, tt: (key: SessionTextKey, vars?: Record<string, string | number>) => string): string {
  const cause = raw ? modelErrorCause(raw) : 'empty'
  const reset = cause === 'quotaUsage' ? modelErrorResetTime(raw) : ''
  return reset ? `${tt(CAUSE_HINT[cause])} · ${tt('errHintQuotaReset', { time: reset })}` : tt(CAUSE_HINT[cause])
}

function isLatestTurn(sourceIds: readonly string[], messages: readonly { id: string; role: string }[]): boolean {
  const lastId = sourceIds.at(-1)
  if (!lastId) return false
  const at = messages.findIndex((message) => message.id === lastId)
  if (at < 0) return false
  for (let i = at + 1; i < messages.length; i += 1) if (messages[i].role === 'user') return false
  return true
}

async function restoreImages(images: { data: string; mimeType: string; url?: string }[]): Promise<{ data: string; mimeType: string }[] | null> {
  const out: { data: string; mimeType: string }[] = []
  for (const image of images) {
    if (image.data) { out.push({ data: image.data, mimeType: image.mimeType }); continue }
    const read = image.url ? await window.yan.attachments.read(image.url).catch(() => null) : null
    if (!read?.ok || !read.data) return null
    out.push({ data: read.data, mimeType: read.mimeType ?? image.mimeType })
  }
  return out
}

export function ErrorCard({ sourceIds, error, readOnly = false, recovered = false }: { sourceIds: readonly string[]; error: string; readOnly?: boolean; recovered?: boolean }): JSX.Element | null {
  const tt = useSessionText()
  const zh = useI18n().lang !== 'en-US'
  const send = useStore((s) => s.send)
  const cycleModel = useStore((s) => s.cycleModel)
  const compact = useStore((s) => s.compact)
  const hasPrompt = useStore((s) => promptForTurn(sourceIds, s.messages) !== null)
  const latest = useStore((s) => isLatestTurn(sourceIds, s.messages))
  const running = useStore((s) => !!(s.session?.isAgentRunning || s.session?.isStreaming || s.session?.retry))
  const session = useStore((s) => s.session)
  const peekedSessionId = useStore((s) => s.peekedSessionId)
  const peekedPath = useStore((s) => s.peekedPath)
  const armQuotaResume = useStore((s) => s.armQuotaResume)
  const quotaResume = useStore((s) => s.quotaResume)
  const provider = session?.model?.provider
  const liveQuota = useLiveQuota((s) => (provider ? s.entries[provider]?.snapshot : undefined))
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const parsed = errorCardModel(error)
  const rateLimited = parsed?.kind === 'quota' && parsed.quotaScope === 'rate' && !readOnly && !recovered
  useEffect(() => {
    if (rateLimited && provider) void refreshLiveQuota(provider, { force: true })
  }, [rateLimited, provider])
  if (!parsed) return null
  if (!recovered && latest && running) return null
  const windowFull = parsed.kind === 'quota' && parsed.quotaScope === 'rate' && !!liveQuota?.windows?.length && !liveQuota.staleError && blockedQuotaWindows(liveQuota.windows).length > 0
  const model = windowFull ? { ...parsed, quotaScope: 'usage' as const, actions: ['wait', 'model'] as ErrorCardAction[] } : parsed

  const view = sessionViewIdentity({ peekedSessionId, peekedPath, session })
  const active = viewMatchesProjectedSession(view, session)
  const actions = active && latest && !readOnly && !recovered
    ? model.actions.filter((action) => (action !== 'retry' || hasPrompt) && (action !== 'wait' || !quotaResume))
    : []

  const run = (action: ErrorCardAction): void => {
    if (action === 'retry') {
      const prompt = promptForTurn(sourceIds, useStore.getState().messages)
      if (!prompt) return
      forgetToolExpansion(toolExpansionScopeOf(view.sessionId, view.sessionFile))
      void restoreImages(prompt.images).then((images) => {
        if (!images) {
          useStore.setState((s) => ({ notices: pushNotice(s.notices, 'error', zh ? '原图读取失败，已取消重试' : 'Could not read the original images; retry cancelled') }))
          return
        }
        return send(prompt.text, images.length ? images : undefined)
      })
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
  const bodyParts = splitErrorBody(model.body)
  const hint = windowFull ? tt('errorQuotaWindowFull') : errorHint(bodyParts.raw, tt)
  const hintTip = zh && bodyParts.explanation ? bodyParts.explanation : undefined
  const explanation = <p className="v3-errorcard-body" data-testid="v3-error-explanation" title={hintTip}>{hint}</p>
  const rawBlock = bodyParts.raw ? <CardCode tone="fail" className="v3-errorcard-raw" data-testid="v3-error-raw">{bodyParts.raw}</CardCode> : null
  const copyButton = (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="v3-errorcard-tool"
        icon={<Icon name={copied ? 'check' : 'copy'} size={14} />}
        data-testid="v3-error-copy"
        onPress={copy}
      >
        {copied ? tt('msgCopied') : tt('errCopyDetails')}
      </Button>
      <span className="v3-errorcard-status" role="status" aria-live="polite">
        {copied ? tt('msgCopied') : ''}
      </span>
    </>
  )

  const stopped = model.kind === 'aborted' && !recovered
  if (recovered || stopped) {
    return (
      <Card receipt padding="none" className="v3-errorcard" role="status" data-testid="v3-error-card" data-kind={model.kind} data-recovered={recovered || undefined} data-stopped={stopped || undefined}>
        <CardSummary expanded={detailsOpen} onPress={() => setDetailsOpen((open) => !open)} title={tt('errViewDetails')} data-testid="v3-error-toggle">
          <CardStatus tone="muted" icon={<Icon name={stopped ? 'stop' : 'refresh'} size={13} />}>{stopped ? tt('errStoppedStatus') : tt('errRecoveredStatus')}</CardStatus>
          {stopped ? null : <CardTitle clamp className="v3-errorcard-title" data-testid="v3-error-title">{title}</CardTitle>}
          {detailsOpen ? null : <span className="v3-errorcard-preview">{hint}</span>}
        </CardSummary>
        {detailsOpen ? (
          <CardBody className="v3-errorcard-details" data-testid="v3-error-body">
            {explanation}
            {rawBlock}
            <div className="v3-errorcard-tools">{copyButton}</div>
          </CardBody>
        ) : null}
      </Card>
    )
  }

  const ordered = [...actions.filter((action) => !PRIMARY_ACTIONS.has(action)), ...actions.filter((action) => PRIMARY_ACTIONS.has(action))]
  const tools = (
    <div className="v3-errorcard-tools">
      {bodyParts.raw ? (
        <Button
          size="sm"
          variant="ghost"
          className="v3-errorcard-tool"
          icon={<Icon name={rawOpen ? 'chevron-up' : 'chevron-down'} size={14} />}
          aria-expanded={rawOpen}
          data-testid="v3-error-raw-toggle"
          onPress={() => setRawOpen((open) => !open)}
        >
          {rawOpen ? tt('errRawHide') : tt('errRaw')}
        </Button>
      ) : null}
      {copyButton}
    </div>
  )
  return (
    <Card tone="fail" padding="md" className="v3-errorcard" role="alert" data-testid="v3-error-card" data-kind={model.kind}>
      <CardHead>
        <CardStatus tone="fail" icon={<Icon name="warn" size={14} />}>{tt('errStatus')}</CardStatus>
        <CardTitle data-testid="v3-error-title">{title}</CardTitle>
      </CardHead>
      <CardBody className="v3-errorcard-details" data-testid="v3-error-body">
        {explanation}
        {rawOpen ? rawBlock : null}
      </CardBody>
      <CardActions className="v3-errorcard-actions" lead={tools}>
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
    </Card>
  )
}
