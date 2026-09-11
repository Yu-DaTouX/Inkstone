import { useEffect, useState } from 'react'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import type { ExtensionUiRequest } from '../../../shared/ipc'

/**
 * 扩展 UI 桥 —— 把 pi 扩展的 select / confirm / input / editor
 * 映射成真正的模态框。
 *
 * 不做这层的话，装了 confirm 的扩展在桌面端会**静默卡住**
 * （pi 侧在等 extension_ui_response）。所以这不是装饰功能。
 *
 * notify 走 <Notices />，setStatus 走底部状态条，都不在这里。
 */
export function UiDialog() {
  const requests = useStore((s) => s.uiRequests)
  const req = requests[0]
  if (!req) return null
  // key 用 id：换一个请求就重置内部状态
  return <DialogBody key={req.id} req={req} />
}

function DialogBody({ req }: { req: ExtensionUiRequest }) {
  const t = useT()
  const answerUi = useStore((s) => s.answerUi)
  const dismissRequest = useStore((s) => s.dismissRequest)

  const [value, setValue] = useState(req.prefill ?? req.options?.[0] ?? '')
  const [expired, setExpired] = useState(false)

  // pi 侧会自己超时解析，但我们也要收起来，否则框会一直挂着
  useEffect(() => {
    if (!req.timeout || req.timeout <= 0) return
    const id = setTimeout(() => {
      setExpired(true)
      dismissRequest(req.id)
    }, req.timeout)
    return () => clearTimeout(id)
  }, [req.id, req.timeout, dismissRequest])

  if (expired) return null

  const cancel = () => answerUi({ id: req.id, cancelled: true })

  const title =
    req.method === 'select'
      ? t('ui.select')
      : req.method === 'confirm'
        ? t('ui.confirm')
        : req.method === 'editor'
          ? t('ui.editor')
          : t('ui.input')

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <Icon name={req.method === 'confirm' ? 'alert-circle' : 'message-dots'} size={12} />
          <span className="modal-title">{req.title ?? title}</span>
          <span className="spacer" />
          <button className="btn icon" onClick={cancel} title={t('ui.cancel')}>
            ✕
          </button>
        </div>

        {req.message ? <div className="modal-message">{req.message}</div> : null}

        {req.method === 'select' && req.options ? (
          <div className="modal-options">
            {req.options.map((o) => (
              <button
                key={o}
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
              if (e.key === 'Escape') cancel()
            }}
          />
        ) : null}

        {req.method === 'editor' ? (
          <textarea
            className="modal-editor"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel()
            }}
          />
        ) : null}

        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn" onClick={cancel}>
            {t('ui.cancel')}
          </button>

          {req.method === 'confirm' ? (
            <>
              <button className="btn danger" onClick={() => answerUi({ id: req.id, confirmed: false })}>
                {t('ui.no')}
              </button>
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

/* ------------------------------------------------------------------
   连接失败条
   ------------------------------------------------------------------ */
export function ConnBar({ conn }: { conn: 'starting' | 'ready' | 'exited' | 'error' }) {
  const logs = useStore((s) => s.logs)
  const connDetail = useStore((s) => s.connDetail)
  const [showDetail, setShowDetail] = useState(false)

  return (
    <div className={`connbar ${conn}`}>
      <span className={conn === 'starting' ? 'dot warn' : 'dot err'} />
      <span className="connbar-text">
        {conn === 'starting' ? '正在启动 pi…' : connDetail || 'pi 未连接'}
      </span>
      <span className="spacer" />
      <button className="btn" onClick={() => setShowDetail((v) => !v)}>
        {showDetail ? '收起' : '详情'}
      </button>
      <button className="btn" onClick={() => void window.yan.start()}>
        重试
      </button>

      {showDetail ? (
        <pre className="connbar-detail">
          {[
            `工作目录：${useStore.getState().settings?.cwd ?? '—'}`,
            '',
            '--- pi 的 stderr（最近 12 行）---',
            ...(logs.length ? logs.slice(-12) : ['（无输出）']),
            '',
            '排查提示：运行 `npm run probe-pi` 可以单独验证 pi 能不能被找到并启动。'
          ].join('\n')}
        </pre>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ 通知 */
export function Notices() {
  const notices = useStore((s) => s.notices)
  const dismiss = useStore((s) => s.dismissNotice)

  // 自动消失（error 留久一点，用户可能要看）
  useEffect(() => {
    if (notices.length === 0) return
    const timers = notices.map((n) =>
      setTimeout(() => dismiss(n.id), n.type === 'error' ? 12_000 : 5_000)
    )
    return () => timers.forEach(clearTimeout)
  }, [notices, dismiss])

  if (notices.length === 0) return null

  return (
    <div className="notices">
      {notices.map((n) => (
        <button key={n.id} className={`notice ${n.type}`} onClick={() => dismiss(n.id)}>
          <Icon name={n.type === 'error' ? 'alert-circle' : n.type === 'warning' ? 'alert-circle' : 'check-circle'} size={12} />
          <span>{n.text}</span>
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------- 底部状态 / 日志 */

/** 扩展 setStatus 的条目 + pi 的 stderr（可展开） */
export function StatusBar() {
  const t = useT()
  const statuses = useStore((s) => s.statuses)
  const logs = useStore((s) => s.logs)
  const session = useStore((s) => s.session)
  const [open, setOpen] = useState(false)

  const entries = Object.entries(statuses)
  const hasLogs = logs.length > 0
  if (entries.length === 0 && !hasLogs && !session?.isCompacting) return null

  return (
    <>
      <div className="statusbar">
        {session?.isCompacting ? (
          <span className="statusbar-item warn">
            <Icon name="refresh" size={12} className="spin" />
            <span>{t('status.compacting')}</span>
          </span>
        ) : null}

        {entries.map(([k, v]) => (
          <span key={k} className="statusbar-item">
            <span className="statusbar-key">{k}</span>
            <span>{v}</span>
          </span>
        ))}

        <span className="spacer" />

        {hasLogs ? (
          <button className="btn icon" onClick={() => setOpen((v) => !v)} title={t('log.title')}>
            <Icon name="activity" size={12} />
            <span className="statusbar-count">{logs.length}</span>
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="logdrawer">
          <div className="logdrawer-head">
            <span>{t('log.title')}</span>
            <span className="spacer" />
            <button className="btn icon" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <pre className="logdrawer-body">
            {logs.length ? logs.join('\n') : t('log.empty')}
          </pre>
        </div>
      ) : null}
    </>
  )
}
