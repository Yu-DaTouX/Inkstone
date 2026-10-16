import { useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import type { AppSettings } from '../../../../../shared/ipc'
import {
  FONT_UI_DEFAULT,
  FONT_UI_MAX,
  FONT_UI_MIN,
  sanitizeFontName
} from '../../../../../shared/appearance'
import { useStore } from '../../../state/store'
import { Button, Switch } from '../../../ui'
import { prefersReducedMotion } from '../../../lib/usePresence'
import { asciiBackgroundEnabled, asciiBackgroundPatch } from '../../ambient/ascii-field-model'
import { settingsText } from '../settings-text'
import { Segmented, SettingsRow } from '../root/controls'
import { useSwitchToV2 } from '../root/use-switch-to-v2'

type Density = 'compact' | 'standard' | 'comfortable'
type FontChoice = 'sans' | 'serif' | 'maple' | 'mono' | 'custom'

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
  const preset: string = (kind === 'ui' ? uiPreset : codePreset) ?? (kind === 'ui' ? 'sans' : 'maple')
  const custom = (kind === 'ui' ? uiCustom : codeCustom) ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? custom
  const valid = shown === '' || sanitizeFontName(shown) !== undefined

  useEffect(() => {
    setDraft(null)
  }, [preset])

  const commit = (): void => {
    if (draft === null) return
    const clean = draft === '' ? '' : sanitizeFontName(draft)
    if (clean === undefined) return
    setDraft(null)
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
          { value: 'maple', label: `${text.fontMaple}（${text.fontDefault}）` },
          { value: 'mono', label: text.fontMono },
          { value: 'custom', label: text.fontCustom }
        ]

  return (
    <SettingsRow
      block
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
      {preset === 'custom' ? (
        <div className="settings-font-custom">
          <input
            className="settings-input"
            value={shown}
            spellCheck={false}
            maxLength={64}
            placeholder={text.fontCustomPlaceholder}
            aria-label={text.fontCustom}
            aria-invalid={!valid}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit()
              }
            }}
          />
          {!valid ? <span className="settings-row__desc settings-row__desc--error">{text.fontInvalid}</span> : null}
        </div>
      ) : null}
    </SettingsRow>
  )
}

function UiSizeRow(): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const patchSettings = useStore((s) => s.patchSettings)
  const saved = useStore((s) => s.settings?.fontSizeUi) ?? FONT_UI_DEFAULT
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? saved

  return (
    <SettingsRow label={text.fontSizeUi} description={text.fontSizeNow.replace('{n}', String(shown))}>
      <input
        className="settings-range"
        type="range"
        min={FONT_UI_MIN}
        max={FONT_UI_MAX}
        step={1}
        value={shown}
        aria-label={text.fontSizeUi}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={(event) => {
          const value = Number((event.target as HTMLInputElement).value)
          setDraft(null)
          void patchSettings({ fontSizeUi: value })
        }}
        onKeyUp={(event) => {
          const value = Number((event.target as HTMLInputElement).value)
          setDraft(null)
          void patchSettings({ fontSizeUi: value })
        }}
      />
    </SettingsRow>
  )
}

function SoundRow(): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const patchSettings = useStore((s) => s.patchSettings)
  const sound = useStore((s) => s.settings?.sound)
  const enabled = sound?.enabled ?? false
  const volume = sound?.volume ?? 0.4
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? volume

  const commit = (): void => {
    if (draft === null || !sound) return
    const next = draft
    setDraft(null)
    void patchSettings({ sound: { ...sound, volume: next } })
  }

  return (
    <>
      <SettingsRow label={text.soundEnable} description={text.soundEnableDesc}>
        <Switch
          aria-label={text.soundEnable}
          isSelected={enabled}
          onChange={(next) => {
            if (!sound) return
            void patchSettings({ sound: { ...sound, enabled: next } })
          }}
          data-testid="v3-sound-toggle"
        />
      </SettingsRow>
      <SettingsRow label={text.soundVolume} description={`${Math.round(shown * 100)}%`}>
        <input
          className="settings-range"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={shown}
          disabled={!enabled}
          aria-label={text.soundVolume}
          onChange={(event) => setDraft(Number(event.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
        />
      </SettingsRow>
    </>
  )
}

function DynamicBackgroundRow(): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const patchSettings = useStore((s) => s.patchSettings)
  const settings = useStore((s) => s.settings)
  const enabled = asciiBackgroundEnabled(settings)

  return (
    <SettingsRow label={text.asciiBackground} description={text.asciiBackgroundDesc}>
      <Switch
        aria-label={text.asciiBackground}
        isSelected={enabled}
        onChange={(next) => {
          void patchSettings(asciiBackgroundPatch(next)).catch(() => undefined)
        }}
        data-testid="v3-ascii-background-toggle"
      />
    </SettingsRow>
  )
}

function UiVersionRow(): ReactElement {
  const { lang } = useI18n()
  const text = settingsText(lang)
  const { env, busy, error, switchToV2 } = useSwitchToV2(lang)

  return (
    <SettingsRow block label={text.uiVersion} description={text.uiVersionNote}>
      <p className="settings-value">{env ? text.uiVersionEnv : text.uiVersionV3}</p>
      <Button
        variant="secondary"
        size="sm"
        isDisabled={busy || env}
        onPress={() => void switchToV2()}
        data-testid="v3-switch-v2"
      >
        {text.uiVersionBack}
      </Button>
      {error ? (
        <p className="settings-row__desc settings-row__desc--error" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  )
}

export function AppearanceSettings(): ReactElement {
  const { lang, setLang } = useI18n()
  const text = settingsText(lang)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const theme = settings?.theme ?? 'dark'
  const density = (settings?.density ?? 'standard') as Density

  return (
    <section className="settings-section" aria-label={text.sectionAppearance}>
      <p className="settings-note" role="note">
        {text.appearanceNote}
      </p>

      <SettingsRow label={text.theme}>
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

      <SettingsRow label={text.density}>
        <Segmented
          label={text.density}
          value={density}
          options={[
            { value: 'compact', label: text.densityCompact },
            { value: 'standard', label: text.densityStandard },
            { value: 'comfortable', label: text.densityComfortable }
          ]}
          onChange={(value) => void patchSettings({ density: value })}
        />
      </SettingsRow>

      <UiSizeRow />
      <FontRow kind="ui" />
      <FontRow kind="code" />

      <SettingsRow label={text.language}>
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

      <SoundRow />
      <DynamicBackgroundRow />

      <SettingsRow label={text.motion} description={text.motionNote}>
        <span className="settings-value">{prefersReducedMotion() ? text.motionReduced : text.motionFull}</span>
      </SettingsRow>

      <UiVersionRow />
    </section>
  )
}
