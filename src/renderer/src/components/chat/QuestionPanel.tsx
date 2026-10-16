import { useEffect, useRef, useState } from 'react'
import { formatCountdown, UI_TIMEOUT_EXTEND } from '../../../../shared/ui-timeout'
import type { ExtensionUiRequest } from '../../../../shared/ipc'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { PixelDigits } from './PixelDigits'
import { Button, IconButton } from '../ui'
import { QuestionForm } from './QuestionForm'

export function QuestionPanel() {
  const requests = useStore((s) => s.uiRequests)
  const collapsed = useStore((s) => s.uiCollapsed)
  const setCollapsed = useStore((s) => s.setUiCollapsed)
  const [index, setIndex] = useState(0)
  const firstSeen = useRef(new Map<string, number>())

  const list = requests.filter((r) => r.sensitive !== true)
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

function PanelBody({
  req,
  fallbackStart,
  collapsed,
  setCollapsed,
  page,
  onPrev,
  onNext
}: {
  req: ExtensionUiRequest
  fallbackStart: number
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  page: { index: number; total: number }
  onPrev: () => void
  onNext: () => void
}) {
  const t = useT()
  const reqId = req.id
  const draft = useStore((s) => s.uiDrafts[reqId] ?? '')
  const setUiDraft = useStore((s) => s.setUiDraft)
  const answerUi = useStore((s) => s.answerUi)
  const dismissRequest = useStore((s) => s.dismissRequest)
  const extendUi = useStore((s) => s.extendUi)
  const startUiTimer = useStore((s) => s.startUiTimer)

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
    if (!deadline) return
    const tick = (): void => {
      const left = deadline - Date.now()
      setRemaining(Math.max(0, left))
      if (left <= 0) {
        setExpired(true)
        dismissRequest(reqId)
      }
    }
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [deadline, reqId, dismissRequest])

  if (expired) return null

  const extend = (): void => {
    void extendUi(reqId, UI_TIMEOUT_EXTEND).then((ok) => {
      if (!ok) {
        setExpired(true)
        return
      }
      setBump((n) => n + 1)
    })
  }

  const answer = (res: { value?: string; confirmed?: boolean; cancelled?: boolean }): void => {
    if (answered.current) return
    answered.current = true
    setBusy(true)
    answerUi({ id: reqId, ...res })
  }

  const title = req.form?.length
    ? t('qf.title')
    : req.method === 'select'
      ? t('q.select')
      : req.method === 'confirm'
        ? t('q.confirm')
        : req.method === 'editor'
          ? t('q.editor')
          : t('q.input')

  const text = draft || req.prefill || ''
  const trimmed = text.trim()
  const canSubmit =
    req.method === 'select' ? trimmed.length > 0 : req.method === 'input' || req.method === 'editor' ? trimmed.length > 0 : false

  return (
    <div
      className={`qpanel ${collapsed ? 'collapsed' : ''}`}
      data-testid="question-panel"
      role="group"
      aria-label={req.title ?? title}
    >
      <div className="qpanel-head">
        <span className="qpanel-badge" data-testid="question-panel-badge" data-purpose={req.purpose}>
          <Icon name={req.purpose === 'approval' ? 'shield-check' : req.method === 'confirm' ? 'alert-circle' : 'message-dots'} size={12} />
          {req.purpose === 'approval' ? t('chat.approvalTag') : t('chat.questionTag')}
        </span>
        <span className="qpanel-title">{req.title ?? title}</span>
        <span className="spacer" />
        {deadline ? (
          <span className="qpanel-timer-wrap">
            {bump > 0 ? (
              <span className="qpanel-bump" key={bump} role="status">
                {t('q.extendBump')}
              </span>
            ) : null}
            <button
              type="button"
              className={`qpanel-timer ${remaining <= 30_000 ? 'low' : ''}`}
              data-testid="question-panel-timer"
              data-remaining={Math.ceil(remaining / 1000)}
              title={t('q.extendHint')}
              aria-label={t('q.timeLeft', { time: formatCountdown(remaining) })}
              onClick={extend}
            >
              <PixelDigits text={formatCountdown(remaining)} />
            </button>
          </span>
        ) : null}
        {page.total > 1 ? (
          <span className="qpanel-page" data-testid="question-panel-page">
            <IconButton icon="chevron-right" label={t('q.prev')} size="sm" className="qpanel-prev" type="button" disabled={page.index === 0} data-testid="question-panel-prev" onClick={onPrev} />
            <span className="qpanel-page-n" data-index={page.index + 1} data-total={page.total}>
              {t('q.page', { i: page.index + 1, n: page.total })}
            </span>
            <IconButton icon="chevron-right" label={t('q.nextPage')} size="sm" type="button" disabled={page.index >= page.total - 1} data-testid="question-panel-next" onClick={onNext} />
          </span>
        ) : null}
        <button
          className="qpanel-toggle"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          title={collapsed ? t('q.expand') : t('q.collapse')}
          data-testid="question-panel-toggle"
        >
          <Icon name="chevron-right" size={12} className={`chev ${collapsed ? '' : 'on'}`} />
        </button>
      </div>

      {collapsed ? (
        <div className="qpanel-mini">{t('q.collapsed', { n: page.total })}</div>
      ) : (
        <div className="qpanel-body" data-testid="question-panel-body">
          {req.message ? <div className="qpanel-msg">{req.message}</div> : null}

          {req.form?.length ? (
            <QuestionForm fields={req.form} busy={busy} submitLabel={page.total > 1 ? t('q.next') : t('q.submit')}
              onSubmit={(json) => answer({ value: json })} onSkip={() => answer({ cancelled: true })} />
          ) : null}

          {!req.form?.length && (req.method === 'select' || req.method === 'input') && req.options?.length ? (
            <div className="qpanel-options">
              {req.options?.map((o, index) => (
                <button
                  key={`${index}:${o}`}
                  className="qpanel-option"
                  disabled={busy}
                  onClick={() => answer({ value: o })}
                  data-testid={`question-panel-option-${index}`}
                >
                  <span className="qpanel-option-n" aria-hidden="true">{index + 1}</span>
                  <span className="qpanel-option-t">{o}</span>
                  <Icon name="chevron-right" size={12} className="qpanel-option-go" />
                </button>
              ))}
            </div>
          ) : null}

          {!req.form?.length && req.method === 'select' ? (
            <input
              className="qpanel-input"
              data-testid="question-panel-custom"
              placeholder={req.placeholder ?? t('q.customReply')}
              value={text}
              onChange={(e) => setUiDraft(reqId, e.target.value)}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (composing.current || e.nativeEvent.isComposing) return
                if (canSubmit) answer({ value: trimmed })
              }}
            />
          ) : null}

          {!req.form?.length && req.method === 'input' ? (
            <input
              className="qpanel-input"
              data-testid="question-panel-input"
              value={text}
              placeholder={req.placeholder ?? ''}
              onChange={(e) => setUiDraft(reqId, e.target.value)}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (composing.current || e.nativeEvent.isComposing) return
                if (canSubmit) answer({ value: trimmed })
              }}
            />
          ) : null}

          {req.method === 'editor' ? (
            <textarea
              className="qpanel-editor"
              data-testid="question-panel-editor"
              value={text}
              onChange={(e) => setUiDraft(reqId, e.target.value)}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
            />
          ) : null}

          {req.form?.length ? null : <div className="qpanel-foot">
            <Button disabled={busy} onClick={() => answer({ cancelled: true })} data-testid="question-panel-skip">
              {t('q.skip')}
            </Button>
            <span className="spacer" />

            {req.method === 'confirm' ? (
              <>
                <Button disabled={busy} onClick={() => answer({ confirmed: false })}>
                  {t('ui.no')}
                </Button>
                <Button variant="primary" disabled={busy} onClick={() => answer({ confirmed: true })} data-testid="question-panel-submit">
                  {t('ui.yes')}
                </Button>
              </>
            ) : null}

            {req.method === 'input' || req.method === 'editor' || req.method === 'select' ? (
              <Button variant="primary" disabled={busy || !canSubmit} onClick={() => answer({ value: trimmed })} data-testid="question-panel-submit">
                {page.total > 1 ? t('q.next') : t('q.submit')}
              </Button>
            ) : null}
          </div>}
        </div>
      )}
    </div>
  )
}
