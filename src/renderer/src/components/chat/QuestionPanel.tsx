import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'

/**
 * 问题面板（方案第 6 节）。
 *
 * 与旧模态框的区别：
 *   · **非模态**：不遮罩、不圈定焦点 —— 用户要能一边看历史一边回答；
 *   · 位置在输入区上方，宽度跟随消息区，默认最高约 200px（超出内部滚动）；
 *   · 收起**不等于**取消：队列与草稿都保留，标题栏留「有 N 个问题待回答」；
 *   · Enter 只在按钮或指定输入行为里提交；**中文输入法组合期间绝不提交**；
 *   · 新问题到达不抢焦点（不用 autoFocus）。
 *
 * 仍然用同一套 request id 与 `extension_ui_response` 协议，
 * 所以 pi 侧完全不需要知道界面换了形态。
 *
 * ⚠️ 安全敏感的确认（`sensitive`）不走这里 —— 它们继续用模态框
 *    （见 UiBridge.tsx 的 UiDialog）。分类由请求自己声明，
 *    **不根据问题措辞推断**。
 */
export function QuestionPanel() {
  const requests = useStore((s) => s.uiRequests)
  const collapsed = useStore((s) => s.uiCollapsed)
  const setCollapsed = useStore((s) => s.setUiCollapsed)

  /* 只接管「普通」请求；sensitive 的留给模态框 */
  const req = requests.find((r) => r.sensitive !== true) ?? null
  if (!req) return null

  return <PanelBody key={req.id} reqId={req.id} collapsed={collapsed} setCollapsed={setCollapsed} queue={requests.length} />
}

function PanelBody({
  reqId,
  collapsed,
  setCollapsed,
  queue
}: {
  reqId: string
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  queue: number
}) {
  const t = useT()
  const req = useStore((s) => s.uiRequests.find((r) => r.id === reqId))
  const draft = useStore((s) => s.uiDrafts[reqId] ?? '')
  const setUiDraft = useStore((s) => s.setUiDraft)
  const answerUi = useStore((s) => s.answerUi)
  const dismissRequest = useStore((s) => s.dismissRequest)

  /** 提交防重：连点两下不能发两次应答 */
  const [busy, setBusy] = useState(false)
  const answered = useRef(false)
  /** 中文输入法组合中（组合期间的 Enter 是「选字」，不是提交） */
  const composing = useRef(false)
  const [expired, setExpired] = useState(false)

  /* 超时：pi 侧会自己解析，但界面也要收起来，否则面板一直挂着 */
  useEffect(() => {
    const ms = req?.timeout
    if (!ms || ms <= 0) return
    const id = setTimeout(() => {
      setExpired(true)
      dismissRequest(reqId)
    }, ms)
    return () => clearTimeout(id)
  }, [reqId, req?.timeout, dismissRequest])

  if (!req || expired) return null

  const answer = (res: { value?: string; confirmed?: boolean; cancelled?: boolean }): void => {
    if (answered.current) return
    answered.current = true
    setBusy(true)
    answerUi({ id: reqId, ...res })
  }

  const title =
    req.method === 'select'
      ? t('q.select')
      : req.method === 'confirm'
        ? t('q.confirm')
        : req.method === 'editor'
          ? t('q.editor')
          : t('q.input')

  const value = draft || req.prefill || ''

  return (
    <div
      className={`qpanel ${collapsed ? 'collapsed' : ''}`}
      data-testid="question-panel"
      /* 普通区域语义：不是模态，所以不用 aria-modal */
      role="group"
      aria-label={req.title ?? title}
    >
      <div className="qpanel-head">
        <Icon name={req.method === 'confirm' ? 'alert-circle' : 'message-dots'} size={12} />
        <span className="qpanel-title">{req.title ?? title}</span>
        {queue > 1 ? <span className="qpanel-count">{t('q.pending', { n: queue })}</span> : null}
        <span className="spacer" />
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
        <div className="qpanel-mini">{t('q.collapsed', { n: queue })}</div>
      ) : (
        <div className="qpanel-body" data-testid="question-panel-body">
          {req.message ? <div className="qpanel-msg">{req.message}</div> : null}

          {req.method === 'select' && req.options ? (
            <div className="qpanel-options">
              {req.options.map((o) => (
                <button key={o} className="qpanel-option" disabled={busy} onClick={() => answer({ value: o })}>
                  {o}
                </button>
              ))}
            </div>
          ) : null}

          {req.method === 'input' ? (
            <input
              className="qpanel-input"
              data-testid="question-panel-input"
              value={value}
              placeholder={req.placeholder ?? ''}
              /* 不 autoFocus：问题到达时用户可能正在别处打字 */
              onChange={(e) => setUiDraft(reqId, e.target.value)}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                /* 输入法组合中不提交（方案第 6 节） */
                if (composing.current || e.nativeEvent.isComposing) return
                answer({ value })
              }}
            />
          ) : null}

          {req.method === 'editor' ? (
            <textarea
              className="qpanel-editor"
              data-testid="question-panel-editor"
              value={value}
              onChange={(e) => setUiDraft(reqId, e.target.value)}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
            />
          ) : null}

          <div className="qpanel-foot">
            <button className="btn" disabled={busy} onClick={() => answer({ cancelled: true })}>
              {t('ui.cancel')}
            </button>
            <span className="spacer" />

            {req.method === 'confirm' ? (
              <>
                <button className="btn" disabled={busy} onClick={() => answer({ confirmed: false })}>
                  {t('ui.no')}
                </button>
                <button className="btn primary" disabled={busy} onClick={() => answer({ confirmed: true })} data-testid="question-panel-submit">
                  {t('ui.yes')}
                </button>
              </>
            ) : null}

            {req.method === 'input' || req.method === 'editor' ? (
              <button className="btn primary" disabled={busy} onClick={() => answer({ value })} data-testid="question-panel-submit">
                {t('q.submit')}
              </button>
            ) : null}

            {req.method === 'select' && req.options?.length === 0 ? (
              <button className="btn primary" disabled={busy} onClick={() => answer({ value: '' })}>
                {t('ui.ok')}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
