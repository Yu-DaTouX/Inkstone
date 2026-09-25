import { useEffect, useRef, useState } from 'react'
import { formatCountdown, UI_TIMEOUT_EXTEND } from '../../../../shared/ui-timeout'
import type { ExtensionUiRequest } from '../../../../shared/ipc'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { PixelDigits } from './PixelDigits'

/**
 * 问题面板（方案第 6 节）。
 *
 * 与旧模态框的区别：
 *   · **非模态**：不遮罩、不圈定焦点 —— 用户要能一边看历史一边回答；
 *   · 位置在输入区上方，宽度跟随消息区，默认最高约 200px（超出内部滚动）；
 *   · 收起**不等于**取消：队列与草稿都保留，标题栏留「有 N 个问题待回答」；
 *   · Enter 只在按钮或指定输入行为里提交；**中文输入法组合期间绝不提交**；
 *   · 新问题到达不抢焦点（不用 autoFocus）；
 *   · 右上角显示剩余时间（默认 3 分钟），**点一下加 2 分钟** —— 延长的不只是
 *     这个数字：真正的超时计时器在主进程，点击会往返一次重置它（见 `yan:extendUi`）。
 *     没有截止时间的扩展请求不显示倒计时（它们的超时由 pi 侧解析）。
 *
 * ── 多问题分页（用户 2026-09-26 要求，参考外部界面）──
 * 同时挂着多条请求时，面板一次只显示一条，头部用 `‹ 1 of 3 ›` 前后翻。
 * 翻页**只改显示**：每条请求都还在等回答，各自的倒计时也照常走 ——
 * 以前只能看到第一条，后面的只体现在「共 N 个问题」这几个字里。
 * 底部是「跳过 / 下一步」：跳过 = 放弃这一条，下一步 = 提交并继续。
 *
 * 仍然用同一套 request id 与 `extension_ui_response` 协议，
 * 所以 pi 侧完全不需要知道界面换了形态。
 *
 * ⚠️ 安全敏感的确认（`sensitive`）不走这里 —— 它们继续用模态框
 * （见 UiBridge.tsx 的 UiDialog）。分类由请求自己声明，
 * **不根据问题措辞推断**。
 */
export function QuestionPanel() {
  const requests = useStore((s) => s.uiRequests)
  const collapsed = useStore((s) => s.uiCollapsed)
  const setCollapsed = useStore((s) => s.setUiCollapsed)
  /** 面板内的翻页位置；只影响显示，不影响哪条在等回答 */
  const [index, setIndex] = useState(0)
  /**
   * 每个请求**第一次出现在面板上**的时刻。
   *
   * 扩展的请求只有 `timeout`、没有 `deadline`，倒计时需要这个起点。放在这里
   * 而不是 `PanelBody` 里：翻页会让 PanelBody 按 `key={req.id}` 重建，
   * 组件内重算等于每翻一次就把超时往后推一次。
   */
  const firstSeen = useRef(new Map<string, number>())

  /* 只接管「普通」请求；sensitive 的留给模态框 */
  const list = requests.filter((r) => r.sensitive !== true)
  const ids = list.map((r) => r.id).join('|')

  /*
   * 队列变了（答完一条 / 超时摘掉 / 来了新的）：清理已消失的起点记录，
   * 并把页码夹回有效范围 —— 答掉最后一条后不能让面板指向空。
   */
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

/** 一条请求的正文
 *
 * `key={req.id}` 在调用处：换一条请求就重建，草稿 / 防重 / 组合状态都从头来。
 */
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
  /** 没有 `deadline` 时的倒计时起点（面板级记录，翻页不重置） */
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

  /** 提交防重：连点两下不能发两次应答 */
  const [busy, setBusy] = useState(false)
  const answered = useRef(false)
  /** 中文输入法组合中（组合期间的 Enter 是「选字」，不是提交） */
  const composing = useRef(false)
  const [expired, setExpired] = useState(false)
  /** 点一次加时就让这个数 +1：靠它给浮出提示换 key，连续点也能重新播放动画 */
  const [bump, setBump] = useState(0)
  /** `select` 的自定义回复是否展开了输入框（默认收起，保持选项区干净） */
  const [custom, setCustom] = useState(false)

  /*
   * `deadline` 的三种含义（见 `shared/ipc.ts`）：
   *   · `> 0` —— 宿主已开始计时，倒计时到那一刻；
   *   · `0` —— 宿主管理但**还没开始**（用户还没看到这一条）→ 不显示倒计时；
   *   · `undefined` —— 扩展自己的请求，渲染端按 `timeout` 从首次可见算起。
   */
  const deadline = req.deadline === undefined ? (req.timeout ? fallbackStart + req.timeout : 0) : req.deadline
  const [remaining, setRemaining] = useState(() => (deadline ? Math.max(0, deadline - Date.now()) : 0))

  /*
   * 这一条已经成为面板当前页（= 用户看得到它了）→ 让主进程开始计时。
   * 只在还没开始过时调一次：`startUiTimer` 本身幂等，重复调用不会重算时间。
   */
  useEffect(() => {
    if (req.deadline !== 0) return
    void startUiTimer(reqId)
  }, [reqId, req.deadline, startUiTimer])

  /* 倒计时与到点收起。到点是**如实收起**：不替用户回答，pi 侧会回超时。 */
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

  /** 点倒计时：加 2 分钟。已不在等待（已被回答 / 已超时）则随手收起面板。 */
  const extend = (): void => {
    void extendUi(reqId, UI_TIMEOUT_EXTEND).then((ok) => {
      if (!ok) {
        setExpired(true)
        return
      }
      /* 浮一下「已加 2 分钟」—— 否则点了只是数字变大，看不出发生了什么 */
      setBump((n) => n + 1)
    })
  }

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

  const text = draft || req.prefill || ''
  const trimmed = text.trim()
  /**
   * 能否提交。
   *   · `input` / `editor`：要真写了东西（空提交等于没回答，pi 会当成取消）；
   *   · `select`：只能靠自定义回复（点选项是另一条立即提交的路径）；
   *   · `confirm`：用下面的「是 / 否」，不走这里。
   */
  const canSubmit =
    req.method === 'select' ? trimmed.length > 0 : req.method === 'input' || req.method === 'editor' ? trimmed.length > 0 : false

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
        <span className="spacer" />
        {deadline ? (
          <span className="qpanel-timer-wrap">
            {bump > 0 ? (
              /* key 换掉就重放动画；`role="status"` 让读屏也能听到「已加 2 分钟」 */
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
              {/* 像素点阵：每个点是一个方块，颜色跟随 currentColor（低余量自动变警色） */}
              <PixelDigits text={formatCountdown(remaining)} />
            </button>
          </span>
        ) : null}
        {/* 多问题分页：只翻显示，不改变「哪条在等回答」 */}
        {page.total > 1 ? (
          <span className="qpanel-page" data-testid="question-panel-page">
            <button
              type="button"
              className="qpanel-page-btn flip"
              disabled={page.index === 0}
              title={t('q.prev')}
              data-testid="question-panel-prev"
              onClick={onPrev}
            >
              <Icon name="chevron-right" size={12} />
            </button>
            <span className="qpanel-page-n" data-index={page.index + 1} data-total={page.total}>
              {t('q.page', { i: page.index + 1, n: page.total })}
            </span>
            <button
              type="button"
              className="qpanel-page-btn"
              disabled={page.index >= page.total - 1}
              title={t('q.nextPage')}
              data-testid="question-panel-next"
              onClick={onNext}
            >
              <Icon name="chevron-right" size={12} />
            </button>
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

          {(req.method === 'select' || req.method === 'input') && req.options?.length ? (
            <div className="qpanel-options">
              {req.options.map((o, index) => (
                <button
                  key={`${index}:${o}`}
                  className="qpanel-option"
                  disabled={busy}
                  onClick={() => answer({ value: o })}
                  data-testid={`question-panel-option-${index}`}
                >
                  {/* 序号 + 右箭头：与参考图一致 —— 整行是一个「选它」的动作 */}
                  <span className="qpanel-option-n" aria-hidden="true">{index + 1}</span>
                  <span className="qpanel-option-t">{o}</span>
                  <Icon name="chevron-right" size={12} className="qpanel-option-go" />
                </button>
              ))}
            </div>
          ) : null}

          {/*
           * 「或自行撰写回复」（用户要求）：
           *   · `select` —— 选项之外还想自己写一句（选中项是立刻提交的，所以另开一行）；
           *   · `input` / `editor` —— 输入框本身就是回答，见下面的分支。
           * 不 autoFocus：问题到达时用户可能正在别处打字。
           */}
          {req.method === 'select' ? (
            custom ? (
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
            ) : (
              <button className="qpanel-custom-open" data-testid="question-panel-custom-open" disabled={busy} onClick={() => setCustom(true)}>
                <Icon name="tag" size={12} />
                {t('q.customReply')}
              </button>
            )
          ) : null}

          {req.method === 'input' ? (
            <input
              className="qpanel-input"
              data-testid="question-panel-input"
              value={text}
              placeholder={req.placeholder ?? ''}
              /* 不 autoFocus：问题到达时用户可能正在别处打字 */
              onChange={(e) => setUiDraft(reqId, e.target.value)}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                /* 输入法组合中不提交（方案第 6 节） */
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

          <div className="qpanel-foot">
            <button className="btn" disabled={busy} onClick={() => answer({ cancelled: true })} data-testid="question-panel-skip">
              {t('q.skip')}
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

            {req.method === 'input' || req.method === 'editor' || req.method === 'select' ? (
              <button className="btn primary" disabled={busy || !canSubmit} onClick={() => answer({ value: trimmed })} data-testid="question-panel-submit">
                {/* 多条问题时是「下一步」，只有一条时就是普通的「提交回答」 */}
                {page.total > 1 ? t('q.next') : t('q.submit')}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
