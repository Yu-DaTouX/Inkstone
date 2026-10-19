import { useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import type { AppSettings } from '../../../../../shared/ipc'
import { FONT_UI_DEFAULT, resolveUiDensity, sanitizeFontName } from '../../../../../shared/appearance'
import { useStore } from '../../../state/store'
import { Switch, TextField } from '../../../ui'
import { asciiBackgroundEnabled, asciiBackgroundPatch } from '../../ambient/ascii-field-model'
import { settingsText } from '../settings-text'
import { generalText } from '../general/general-text'
import { Segmented, SettingsMore, SettingsReveal, SettingsRow } from '../root/controls'
import { codeFontChoice } from '../../../lib/appearance-v3'

type FontChoice = 'sans' | 'serif' | 'maple' | 'mono' | 'custom'
type SendKeyChoice = 'enter' | 'ctrlEnter'

function fontPatch(kind: 'ui' | 'code', preset: string, custom?: string): Partial<AppSettings> {
  return (
    kind === 'ui'
      ? { fontUi: preset, ...(custom !== undefined ? { fontUiCustom: custom } : {}) }
      : { fontCode: preset, ...(custom !== undefined ? { fontCodeCustom: custom } : {}) }
  ) as Partial<AppSettings>
}

function FontRow({ kind }: { kind: 'ui' | 'code' }): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const patchSettings = useStore((s) => s.patchSettings)
  const uiPreset = useStore((s) => s.settings?.fontUi)
  const codePreset = useStore((s) => s.settings?.fontCode)
  const uiCustom = useStore((s) => s.settings?.fontUiCustom)
  const codeCustom = useStore((s) => s.settings?.fontCodeCustom)
  const preset: string = kind === 'ui' ? uiPreset ?? 'sans' : codeFontChoice(codePreset)
  const custom = (kind === 'ui' ? uiCustom : codeCustom) ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? custom
  const valid = shown === '' || sanitizeFontName(shown) !== undefined
  const settingId = kind === 'ui' ? 'appearance-font-read' : 'appearance-font-code'

  useEffect(() => {
    setDraft(null)
  }, [preset])

  const commit = (): void => {
    if (draft === null) return
    const clean = draft === '' ? '' : sanitizeFontName(draft)
    if (clean === undefined) return
    setDraft(null)
    if (clean === custom) return
    void patchSettings(fontPatch(kind, 'custom', clean))
  }

  const options: readonly { value: FontChoice; label: string }[] =
    kind === 'ui'
      ? [
          { value: 'sans', label: text.fontSans },
          { value: 'serif', label: text.fontSerif },
          { value: 'maple', label: text.fontMaple },
          { value: 'custom', label: text.fontCustom }
        ]
      : [
          { value: 'mono', label: `${text.fontMono}（${text.fontDefault}）` },
          { value: 'maple', label: text.fontMaple },
          { value: 'custom', label: text.fontCustom }
        ]

  return (
    <>
      <SettingsRow
        block
        settingId={settingId}
        label={kind === 'ui' ? text.fontRead : text.fontCode}
        description={kind === 'ui' ? text.fontReadDesc : text.fontCodeDesc}
      >
        <Segmented
          label={kind === 'ui' ? text.fontRead : text.fontCode}
          value={preset as FontChoice}
          options={options}
          onChange={(value) => {
            if (value !== 'custom') setDraft(null)
            void patchSettings(fontPatch(kind, value))
          }}
        />
      </SettingsRow>
      <SettingsReveal open={preset === 'custom'}>
        <SettingsRow
          nested
          settingId={`${settingId}-custom`}
          label={text.fontCustom}
          description={
            !valid ? <span className="settings-row__desc--error">{text.fontInvalid}</span> : undefined
          }
        >
          <TextField
            className="settings-font-field"
            value={shown}
            maxLength={64}
            placeholder={text.fontCustomPlaceholder}
            aria-label={text.fontCustom}
            isInvalid={!valid}
            onChange={setDraft}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit()
              }
            }}
          />
        </SettingsRow>
      </SettingsReveal>
    </>
  )
}

function SwitchRow({
  settingId,
  label,
  description,
  isSelected,
  onChange,
  testId
}: {
  settingId: string
  label: string
  description: string
  isSelected: boolean
  onChange: (next: boolean) => void
  testId: string
}): ReactElement {
  return (
    <SettingsRow settingId={settingId} label={label} description={description}>
      <Switch aria-label={label} isSelected={isSelected} onChange={onChange} data-testid={testId} />
    </SettingsRow>
  )
}

export function AppearanceSettings(): ReactElement {
  const { lang, setLang } = useI18n()
  const text = settingsText(lang)
  const general = generalText(lang)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const theme = settings?.theme ?? 'dark'
  const density = resolveUiDensity(settings?.density, settings?.fontSizeUi)
  const reduceMotion = settings?.reduceMotion === true
  const sendKey: SendKeyChoice = settings?.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter'
  const tiles = settings?.workspaceTiles !== false
  const smoothText = settings?.smoothText !== false

  return (
    <section className="settings-section" aria-label={text.sectionAppearance}>
      <div className="settings-rows">
        <SettingsRow settingId="appearance-theme" label={text.theme}>
          <Segmented
            label={text.theme}
            value={theme}
            options={[
              { value: 'light', label: text.themeLight, testId: 'v3-theme-light' },
              { value: 'dark', label: text.themeDark, testId: 'v3-theme-dark' }
            ]}
            onChange={(value) => void patchSettings({ theme: value })}
          />
        </SettingsRow>

        <SettingsRow settingId="appearance-language" label={text.language}>
          <Segmented
            label={text.language}
            value={lang}
            options={[
              { value: 'zh-CN', label: '中文' },
              { value: 'en-US', label: 'English' }
            ]}
            onChange={(value) => {
              setLang(value)
              void patchSettings({ lang: value })
            }}
          />
        </SettingsRow>

        <SettingsRow settingId="appearance-density" label={text.density} description={text.densityDesc}>
          <Segmented
            label={text.density}
            value={density}
            options={[
              { value: 'compact', label: text.densityCompact, testId: 'v3-density-compact' },
              { value: 'comfortable', label: text.densityComfortable, testId: 'v3-density-comfortable' }
            ]}
            onChange={(value) => void patchSettings({ density: value, fontSizeUi: FONT_UI_DEFAULT })}
          />
        </SettingsRow>

        <SwitchRow
          settingId="appearance-workspace-tiles"
          label={text.workspaceTiles}
          description={text.workspaceTilesDesc}
          isSelected={tiles}
          onChange={(next) => void patchSettings({ workspaceTiles: next }).catch(() => undefined)}
          testId="v3-workspace-tiles-toggle"
        />

        <SettingsRow
          settingId="appearance-send-key"
          label={general.appearanceSendKey}
          description={general.appearanceSendKeyDesc}
        >
          <Segmented
            label={general.appearanceSendKey}
            value={sendKey}
            options={[
              { value: 'enter', label: general.appearanceSendKeyEnter, testId: 'v3-send-key-enter' },
              { value: 'ctrlEnter', label: general.appearanceSendKeyCtrl, testId: 'v3-send-key-ctrl' }
            ]}
            onChange={(value) => void patchSettings({ sendKey: value })}
          />
        </SettingsRow>
      </div>

      <SettingsMore>
        <div className="settings-rows">
          <FontRow kind="ui" />
          <FontRow kind="code" />
          <SwitchRow
            settingId="appearance-reduce-motion"
            label={text.reduceMotion}
            description={text.reduceMotionDesc}
            isSelected={reduceMotion}
            onChange={(next) => void patchSettings({ reduceMotion: next }).catch(() => undefined)}
            testId="v3-reduce-motion-toggle"
          />
          <SwitchRow
            settingId="appearance-ascii-background"
            label={text.asciiBackground}
            description={text.asciiBackgroundDesc}
            isSelected={asciiBackgroundEnabled(settings)}
            onChange={(next) => void patchSettings(asciiBackgroundPatch(next)).catch(() => undefined)}
            testId="v3-ascii-background-toggle"
          />
          <SwitchRow
            settingId="appearance-smooth-text"
            label={text.smoothText}
            description={text.smoothTextDesc}
            isSelected={smoothText}
            onChange={(next) => void patchSettings({ smoothText: next }).catch(() => undefined)}
            testId="v3-smooth-text-toggle"
          />
        </div>
      </SettingsMore>
    </section>
  )
}
