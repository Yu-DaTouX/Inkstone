import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { identityForAwait, useStore } from '../../state/store'

/**
 * `+` 菜单（2026-09-22）：codex 式「添加」入口。
 *
 * 为什么不再让 `+` 直接开图片选择器：图片只是**其中一种**能加进来的东西。
 * 「文件和文件夹」「图片」「能力」并排之后，用户不用先猜 `+` 会做什么。
 *
 * ⚠️ 菜单是 `fixed` 定位：`.composer` 有 `overflow: hidden`（圆角与自主光带
 *    需要它），`absolute` 会被整块裁掉 —— 与 `.mode-menu` / `.mt-pop` 同一个坑。
 */
export function PlusMenu({ onInsert }: { onInsert: (text: string) => void }) {
  const t = useT()
  const pickImages = useStore((s) => s.pickImages)
  const pickFiles = useStore((s) => s.pickFiles)
  const setGoal = useStore((s) => s.setGoal)
  const openSettings = useStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null)
  const [caps, setCaps] = useState<{ id: string; title: string; hint: string }[] | null>(null)
  /* 目标表单：菜单内的第二层，不另开浮层（浮层叠浮层在窄屏上会互相遮） */
  const [composing, setComposing] = useState(false)
  const [goalText, setGoalText] = useState('')
  const [outcomeText, setOutcomeText] = useState('')
  /*
   * 可选补充栏（实施-16 G-1）：默认收起 —— 不展开时仍是原来的「目标 + 成果」两栏流程，
   * 菜单长度和维护习惯不变；空字符串 = 用户没写，不往目标里塞默认句。
   */
  const [extrasOpen, setExtrasOpen] = useState(false)
  const [deliverableText, setDeliverableText] = useState('')
  const [scopeText, setScopeText] = useState('')
  const [constraintsText, setConstraintsText] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const goalInputRef = useRef<HTMLTextAreaElement>(null)
  const MENU_WIDTH = 340

  /* 打开时量按钮坐标并把焦点交给菜单 —— 否则方向键到不了菜单里 */
  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const el = buttonRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8))
      setAnchor({ left, bottom: Math.max(8, window.innerHeight - r.top + 6) })
    }
    menuRef.current?.focus()
  }, [open])

  /* 点外部关闭（菜单是浮层，不能一直挡着输入区） */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  /*
   * 能力清单**打开时才拉**：它要读磁盘上的技能目录与 MCP 配置，
   * 每次渲染都拉会把输入区变成一个会打磁盘的组件。
   */
  useEffect(() => {
    if (!open || caps) return
    let alive = true
    void (async () => {
      try {
        const snap = await window.yan.capabilities.snapshot()
        if (!alive) return
        setCaps([
          ...snap.skills.map((s) => ({ id: `skill:${s.id}`, title: s.title, hint: s.description })),
          ...snap.servers.map((s) => ({
            id: `mcp:${s.id}`,
            title: s.title,
            hint: s.enabled ? s.transport : `${s.transport} · ${t('cap.disabled')}`
          }))
        ])
      } catch {
        /* 读不到就当没有能力 —— 菜单本身仍然可用 */
        if (alive) setCaps([])
      }
    })()
    return () => {
      alive = false
    }
  }, [open, caps, t])

  const close = (): void => {
    setOpen(false)
    setComposing(false)
    buttonRef.current?.focus()
  }

  /* 进目标表单时把焦点交给第一栏 —— 否则键盘用户要 Tab 一路找过去 */
  useEffect(() => {
    if (open && composing) goalInputRef.current?.focus()
  }, [open, composing])

  /** 建立持续目标：成功才把消息模板写进输入框（失败时输入框不该被动过） */
  const startGoal = async (): Promise<void> => {
    const goal = goalText.trim()
    const outcome = outcomeText.trim()
    if (!goal || !outcome) return
    const deliverable = deliverableText.trim()
    const scope = scopeText.trim()
    const constraints = constraintsText.trim()
    /*
     * A7（实施-14 F5）：await 之前记下会话身份，回来先核对。
     * 用户在等响应的这几百毫秒里切了会话时，不能把目标模板插到另一条会话的输入框。
     */
    const before = identityForAwait(useStore.getState())
    const res = await setGoal({
      goal,
      outcome,
      ...(deliverable ? { deliverable } : {}),
      ...(scope ? { scope } : {}),
      ...(constraints ? { constraints } : {})
    })
    if (!res.ok) return
    if (identityForAwait(useStore.getState()) !== before) return
    close()
    /* 种子消息带上用户写全的契约：模型第一轮就该看到补充字段，而不是只看到两栏 */
    const extra = [
      deliverable ? t('plus.goalSeedDeliverable', { value: deliverable }) : '',
      scope ? t('plus.goalSeedScope', { value: scope }) : '',
      constraints ? t('plus.goalSeedConstraints', { value: constraints }) : ''
    ].filter(Boolean)
    onInsert([t('plus.goalSeed', { goal, outcome }), ...extra].join('\n'))
    setGoalText('')
    setOutcomeText('')
    setDeliverableText('')
    setScopeText('')
    setConstraintsText('')
    setExtrasOpen(false)
  }

  return (
    <div className="mode-picker" ref={rootRef}>
      <button
        ref={buttonRef}
        className="ctool"
        title={t('composer.attach')}
        data-testid="composer-attach"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
          } else if (e.key === 'Escape' && open) {
            e.preventDefault()
            close()
          }
        }}
      >
        <Icon name="plus" size={12} />
      </button>

      {open ? (
        <div
          className="mode-menu plus-menu"
          role="menu"
          data-testid="plus-menu"
          ref={menuRef}
          tabIndex={-1}
          style={{ width: MENU_WIDTH, ...(anchor ? { left: anchor.left, bottom: anchor.bottom } : {}) }}
        >
          {composing ? (
            /*
             * 目标表单：目标 + **可衡量的成果**两栏。
             * 第二栏不是可选的 —— 「不达成不结束」需要一条能验收的判据，
             * 否则模型永远可以宣布自己完成了。
             */
            <div className="plus-compose" data-testid="plus-goal-compose">
              <span className="plus-group-label">{t('plus.goalTitle')}</span>
              <label className="plus-field">
                <span className="plus-field-label">{t('plus.goalField')}</span>
                <textarea
                  ref={goalInputRef}
                  className="plus-input"
                  data-testid="plus-goal-text"
                  rows={2}
                  value={goalText}
                  placeholder={t('plus.goalPlaceholder')}
                  onChange={(e) => setGoalText(e.target.value)}
                />
              </label>
              <label className="plus-field">
                <span className="plus-field-label">{t('plus.outcomeField')}</span>
                <textarea
                  className="plus-input"
                  data-testid="plus-outcome-text"
                  rows={2}
                  value={outcomeText}
                  placeholder={t('plus.outcomePlaceholder')}
                  onChange={(e) => setOutcomeText(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="plus-extras-toggle"
                data-testid="plus-goal-extras-toggle"
                aria-expanded={extrasOpen}
                onClick={() => setExtrasOpen((v) => !v)}
              >
                {t('plus.extrasToggle')}
              </button>
              {extrasOpen ? (
                <>
                  <label className="plus-field">
                    <span className="plus-field-label">{t('plus.deliverableField')}</span>
                    <textarea
                      className="plus-input"
                      data-testid="plus-deliverable-text"
                      rows={2}
                      value={deliverableText}
                      placeholder={t('plus.deliverablePlaceholder')}
                      onChange={(e) => setDeliverableText(e.target.value)}
                    />
                  </label>
                  <label className="plus-field">
                    <span className="plus-field-label">{t('plus.scopeField')}</span>
                    <textarea
                      className="plus-input"
                      data-testid="plus-scope-text"
                      rows={2}
                      value={scopeText}
                      placeholder={t('plus.scopePlaceholder')}
                      onChange={(e) => setScopeText(e.target.value)}
                    />
                  </label>
                  <label className="plus-field">
                    <span className="plus-field-label">{t('plus.constraintsField')}</span>
                    <textarea
                      className="plus-input"
                      data-testid="plus-constraints-text"
                      rows={2}
                      value={constraintsText}
                      placeholder={t('plus.constraintsPlaceholder')}
                      onChange={(e) => setConstraintsText(e.target.value)}
                    />
                  </label>
                </>
              ) : null}
              <div className="plus-actions">
                <button
                  className="plus-start"
                  data-testid="plus-goal-start"
                  disabled={!goalText.trim() || !outcomeText.trim()}
                  onClick={() => void startGoal()}
                >
                  {t('plus.goalStart')}
                </button>
                <button
                  className="plus-back"
                  data-testid="plus-goal-back"
                  onClick={() => setComposing(false)}
                >
                  {t('plus.goalBack')}
                </button>
              </div>
            </div>
          ) : (
            <>
          <button
            className="mode-item"
            role="menuitem"
            data-testid="plus-files"
            onClick={() => {
              close()
              void pickFiles()
            }}
          >
            <span className="mode-item-label">{t('plus.files')}</span>
            <span className="mode-item-desc">{t('plus.filesHint')}</span>
          </button>
          <button
            className="mode-item"
            role="menuitem"
            data-testid="plus-images"
            onClick={() => {
              close()
              void pickImages()
            }}
          >
            <span className="mode-item-label">{t('plus.images')}</span>
            <span className="mode-item-desc">{t('plus.imagesHint')}</span>
          </button>
          <button
            className="mode-item"
            role="menuitem"
            data-testid="plus-goal"
            onClick={() => setComposing(true)}
          >
            <span className="mode-item-label">{t('plus.goal')}</span>
            <span className="mode-item-desc">{t('plus.goalHint')}</span>
          </button>

          <div className="plus-group" data-testid="plus-capabilities">
            <span className="plus-group-label">{t('plus.capabilities')}</span>
            {caps === null ? null : caps.length === 0 ? (
              /*
               * 空态可直接点：用户看到「去设置里加」时的下一个动作就是去那里，
               * 让他再自己找一遍设置入口是多一层无用功。
               */
              <button
                className="mode-item plus-empty"
                data-testid="plus-cap-empty"
                onClick={() => {
                  close()
                  openSettings('capabilities')
                }}
              >
                <span className="mode-item-label">{t('plus.capEmpty')}</span>
                <span className="mode-item-desc">{t('plus.capEmptyHint')}</span>
              </button>
            ) : (
              caps.map((cap) => (
                <button
                  key={cap.id}
                  className="mode-item"
                  role="menuitem"
                  data-testid={`plus-cap-${cap.id}`}
                  onClick={() => {
                    close()
                    onInsert(t('plus.useCapability', { title: cap.title }))
                  }}
                >
                  <span className="mode-item-label">{cap.title}</span>
                  <span className="mode-item-desc">{cap.hint}</span>
                </button>
              ))
            )}
          </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
