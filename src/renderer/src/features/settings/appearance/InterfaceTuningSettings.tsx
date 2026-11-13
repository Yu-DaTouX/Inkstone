import { useEffect, useState, type ReactElement } from 'react'
import { RotateCcw } from '../../../ui/icons'
import { useI18n } from '../../../i18n'
import type { AppSettings } from '../../../../../shared/ipc'
import {
  CONTRAST_DEFAULT,
  CONTRAST_MAX,
  CONTRAST_MIN,
  GLASS_OPACITY_DEFAULT,
  GLASS_OPACITY_MAX,
  GLASS_OPACITY_MIN,
  PANEL_MOTION_DEFAULT,
  PANEL_MOTION_MAX,
  PANEL_MOTION_MIN,
  WINDOW_GLASS_OPACITY_DEFAULT,
  WINDOW_GLASS_OPACITY_MAX,
  WINDOW_GLASS_OPACITY_MIN,
  type WindowGlass
} from '../../../../../shared/appearance'
import { useStore } from '../../../state/store'
import { IconButton, Slider, Switch } from '../../../ui'
import { fileViewSettingsStore } from '../../preview/use-file-view-settings'
import { Segmented, SettingsGroup, SettingsRow } from '../root/controls'
import './interface-tuning-settings.css'

interface TuningText {
  group: string
  window: string
  windowDesc: string
  windowSide: string
  windowFull: string
  windowOff: string
  windowOpacity: string
  windowOpacityDesc: string
  glass: string
  glassDesc: string
  contrast: string
  contrastDesc: string
  wrap: string
  wrapDesc: string
  panel: string
  panelDesc: string
  instant: string
  reset: (name: string) => string
}

const TEXT: Record<'zh-CN' | 'en-US', TuningText> = {
  'zh-CN': {
    group: '界面',
    window: '窗口玻璃',
    windowDesc: 'Windows 11 上透出模糊的桌面：只给左栏，或整个窗口。',
    windowSide: '仅左栏',
    windowFull: '全窗口',
    windowOff: '关闭',
    windowOpacity: '窗口不透明度',
    windowOpacityDesc: '越大越实，桌面透出得越少。',
    glass: '毛玻璃不透明度',
    glassDesc: '越大越实，越少透出背后内容。',
    contrast: '对比度',
    contrastDesc: '整体调强或调弱次要文字和边框的颜色。',
    wrap: '代码自动换行',
    wrapDesc: '代码块、diff 和预览默认折行，每块可单独切换。',
    panel: '面板动画时长',
    panelDesc: '侧栏和会话栏开合速度，0 为立即。',
    instant: '立即',
    reset: (name) => `恢复默认${name}`
  },
  'en-US': {
    group: 'Interface',
    window: 'Window glass',
    windowDesc: 'On Windows 11, show the blurred desktop behind the sidebar or the whole window.',
    windowSide: 'Sidebar',
    windowFull: 'Whole window',
    windowOff: 'Off',
    windowOpacity: 'Window opacity',
    windowOpacityDesc: 'Higher is more solid; less desktop shows through.',
    glass: 'Glass opacity',
    glassDesc: 'Higher is more solid, less see-through.',
    contrast: 'Contrast',
    contrastDesc: 'Strength of secondary text and borders.',
    wrap: 'Word wrap',
    wrapDesc: 'Wrap long lines in code, diffs and previews; toggle per block.',
    panel: 'Panel animations',
    panelDesc: 'Sidebar and session bar speed; 0 is instant.',
    instant: 'Instant',
    reset: (name) => `Reset ${name.toLowerCase()}`
  }
}

type NumberKey = 'glassOpacity' | 'windowGlassOpacity' | 'contrast' | 'panelMotionMs'

const SETTING_IDS: Record<NumberKey, string> = { glassOpacity: 'appearance-glass-opacity', windowGlassOpacity: 'appearance-window-glass-opacity', contrast: 'appearance-contrast', panelMotionMs: 'appearance-panel-motion' }

function reportSaveFailure(error: unknown): void {
  useStore.getState().notify('error', error instanceof Error ? error.message : String(error))
}

function SliderRow({ settingKey, label, description, min, max, step, fallback, format, resetLabel }: {
  settingKey: NumberKey
  label: string
  description: string
  min: number
  max: number
  step: number
  fallback: number
  format: (value: number) => string
  resetLabel: string
}): ReactElement {
  const saved = useStore((s) => s.settings?.[settingKey])
  const patchSettings = useStore((s) => s.patchSettings)
  const [draft, setDraft] = useState<number | null>(null)
  useEffect(() => setDraft(null), [saved])
  const value = draft ?? saved ?? fallback
  const save = (next: number | undefined): void => {
    void patchSettings({ [settingKey]: next } as Partial<AppSettings>).catch(reportSaveFailure)
  }
  return (
    <SettingsRow settingId={SETTING_IDS[settingKey]} label={label} description={description}>
      <div className="tuning-control">
        {saved !== undefined ? (
          <IconButton size="sm" aria-label={resetLabel} tooltip={resetLabel} onPress={() => save(undefined)} data-testid={`v3-reset-${settingKey}`}>
            <RotateCcw size={13} aria-hidden />
          </IconButton>
        ) : null}
        <Slider
          className="tuning-slider"
          aria-label={label}
          minValue={min}
          maxValue={max}
          step={step}
          value={value}
          onChange={(next) => setDraft(Array.isArray(next) ? next[0] : next)}
          onChangeEnd={(next) => save(Array.isArray(next) ? next[0] : next)}
          data-testid={`v3-slider-${settingKey}`}
        />
        <output className="tuning-value ui-num" aria-hidden>{format(value)}</output>
      </div>
    </SettingsRow>
  )
}

export function InterfaceTuningSettings(): ReactElement {
  const { lang } = useI18n()
  const text = TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  const codeWrap = useStore((s) => s.settings?.codeWrap !== false)
  const patchSettings = useStore((s) => s.patchSettings)
  const windowGlass: WindowGlass = useStore((s) => s.settings?.windowGlass ?? 'side')
  const setWrap = (next: boolean): void => {
    fileViewSettingsStore().set('wordWrap', next)
    void patchSettings({ codeWrap: next ? undefined : false }).catch(reportSaveFailure)
  }
  return (
    <SettingsGroup title={text.group}>
      <SettingsRow settingId="appearance-window-glass" label={text.window} description={text.windowDesc}>
        <Segmented
          label={text.window}
          value={windowGlass}
          options={[
            { value: 'side', label: text.windowSide, testId: 'v3-window-glass-side' },
            { value: 'full', label: text.windowFull, testId: 'v3-window-glass-full' },
            { value: 'off', label: text.windowOff, testId: 'v3-window-glass-off' }
          ]}
          onChange={(next) => void patchSettings({ windowGlass: next === 'side' ? undefined : next }).catch(reportSaveFailure)}
        />
      </SettingsRow>
      {windowGlass !== 'off' ? (
        <SliderRow
          settingKey="windowGlassOpacity"
          label={text.windowOpacity}
          description={text.windowOpacityDesc}
          min={WINDOW_GLASS_OPACITY_MIN}
          max={WINDOW_GLASS_OPACITY_MAX}
          step={5}
          fallback={WINDOW_GLASS_OPACITY_DEFAULT}
          format={(value) => `${value}%`}
          resetLabel={text.reset(text.windowOpacity)}
        />
      ) : null}
      <SliderRow
        settingKey="glassOpacity"
        label={text.glass}
        description={text.glassDesc}
        min={GLASS_OPACITY_MIN}
        max={GLASS_OPACITY_MAX}
        step={5}
        fallback={GLASS_OPACITY_DEFAULT}
        format={(value) => `${value}%`}
        resetLabel={text.reset(text.glass)}
      />
      <SliderRow
        settingKey="contrast"
        label={text.contrast}
        description={text.contrastDesc}
        min={CONTRAST_MIN}
        max={CONTRAST_MAX}
        step={5}
        fallback={CONTRAST_DEFAULT}
        format={(value) => `${value}%`}
        resetLabel={text.reset(text.contrast)}
      />
      <SettingsRow settingId="appearance-code-wrap" label={text.wrap} description={text.wrapDesc}>
        <Switch aria-label={text.wrap} isSelected={codeWrap} onChange={setWrap} data-testid="v3-code-wrap-toggle" />
      </SettingsRow>
      <SliderRow
        settingKey="panelMotionMs"
        label={text.panel}
        description={text.panelDesc}
        min={PANEL_MOTION_MIN}
        max={PANEL_MOTION_MAX}
        step={50}
        fallback={PANEL_MOTION_DEFAULT}
        format={(value) => (value === 0 ? text.instant : `${value}ms`)}
        resetLabel={text.reset(text.panel)}
      />
    </SettingsGroup>
  )
}
