import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons/Icon'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { Button, Input, Segmented, StepSlider, Switch, WheelPicker } from './ui'
import { ModelCatalog } from './ModelCatalog'
import { SessionQuestionFrequencyPicker } from './SessionQuestionFrequencyPicker'
import { useFocusTrap, useModalLayer } from '../lib/modalLayer'
import { useAnchoredPopover } from '../lib/useAnchoredPopover'

const TEMP_DEFAULT = 'default'
const TEMP_STEPS = Array.from({ length: 21 }, (_, i) => String(i / 10))
const tempLabel = (value: string): string => {
  const n = Number(value)
  return Math.abs(n * 10 - Math.round(n * 10)) < 1e-9 ? n.toFixed(1) : n.toFixed(2)
}

function hasLevelsOn(levels: readonly string[], level: string): boolean {
  return levels.length > 1 && level !== 'off'
}

export function ModelThinkingPicker() {
  const t = useT()
  const session = useStore((s) => s.session)
  const levels = useStore((s) => s.thinkingLevels)
  const setModel = useStore((s) => s.setModel)
  const setThinking = useStore((s) => s.setThinking)
  const authProviders = useStore((s) => s.authProviders)
  const loadAuthProviders = useStore((s) => s.loadAuthProviders)
  const patchSettings = useStore((s) => s.patchSettings)
  const responseDetail = useStore((s) => s.settings?.responseDetail ?? 'standard')
  const visualAnswers = useStore((s) => s.settings?.visualAnswers) !== false
  const rememberedModel = useStore(s => s.settings?.lastMainModel)
  const models = useStore(s => s.models)
  const temperatureByModel = useStore(s => s.settings?.temperatureByModel)
  const [tempDraft, setTempDraft] = useState('')
  const [recoveryError, setRecoveryError] = useState('')
  const [recovering, setRecovering] = useState(false)

  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const position = useAnchoredPopover(open, box, 420, 680)
  const maxH = position.maxHeight
  const { isTop } = useModalLayer(open, () => setOpen(false))
  useFocusTrap(menu, open, isTop)

  const cur = session?.model && session.model.id !== 'unknown' && session.model.name !== 'unknown' ? session.model : undefined
  const level = session?.thinkingLevel ?? 'off'
  const [previewLevel, setPreviewLevel] = useState<string | null>(null)
  const headLevel = previewLevel ?? level
  const thinkingStatus = session?.thinkingLevelsStatus ?? (levels.length ? 'known' : 'unknown')
  const busy = !!session?.isStreaming || !!session?.isCompacting
  const thinkingOn = hasLevelsOn(levels, level)
  const tempKey = cur ? `${cur.provider}/${cur.id}` : ''
  const temp = tempKey ? temperatureByModel?.[tempKey] : undefined
  const tempValue = temp === undefined ? TEMP_DEFAULT : String(temp)
  const tempValues = TEMP_STEPS.includes(tempValue) || tempValue === TEMP_DEFAULT
    ? [TEMP_DEFAULT, ...TEMP_STEPS]
    : [TEMP_DEFAULT, ...[...TEMP_STEPS, tempValue].sort((a, b) => Number(a) - Number(b))]
  const applyTemp = (next: number | undefined): void => {
    if (!tempKey) return
    const table = { ...temperatureByModel }
    if (next === undefined) delete table[tempKey]
    else table[tempKey] = next
    void patchSettings({ temperatureByModel: table }).catch(error => useStore.getState().notify('error', String(error)))
  }
  useEffect(() => { setTempDraft(temp === undefined ? '' : tempLabel(String(temp))) }, [temp, tempKey])
  const commitTempDraft = (): void => {
    const text = tempDraft.trim().replace(',', '.')
    if (!text) { applyTemp(undefined); return }
    const n = Number(text)
    if (!Number.isFinite(n)) { setTempDraft(temp === undefined ? '' : tempLabel(String(temp))); return }
    applyTemp(Math.round(Math.min(2, Math.max(0, n)) * 100) / 100)
  }

  useEffect(() => {
    if (open) void loadAuthProviders()
  }, [open, loadAuthProviders])

  const needsAuth = (provider: string): boolean => {
    if (authProviders.length === 0) return false
    const info = authProviders.find((p) => p.id === provider || p.authKey === provider)
    return !!info && info.status !== 'ready'
  }

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

  const hasLevels = levels.length > 1
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
          {showThinkingSection ? (
            <div className="mt-head">
              <div className="mt-head-row">
                <span className="mt-head-title" title={t('picker.thinkDesc')}>{t('picker.think')}</span>
                <span className="spacer" />
                <span
                  className="mt-head-level"
                  data-level={hasLevels ? headLevel : level}
                  data-testid="thinking-current"
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

          <div className="mt-lines">
            <div className="mt-line mt-detail">
              <span className="mt-head-title" title={t('picker.detailDesc')}>{t('picker.detail')}</span>
              <Segmented size="sm" label={t('picker.detail')} testId="detail-stops" value={responseDetail as 'brief' | 'standard' | 'detailed'}
                options={(['brief', 'standard', 'detailed'] as const).map(detail => ({ value: detail, label: detailLabel(detail, t), testId: `detail-${detail}`, disabled: busy }))}
                onChange={detail => { void patchSettings({ responseDetail: detail }).catch(error => useStore.getState().notify('error', String(error))) }} />
            </div>
            {thinkingOn ? null : <>
              <div className="mt-line mt-temp">
                <span className="mt-head-title" title={t('picker.tempDesc')}>{t('picker.temp')}</span>
                <div className="mt-temp-ctl">
                  <WheelPicker values={tempValues} value={tempValue} label={t('picker.temp')} testId="temperature-wheel" stopTestPrefix="temperature"
                    disabled={!cur}
                    format={value => value === TEMP_DEFAULT ? t('picker.tempDefault') : tempLabel(value)}
                    onChange={value => applyTemp(value === TEMP_DEFAULT ? undefined : Number(value))} />
                  <Input numeric inputMode="decimal" aria-label={t('picker.temp')} data-testid="temperature-input"
                    placeholder={t('picker.tempDefault')} disabled={!cur} value={tempDraft}
                    onChange={event => setTempDraft(event.target.value)} onBlur={commitTempDraft}
                    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitTempDraft() } }} />
                </div>
              </div>
            </>}
            <div className="mt-line mt-visual">
              <span className="mt-head-title" title={t('picker.visualDesc')}>{t('picker.visual')}</span>
              <Switch checked={visualAnswers} label={t('picker.visual')} testId="visual-answers-toggle"
                onChange={on => { void patchSettings({ visualAnswers: on }).catch(error => useStore.getState().notify('error', String(error))) }} />
            </div>
            <SessionQuestionFrequencyPicker />
          </div>
          </div>
        </div>, document.body
      ) : null}
    </div>
  )
}

function detailLabel(v: string, t: (k: 'detail.brief' | 'detail.standard' | 'detail.detailed') => string): string {
  if (v === 'brief') return t('detail.brief')
  if (v === 'detailed') return t('detail.detailed')
  return t('detail.standard')
}
