import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { prefersReducedMotion, usePresence } from '../../lib/usePresence'
import { useFocusTrap, useModalLayer } from '../../lib/modalLayer'
import type { ExtensionUiRequest } from '../../../../shared/ipc'
import { Button, IconButton } from '../ui'
import { GitInstallControl } from '../settings/GitInstallControl'
import { createPerIdTimers, optionKey } from './notice-timers'

const EXIT_MS = 110

export function UiDialog() {
  const requests = useStore((s) => s.uiRequests)
  const req = requests.find((r) => r.sensitive === true)

  const lastReq = useRef<ExtensionUiRequest | undefined>(undefined)
  if (req) lastReq.current = req
  const shown = req ?? lastReq.current
  const { mounted, closing } = usePresence(!!req, prefersReducedMotion() ? 1 : EXIT_MS)

  if (!mounted || !shown) return null
  return <DialogBody key={shown.id} req={shown} closing={closing} />
}

function DialogBody({ req, closing }: { req: ExtensionUiRequest; closing?: boolean }) {
  const t = useT()
  const answerUi = useStore((s) => s.answerUi)
  const dismissRequest = useStore((s) => s.dismissRequest)

  const [value, setValue] = useState(req.prefill ?? req.options?.[0] ?? '')
  const [expired, setExpired] = useState(false)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!req.timeout || req.timeout <= 0) return
    const id = setTimeout(() => {
      setExpired(true)
      dismissRequest(req.id)
    }, req.timeout)
    return () => clearTimeout(id)
  }, [req.id, req.timeout, dismissRequest])

  const cancel = () => answerUi({ id: req.id, cancelled: true })

  const live = !closing && !expired
  const { isTop } = useModalLayer(live, cancel)
  useFocusTrap(panel, live, isTop)

  if (expired) return null

  const title =
    req.method === 'select'
      ? t('ui.select')
      : req.method === 'confirm'
        ? t('ui.confirm')
        : req.method === 'editor'
          ? t('ui.editor')
          : t('ui.input')

  return (
    <div className={`modal-scrim ${closing ? 'closing' : ''}`} role="dialog" aria-modal="true">
      <div className={`modal ${closing ? 'closing' : ''}`} ref={panel}>
        <div className="modal-head">
          <Icon name={req.method === 'confirm' ? 'alert-circle' : 'message-dots'} size={12} />
          <span className="modal-title">{req.title ?? title}</span>
          <span className="spacer" />
          <IconButton icon="close" iconSize={12} label={t('ui.cancel')} onClick={cancel} />
        </div>

        {req.message ? <div className="modal-message">{req.message}</div> : null}

        {req.method === 'select' && req.options ? (
          <div className="modal-options">
            {req.options.map((o, i) => (
              <button
                key={optionKey(o, i)}
                style={{ '--i': i } as React.CSSProperties}
                className="modal-option"
                onClick={() => answerUi({ id: req.id, value: o })}
              >
                {o}
              </button>
            ))}
          </div>
        ) : null}

        {req.method === 'input' ? (
          <input
            className="modal-input"
            autoFocus
            value={value}
            placeholder={req.placeholder ?? ''}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') answerUi({ id: req.id, value })
            }}
          />
        ) : null}

        {req.method === 'editor' ? (
          <textarea
            className="modal-editor"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : null}

        <div className="modal-foot">
          <span className="spacer" />
          <Button onClick={cancel}>
            {t('ui.cancel')}
          </Button>

          {req.method === 'confirm' ? (
            <>
              <Button variant="danger" onClick={() => answerUi({ id: req.id, confirmed: false })}>
                {t('ui.no')}
              </Button>
              <button className="send" onClick={() => answerUi({ id: req.id, confirmed: true })}>
                {t('ui.yes')}
              </button>
            </>
          ) : null}

          {req.method === 'input' || req.method === 'editor' ? (
            <button className="send" onClick={() => answerUi({ id: req.id, value })}>
              {t('ui.ok')}
            </button>
          ) : null}

          {req.method === 'select' && req.options?.length === 0 ? (
            <button className="send" onClick={() => answerUi({ id: req.id, value: '' })}>
              {t('ui.ok')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const CONN_BAR_DELAY_MS = 1500

export function ConnBar({ conn }: { conn: 'starting' | 'ready' | 'exited' | 'error' }) {
  const t = useT()
  const logs = useStore((s) => s.logs)
  const connDetail = useStore((s) => s.connDetail)
  const [showDetail, setShowDetail] = useState(false)
  const [late, setLate] = useState(conn !== 'starting')
  useEffect(() => {
    if (conn !== 'starting') {
      setLate(true)
      return
    }
    setLate(false)
    const id = window.setTimeout(() => setLate(true), CONN_BAR_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [conn])
  if (!late) return null

  return (
    <div className={`connbar ${conn}`}>
      <span className={conn === 'starting' ? 'dot warn' : 'dot err'} />
      <span className="connbar-text">
        {conn === 'starting' ? t('conn.preparing') : connDetail || t('conn.engineDown')}
      </span>
      <span className="spacer" />
      <Button onClick={() => setShowDetail((v) => !v)}>
        {showDetail ? t('conn.hideDetail') : t('conn.detail')}
      </Button>
      <Button onClick={() => {
        void window.yan.start().then((result) => {
          if (!result.ok) useStore.getState().notify('error', result.error || t('conn.engineDown'))
        }).catch((error: unknown) => {
          useStore.getState().notify('error', error instanceof Error ? error.message : t('conn.engineDown'))
        })
      }}>
        {t('conn.retry')}
      </Button>

      {showDetail ? (
        <pre className="connbar-detail">
          {[
            t('conn.cwd', { cwd: useStore.getState().settings?.cwd ?? '—' }),
            '',
            t('conn.stderr'),
            ...(logs.length ? logs.slice(-12) : [t('conn.noOutput')]),
            '',
            t('conn.probeHint')
          ].join('\n')}
        </pre>
      ) : null}
    </div>
  )
}

function noticeLink(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s<>"']+/)?.[0]
}

export function Notices() {
  const t = useT()
  const notices = useStore((s) => s.notices)
  const dismiss = useStore((s) => s.dismissNotice)
  const openSettings = useStore((s) => s.openSettings)

  const [leaving, setLeaving] = useState<typeof notices>([])
  const prev = useRef<typeof notices>([])
  const makeTimers = (): ReturnType<typeof createPerIdTimers> => createPerIdTimers({
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: (id) => window.clearTimeout(id as number)
  })
  const leaveTimers = useRef<ReturnType<typeof createPerIdTimers> | null>(null)
  const dismissTimers = useRef<ReturnType<typeof createPerIdTimers> | null>(null)
  if (!leaveTimers.current) leaveTimers.current = makeTimers()
  if (!dismissTimers.current) dismissTimers.current = makeTimers()

  useEffect(() => {
    const gone = prev.current.filter((p) => !notices.some((n) => n.id === p.id))
    prev.current = notices
    if (gone.length === 0) return

    setLeaving((cur) => [...cur.filter((item) => !gone.some((entry) => entry.id === item.id)), ...gone])
    const ms = prefersReducedMotion() ? 1 : EXIT_MS
    for (const item of gone) {
      leaveTimers.current?.schedule(item.id, ms, () => {
        setLeaving((cur) => cur.filter((entry) => entry.id !== item.id))
      })
    }
  }, [notices])

  useEffect(() => {
    const active = new Set(notices.map((notice) => notice.id))
    dismissTimers.current?.clearMissing(active)
    for (const notice of notices) {
      if (dismissTimers.current?.has(notice.id) || notice.action === 'git-install' || notice.action === 'app-update') continue
      const delay = notice.action || noticeLink(notice.text) ? 20_000 : notice.type === 'error' ? 12_000 : 5_000
      dismissTimers.current?.schedule(notice.id, delay, () => dismiss(notice.id))
    }
  }, [notices, dismiss])

  useEffect(() => () => {
    leaveTimers.current?.dispose()
    dismissTimers.current?.dispose()
  }, [])

  const shown = [...notices, ...leaving]
  if (shown.length === 0) return null

  return (
    <div className="notices">
      {shown.map((n, i) => {
        const isLeaving = !notices.some((x) => x.id === n.id)
        if (n.action === 'git-install') {
          return (
            <div
              key={n.id}
              className={`notice ${n.type} notice-action ${isLeaving ? 'closing' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              data-testid="git-install-notice"
            >
              <Icon name="alert-circle" size={12} />
              <span className="notice-text">{n.text}</span>
              <span className="notice-actions">
                <GitInstallControl size="sm" />
                <Button size="sm" variant="ghost" onClick={() => dismiss(n.id)}>{t('notice.dismiss')}</Button>
              </span>
            </div>
          )
        }
        if (n.action === 'app-update') {
          return (
            <div
              key={n.id}
              className={`notice info notice-action ${isLeaving ? 'closing' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              data-testid="app-update-notice"
            >
              <Icon name="package" size={12} />
              <span className="notice-text">{n.text ? t('update.notice', { v: n.text }) : t('update.available')}</span>
              <span className="notice-actions">
                <Button size="sm" variant="primary" onClick={() => { dismiss(n.id); openSettings('about') }} data-testid="app-update-notice-open">{t('update.noticeOpen')}</Button>
                <Button size="sm" variant="ghost" onClick={() => dismiss(n.id)}>{t('update.noticeLater')}</Button>
              </span>
            </div>
          )
        }
        if (n.action === 'search-api-hint') {
          return (
            <div
              key={n.id}
              className={`notice info notice-action ${isLeaving ? 'closing' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              data-testid="search-api-hint"
            >
              <Icon name="search" size={12} />
              <span className="notice-text">{t('search.apiHint')}</span>
              <span className="notice-actions">
                <Button size="sm" onClick={() => { dismiss(n.id); openSettings('capabilities') }}>{t('search.apiHintSetup')}</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="search-api-hint-dismiss"
                  onClick={() => { dismiss(n.id); void window.yan.search.setApiHintDismissed(true) }}
                >
                  {t('search.apiHintNever')}
                </Button>
              </span>
            </div>
          )
        }
        const link = noticeLink(n.text)
        if (link) {
          return (
            <div
              key={n.id}
              className={`notice ${n.type} notice-action ${isLeaving ? 'closing' : ''}`}
              style={{ '--i': i } as React.CSSProperties}
              data-testid="notice-link"
            >
              <Icon name="check-circle" size={12} />
              <span className="notice-text">{n.text}</span>
              <span className="notice-actions">
                <Button size="sm" onClick={() => { dismiss(n.id); void window.yan.browser.openExternal(link) }}>{t('notice.openLink')}</Button>
                <Button size="sm" variant="ghost" onClick={() => dismiss(n.id)}>{t('notice.dismiss')}</Button>
              </span>
            </div>
          )
        }
        return (
          <button
            key={n.id}
            className={`notice ${n.type} ${isLeaving ? 'closing' : ''}`}
            style={{ '--i': i } as React.CSSProperties}
            onClick={() => dismiss(n.id)}
          >
            <Icon name={n.type === 'error' ? 'alert-circle' : n.type === 'warning' ? 'alert-circle' : 'check-circle'} size={12} />
            <span>{n.text}</span>
          </button>
        )
      })}
    </div>
  )
}
