import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { Button, StepSlider, Switch } from './ui'
import { ModelCatalog } from './ModelCatalog'
import { useFocusTrap, useModalLayer } from '../lib/modalLayer'
import { useAnchoredPopover } from '../lib/useAnchoredPopover'
import { WheelPicker } from './ui/WheelPicker'

/** 模型与思考强度选择器：离散档位的点阵滑块，按当前模型报告的可用档位展示。 */
export function ModelThinkingPicker() {
  const t = useT()
  const session = useStore((s) => s.session)
  const levels = useStore((s) => s.thinkingLevels)
  const setModel = useStore((s) => s.setModel)
  const setThinking = useStore((s) => s.setThinking)
  /* 凭证状态（D12）：用来把“没配 API”与“不支持思考”分开说 */
  const authProviders = useStore((s) => s.authProviders)
  const loadAuthProviders = useStore((s) => s.loadAuthProviders)
  /* 回复详细程度（方案 3.1）：与推理强度分开的两个维度 */
  const patchSettings = useStore((s) => s.patchSettings)
  const responseDetail = useStore((s) => s.settings?.responseDetail ?? 'standard')
  const visualAnswers = useStore((s) => s.settings?.visualAnswers) !== false
  const rememberedModel = useStore(s => s.settings?.lastMainModel)
  const models = useStore(s => s.models)
  const [recoveryError, setRecoveryError] = useState('')
  const [recovering, setRecovering] = useState(false)

  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const position = useAnchoredPopover(open, box, 420, 680)
  const maxH = position.maxHeight
  const { isTop } = useModalLayer(open, () => setOpen(false))
  useFocusTrap(menu, open, isTop)

  /* pi 没拿到模型时会报一个名为 unknown 的占位：界面上不直接露出这个词 */
  const cur = session?.model && session.model.id !== 'unknown' && session.model.name !== 'unknown' ? session.model : undefined
  const level = session?.thinkingLevel ?? 'off'
  /* 拖动手柄时头部实时显示手柄所在档位（松手才真正切档） */
  const [previewLevel, setPreviewLevel] = useState<string | null>(null)
  const headLevel = previewLevel ?? level
  const thinkingStatus = session?.thinkingLevelsStatus ?? (levels.length ? 'known' : 'unknown')
  const busy = !!session?.isStreaming || !!session?.isCompacting

  /*
   * 凭证状态（D12）。
   *
   * 只在**真的要显示菜单**时才拉：它要读 auth.json 并探测环境变量。
   * 拿不到状态（列表为空）时一律当作“不知道”，不往界面上写任何结论 ——
   * 宁可少标一个徽标，也不能把配好的供应商标成“未配置”。
   */
  useEffect(() => {
    if (open) void loadAuthProviders()
  }, [open, loadAuthProviders])

  const needsAuth = (provider: string): boolean => {
    if (authProviders.length === 0) return false
    const info = authProviders.find((p) => p.id === provider || p.authKey === provider)
    /* 目录里没有这个供应商（pi 支持但不在内置目录）→ 不判断，不当成未配置 */
    return !!info && info.status !== 'ready'
  }

  // 点外面 / Esc 关掉
  useEffect(() => {
    if (!open) return
    const release = useStore.getState().acquireOverlayBlocker('model-picker')
    const onDown = (e: MouseEvent): void => {
      if (!isTop) return
      if (!box.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      release()
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, isTop])


  /**
   * 档位的中文名。
   *
   * 与 pi 的 7 档一一对应（off → max），不合并：
   * 合并会让「点了没变化」变成可能的体验（两个档位映射到同一个名字）。
   */
  const thinkLabel = (l: string): string => {
    const map: Record<string, string> = {
      off: t('think.off'),
      minimal: t('think.minimal'),
      low: t('think.low'),
      medium: t('think.medium'),
      high: t('think.high'),
      xhigh: t('think.xhigh'),
      max: t('think.max')
    }
    return map[l] ?? l
  }

  /*
   * ⚠️ 这里曾经是 `if (!cur) return null`（用户报的「看不到模型选择」）。
   *
   * pi 未就绪、启动超时或凭证失效时 `session` 为 null，于是选择器**整个消失**：
   * 用户既看不到当前模型，也失去了唯一的换模型入口 —— 而这恰恰是最需要
   * 一个入口去排查/救援的时刻。现在改为降级渲染：触发器显示「模型未就绪」，
   * 菜单仍可打开（列表为空时给明确空态）。
   *
   * 注意 `session.model` 在无凭证时是 `{id:'unknown', provider:'unknown'}`，
   * **并不为空**；真正为空的只有 `session` 本身。
   */
  const hasLevels = levels.length > 1
  /*
   * 只有「关」一档：pi 认为这个模型不能思考（模型条目没标 reasoning）。
   * 不再把整块藏起来 —— 用户会以为档位选项丢了；说清原因，砚管理的服务给出去设置的入口。
   */
  const notDeclared = !hasLevels && thinkingStatus === 'known' && !!cur
  const customProvider = !!cur?.provider && /^yan-/.test(cur.provider)
  const showThinkingSection = hasLevels || thinkingStatus !== 'known' || notDeclared

  return (
    <div className="picker-wrap" ref={box}>
      <button
        className={`mt-trigger ${open ? 'open' : ''} ${cur ? '' : 'unknown'}`}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={busy ? t('picker.busy') : cur ? t('picker.modelTip') : t('picker.notReadyTip')}
        data-testid="model-picker"
        data-state={cur ? 'ready' : 'unknown'}
        aria-haspopup="dialog" aria-expanded={open}
      >
        {/* 档位色的小点：与运行条同一套 --think-* 颜色，一眼看出当前强度 */}
        <span className="mt-dot" data-level={hasLevels ? level : 'off'} aria-hidden />
        <span className="mt-model">{cur ? cur.name : t('picker.notReady')}</span>
        {hasLevels && level !== 'off' ? (
          <span className="mt-level" data-level={level} data-testid="thinking-badge">
            {thinkLabel(level)}
          </span>
        ) : null}
        <Icon name="chevron-right" size={12} className={`mt-chev chev ${open ? 'flip-up' : 'on'}`} />
      </button>

      {open ? createPortal(
        <div
          /* 矮窗口：两块设置收紧，把高度让给模型列表 */
          className={`mt-pop${maxH && maxH < 480 ? ' compact' : ''}`}
          ref={menu} role="dialog" aria-modal="true" aria-label={t('picker.searchModel')}
          data-testid="model-menu"
          style={position}
        >
          {!cur && !models.length && rememberedModel ? <div className="model-catalog">
            <p className="ui-row-desc">{t('models.defaultUnavailable', { name: rememberedModel.name || rememberedModel.id })}</p>
            <Button size="sm" disabled={recovering} data-testid="models-reset-default" onClick={() => {
              setRecovering(true); setRecoveryError('')
              void (async () => {
                await patchSettings({ lastMainModel: undefined })
                const result = await window.yan.start()
                if (!result.ok) throw new Error(result.error || t('models.selectFailed'))
                await useStore.getState().reloadModels()
              })().catch(e => setRecoveryError(String(e))).finally(() => setRecovering(false))
            }}>{t('models.resetDefault')}</Button>
            {recoveryError ? <p className="ui-row-desc" role="alert">{recoveryError}</p> : null}
          </div> : null}
          <ModelCatalog current={cur} compact={maxH < 480} needsAuth={needsAuth} onSelect={async model => {
            const result = await setModel(model.provider, model.id, true)
            if (!result.ok) throw new Error(result.error || t('models.selectFailed'))
            setOpen(false); return true
          }} />
          <div className="mt-settings" data-testid="model-thinking-settings">
          {/* ---- 上半：档位 ---- */}
          {showThinkingSection ? (
            <div className="mt-head">
              <div className="mt-head-row">
                <span className="mt-head-title" title={t('picker.thinkDesc')}>{t('picker.think')}</span>
                <span className="spacer" />
                <span
                  className="mt-head-level"
                  data-level={hasLevels ? headLevel : level}
                  data-testid="thinking-current"
                  /*
                   * D10：头部只用**短状态词**。
                   * 完整说明在下面的 `mt-capability-note` 里，两边写同一句话
                   * 会让用户看到“同一提示重复两遍”（截图证据：
                   * `docs/design/preview/matrix-modelmenu-1440x900-100-dark-2026-09-16.png`）。
                   */
                  title={
                    hasLevels
                      ? t('picker.thinkDesc')
                      : thinkingStatus === 'unsupported' || notDeclared
                        ? t('picker.thinkUnsupported')
                        : t('picker.thinkUnknown')
                  }
                >
                  {hasLevels
                    ? <span key={headLevel} className="ui-step-value">{thinkLabel(headLevel)}</span>
                    : thinkingStatus === 'unsupported' || notDeclared
                      ? t('picker.thinkUnsupportedShort')
                      : t('picker.thinkUnknownShort')}
                </span>
              </div>

              {/* 档位按钮：一个方块 = 一档。终端风格的等宽分段。
                  `--i` 让它们从左到右依次落位（像终端打印出来）。 */}
              {hasLevels ? (
                <StepSlider
                  values={levels}
                  value={levels.includes(level) ? level : levels[0]}
                  onChange={(l) => void setThinking(l)}
                  label={t('picker.think')}
                  format={thinkLabel}
                  colorOf={(l) => `var(--think-${l}, var(--accent))`}
                  disabled={busy}
                  testId="thinking-stops"
                  stopTestId={(l) => `thinking-dot-${l}`}
                  onPreview={setPreviewLevel}
                />
              ) : (
                <div className="mt-capability-note" data-testid="thinking-capability-status">
                  {notDeclared
                    ? customProvider ? t('picker.thinkNotDeclaredCustom') : t('picker.thinkNotDeclared')
                    : thinkingStatus === 'unsupported' ? t('picker.thinkUnsupported') : t('picker.thinkUnknown')}
                  {notDeclared && customProvider ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-capability-action"
                      data-testid="thinking-open-settings"
                      onClick={() => { setOpen(false); useStore.getState().openSettings('auth') }}
                    >
                      {t('picker.thinkOpenSettings')}
                    </Button>
                  ) : null}
                </div>
              )}

            </div>
          ) : null}

          {/*
           * ---- 回复详细程度（方案 3.1）----
           * 与推理强度是**两件事**：一个管「想多深」，一个管「讲多细」。
           * 放在同一个菜单里，因为它们是同一个决定（要多少篇幅）。
           */}
          {/* 标题与说明在左，滚轮在右：说明不再单独占一行 */}
          <div className="mt-head mt-detail">
            <div className="mt-detail-copy">
              <div className="mt-head-row">
                <span className="mt-head-title" title={t('picker.detailDesc')}>{t('picker.detail')}</span>
                <span className="spacer" />
                <span className="mt-head-level" data-testid="detail-current">
                  {detailLabel(responseDetail, t)}
                </span>
              </div>
            </div>
            <WheelPicker values={['brief', 'standard', 'detailed'] as const} value={responseDetail}
              onChange={detail => { void patchSettings({ responseDetail: detail }).catch(error => useStore.getState().notify('error', String(error))) }}
              format={detail => detailLabel(detail, t)} label={t('picker.detail')} disabled={busy} testId="detail-stops" />
          </div>
          {/* 可视化回答：图表、卡片、图解等由砚画出来；关掉后下一轮起模型不再使用，已有历史照常显示 */}
          <div className="mt-head mt-detail mt-visual">
            <div className="mt-detail-copy">
              <div className="mt-head-row">
                <span className="mt-head-title" title={t('picker.visualDesc')}>{t('picker.visual')}</span>
              </div>
            </div>
            <Switch checked={visualAnswers} label={t('picker.visual')} testId="visual-answers-toggle"
              onChange={on => { void patchSettings({ visualAnswers: on }).catch(error => useStore.getState().notify('error', String(error))) }} />
          </div>
          </div>
        </div>, document.body
      ) : null}
    </div>
  )
}

/**
 * 回复详细程度的中文名（方案 3.1）。
 *
 * 三档都说清「它对输出做了什么」，不用「简短 / 正常 / 啰嗦」这类
 * 带评价的词 —— 用户选的是篇幅，不是质量。
 */
function detailLabel(v: string, t: (k: 'detail.brief' | 'detail.standard' | 'detail.detailed') => string): string {
  if (v === 'brief') return t('detail.brief')
  if (v === 'detailed') return t('detail.detailed')
  return t('detail.standard')
}
