import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { formatCountdown, UI_TIMEOUT_EXTEND } from '../../../../shared/ui-timeout'
import type { ExtensionUiRequest } from '../../../../shared/ipc'
import type { QuestionField } from '../../../../shared/question-form'
import { Badge, Button, IconButton, TextArea, TextField } from '../../ui'
import { Icon } from './Icon'
import { QuestionForm } from './QuestionForm'
import { approvalSlotClaimed, useApprovalSlotVersion, useClaimApprovalSlot } from './approval-slot'

const INTERACTIVE = new Set(['select', 'confirm', 'input', 'editor'])

export function QuestionCard({ requestId }: { requestId?: string } = {}): JSX.Element | null {
  const requests = useStore((s) => s.uiRequests)
  useApprovalSlotVersion()
  useClaimApprovalSlot(requestId && requests.some((r) => r.id === requestId) ? requestId : null)
  const collapsed = useStore((s) => s.uiCollapsed)
  const setCollapsed = useStore((s) => s.setUiCollapsed)
  const [index, setIndex] = useState(0)
  const firstSeen = useRef(new Map<string, number>())

  const list = requestId ? requests.filter((r) => r.id === requestId) : requests.filter((r) => !approvalSlotClaimed(r.id))
  const ids = list.map((r) => r.id).join('|')

  useEffect(() => {
    const alive = new Set(ids ? ids.split('|') : [])
    for (const id of firstSeen.current.keys()) {
      if (!alive.has(id)) firstSeen.current.delete(id)
    }
    setIndex((prev) => Math.min(prev, Math.max(0, alive.size - 1)))
  }, [ids])

  if (!list.length) return null
  const current = Math.min(index, list.length - 1)
  const req = list[current]
  let start = firstSeen.current.get(req.id)
  if (start === undefined) {
    start = Date.now()
    firstSeen.current.set(req.id, start)
  }

  return (
    <PanelBody
      key={req.id}
      req={req}
      fallbackStart={start}
      collapsed={collapsed}
      setCollapsed={setCollapsed}
      page={{ index: current, total: list.length }}
      onPrev={() => setIndex(Math.max(0, current - 1))}
      onNext={() => setIndex(Math.min(list.length - 1, current + 1))}
    />
  )
}

function PanelBody({ req, fallbackStart, collapsed, setCollapsed, page, onPrev, onNext }: {
  req: ExtensionUiRequest
  fallbackStart: number
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  page: { index: number; total: number }
  onPrev: () => void
  onNext: () => void
}): JSX.Element | null {
  const t = useT()
  const reqId = req.id
  const draft = useStore((s) => s.uiDrafts[reqId] ?? '')
  const setUiDraft = useStore((s) => s.setUiDraft)
  const answerUi = useStore((s) => s.answerUi)
  const dismissRequest = useStore((s) => s.dismissRequest)
  const extendUi = useStore((s) => s.extendUi)
  const startUiTimer = useStore((s) => s.startUiTimer)

  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const answered = useRef(false)
  const composing = useRef(false)
  const [expired, setExpired] = useState(false)
  const [bump, setBump] = useState(0)

  const deadline = req.deadline === undefined ? (req.timeout ? fallbackStart + req.timeout : 0) : req.deadline
  const [remaining, setRemaining] = useState(() => (deadline ? Math.max(0, deadline - Date.now()) : 0))

  useEffect(() => {
    if (req.deadline !== 0) return
    void startUiTimer(reqId)
  }, [reqId, req.deadline, startUiTimer])

  useEffect(() => {
    if (!deadline) return undefined
    const tick = (): void => {
      const left = deadline - Date.now()
      setRemaining(Math.max(0, left))
      if (left <= 0) {
        setExpired(true)
        dismissRequest(reqId)
      }
    }
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [deadline, reqId, dismissRequest])

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const target = card.querySelector<HTMLElement>('.v3-qoption-row, .v3-qoption, input, textarea, select') ?? card
    target.focus({ preventScroll: true })
  }, [])

  if (expired) return null

  const extend = (): void => {
    void extendUi(reqId, UI_TIMEOUT_EXTEND).then((ok) => {
      if (!ok) { setExpired(true); return }
      setBump((n) => n + 1)
    })
  }

  const answer = (res: { value?: string; confirmed?: boolean; cancelled?: boolean }): void => {
    if (answered.current) return
    answered.current = true
    setBusy(true)
    answerUi({ id: reqId, ...res })
  }

  const title = req.title
    ?? (req.form?.length ? t('qf.title') : req.method === 'select' ? t('q.select') : req.method === 'confirm' ? t('q.confirm') : req.method === 'editor' ? t('q.editor') : t('q.input'))

  const text = draft || req.prefill || ''
  const trimmed = text.trim()
  const canSubmit = req.method === 'select' ? trimmed.length > 0 : req.method === 'input' || req.method === 'editor' ? trimmed.length > 0 : false
  const known = INTERACTIVE.has(req.method) || !!req.form?.length

  const onSubmitKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter') return
    if (composing.current || e.nativeEvent.isComposing) return
    if (canSubmit) answer({ value: trimmed })
  }

  return (
    <div className={`v3-qcard ${collapsed ? 'collapsed' : ''}`} data-testid="v3-question" data-sensitive={req.sensitive === true || undefined} role="alertdialog" aria-labelledby={titleId} tabIndex={-1} ref={cardRef}>
      <div className="v3-qhead">
        <Badge tone="accent" data-purpose={req.purpose} data-testid="v3-question-badge">
          <Icon name={req.purpose === 'approval' ? 'shield' : req.method === 'confirm' ? 'alert' : 'message'} size={12} />
          {req.purpose === 'approval' ? t('chat.approvalTag') : t('chat.questionTag')}
        </Badge>
        <span className="v3-qtitle" id={titleId}>{title}</span>
        {req.sensitive === true ? <Badge tone="ask">!</Badge> : null}
        <span className="v3-code-sp" />
        {deadline ? (
          <span className="v3-qtimer-wrap">
            {bump > 0 ? <span className="v3-qbump" key={bump} role="status">{t('q.extendBump')}</span> : null}
            <button
              type="button"
              className={`v3-qtimer ${remaining <= 30_000 ? 'low' : ''}`}
              data-testid="v3-question-timer"
              data-remaining={Math.ceil(remaining / 1000)}
              title={t('q.extendHint')}
              aria-label={t('q.timeLeft', { time: formatCountdown(remaining) })}
              onClick={extend}
            >
              <Icon name="clock" size={12} />
              {formatCountdown(remaining)}
            </button>
          </span>
        ) : null}
        {page.total > 1 ? (
          <span className="v3-qpage" data-testid="v3-question-page">
            <IconButton size="sm" aria-label={t('q.prev')} isDisabled={page.index === 0} onPress={onPrev} data-testid="v3-question-prev"><Icon name="chevron-left" size={14} /></IconButton>
            <span className="v3-qpage-n">{t('q.page', { i: page.index + 1, n: page.total })}</span>
            <IconButton size="sm" aria-label={t('q.nextPage')} isDisabled={page.index >= page.total - 1} onPress={onNext} data-testid="v3-question-next"><Icon name="chevron-right" size={14} /></IconButton>
          </span>
        ) : null}
        <IconButton
          size="sm"
          aria-label={collapsed ? t('q.expand') : t('q.collapse')}
          onPress={() => setCollapsed(!collapsed)}
          data-testid="v3-question-toggle"
        >
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} size={14} />
        </IconButton>
      </div>

      {collapsed ? (
        <div className="v3-qmini">{t('q.collapsed', { n: page.total })}</div>
      ) : (
        <div className="v3-qbody" data-testid="v3-question-body">
          {req.message ? <div className="v3-qmsg">{req.message}</div> : null}

          {req.form?.length ? (
            <QuestionForm
              fields={req.form as QuestionField[]}
              busy={busy}
              submitLabel={page.total > 1 ? t('q.next') : t('q.submit')}
              onSubmit={(json) => answer({ value: json })}
              onSkip={() => answer({ cancelled: true })}
            />
          ) : null}

          {!req.form?.length && (req.method === 'select' || req.method === 'input') && req.options?.length ? (
            <div className="v3-qoptions-list">
              {req.options.map((o, i) => (
                <button key={`${i}:${o}`} className="v3-qoption-row" disabled={busy} onClick={() => answer({ value: o })} data-testid={`v3-question-option-${i}`}>
                  <span className="v3-qoption-n" aria-hidden>{i + 1}</span>
                  <span className="v3-qoption-t">{o}</span>
                  <Icon name="chevron-right" size={13} className="v3-chev" />
                </button>
              ))}
            </div>
          ) : null}

          {!req.form?.length && (req.method === 'select' || req.method === 'input') ? (
            <TextField
              data-testid={req.method === 'select' ? 'v3-question-custom' : 'v3-question-input'}
              aria-label={req.placeholder || (req.method === 'select' ? t('q.customReply') : title)}
              placeholder={req.placeholder ?? (req.method === 'select' ? t('q.customReply') : '')}
              value={text}
              onChange={(value) => setUiDraft(reqId, value)}
              onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }}
              onKeyDown={onSubmitKey}
            />
          ) : null}

          {req.method === 'editor' ? (
            <TextArea
              data-testid="v3-question-editor"
              aria-label={title}
              rows={6}
              value={text}
              onChange={(value) => setUiDraft(reqId, value)}
              onCompositionStart={() => { composing.current = true }}
              onCompositionEnd={() => { composing.current = false }}
            />
          ) : null}

          {!known ? <div className="v3-qmsg" data-testid="v3-question-unknown">{t('q.input')}</div> : null}

          {req.form?.length ? null : (
            <div className="v3-qfoot">
              <Button isDisabled={busy} onPress={() => answer({ cancelled: true })} data-testid="v3-question-skip">{t('q.skip')}</Button>
              <span className="v3-code-sp" />
              {req.method === 'confirm' ? (
                <>
                  <Button isDisabled={busy} onPress={() => answer({ confirmed: false })}>{t('ui.no')}</Button>
                  <Button variant="primary" isDisabled={busy} onPress={() => answer({ confirmed: true })} data-testid="v3-question-submit">{t('ui.yes')}</Button>
                </>
              ) : null}
              {req.method === 'input' || req.method === 'editor' || req.method === 'select' ? (
                <Button variant="primary" isDisabled={busy || !canSubmit} onPress={() => answer({ value: trimmed })} data-testid="v3-question-submit">
                  {page.total > 1 ? t('q.next') : t('q.submit')}
                </Button>
              ) : null}
              {!known ? <Button isDisabled={busy} onPress={() => answer({ cancelled: true })} data-testid="v3-question-dismiss">{t('q.skip')}</Button> : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
