import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, Input, SettingRow } from '../ui'
import {
  BACKGROUND_PRESETS,
  CUSTOM_BACKGROUND_ID,
  applyBackground,
  backgroundLadder,
  clampBackground,
  customForTheme,
  isHexColor,
  type BackgroundTheme
} from '../../lib/background'
import { APPEARANCE_EVENT, applyTypography, listLocalFonts } from '../../lib/appearance'
import type { AppSettings } from '../../../../shared/ipc'
import { isCurrentGeneration } from './review2-settings-guards'
import {
  FONT_BODY_DEFAULT,
  FONT_BODY_MAX,
  FONT_BODY_MIN,
  FONT_UI_DEFAULT,
  FONT_UI_MAX,
  FONT_UI_MIN,
  fontCodeStack,
  fontUiStack,
  sanitizeFontName
} from '../../../../shared/appearance'

type TKey = Parameters<ReturnType<typeof useT>>[0]

const LADDER_TOKENS = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-4'] as const
const START_COLOR: Record<BackgroundTheme, string> = { dark: '#17191d', light: '#f6f7f9' }

function useDebounced(): (fn: () => void, ms: number) => void {
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<(() => void) | null>(null)
  useEffect(() => () => {
    window.clearTimeout(timer.current)
    pending.current?.()
    pending.current = null
  }, [])
  return (fn, ms) => {
    window.clearTimeout(timer.current)
    pending.current = fn
    timer.current = window.setTimeout(() => {
      const commit = pending.current
      pending.current = null
      commit?.()
    }, ms)
  }
}

export function BackgroundSetting() {
  const t = useT()
  const theme: BackgroundTheme = useStore((s) => s.settings?.theme) === 'light' ? 'light' : 'dark'
  const patchSettings = useStore((s) => s.patchSettings)
  const preset = useStore((s) => s.settings?.backgroundPreset) ?? 'default'
  const customDark = useStore((s) => s.settings?.backgroundCustom)
  const customLight = useStore((s) => s.settings?.backgroundCustomLight)
  const saved = customForTheme(customDark, customLight, theme)
  const [draft, setDraft] = useState<string | null>(null)
  const [hexText, setHexText] = useState<string | null>(null)
  const debounce = useDebounced()
  const revision = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const value = draft ?? saved ?? START_COLOR[theme]
  const active = preset === CUSTOM_BACKGROUND_ID
  const used = clampBackground(value, theme)
  const ladder = useMemo(() => backgroundLadder(used, theme), [used, theme])

  useEffect(() => {
    setDraft(null)
    setHexText(null)
  }, [theme])

  const preview = (hex: string): void => {
    const currentRevision = ++revision.current
    setDraft(hex)
    if (applyBackground(document.documentElement, CUSTOM_BACKGROUND_ID, hex, theme)) window.dispatchEvent(new Event(APPEARANCE_EVENT))
    debounce(() => {
      const key = theme === 'light' ? 'backgroundCustomLight' : 'backgroundCustom'
      void patchSettings({ backgroundPreset: CUSTOM_BACKGROUND_ID, [key]: hex }).then(() => {
        if (mounted.current && isCurrentGeneration(revision.current, currentRevision)) setDraft(null)
      }).catch(() => {
        if (mounted.current && isCurrentGeneration(revision.current, currentRevision)) setDraft(hex)
      })
    }, 250)
  }

  return (
    <SettingRow col name={t('set.background')} desc={t('set.backgroundDesc')} ctlClassName="bg-ctl" ctlProps={{ 'data-testid': 'set-background' }}>
      <div className="seg bg-presets" role="group" aria-label={t('set.background')}>
        {BACKGROUND_PRESETS.map((p) => {
          const swatch = p[theme]
          return (
            <button
              key={p.id}
              type="button"
              className={`seg-btn ${preset === p.id ? 'sel' : ''}`}
              data-background={p.id}
              aria-pressed={preset === p.id}
              onClick={() => void patchSettings({ backgroundPreset: p.id })}
            >
              <span className="bg-swatch" style={swatch ? { background: swatch } : undefined} aria-hidden />
              {t(p.key as TKey)}
            </button>
          )
        })}
        <button
          type="button"
          className={`seg-btn ${active ? 'sel' : ''}`}
          data-background={CUSTOM_BACKGROUND_ID}
          aria-pressed={active}
          onClick={() => void patchSettings({ backgroundPreset: CUSTOM_BACKGROUND_ID, ...(saved ? {} : { [theme === 'light' ? 'backgroundCustomLight' : 'backgroundCustom']: value }) })}
        >
          <span className="bg-swatch" style={{ background: used }} aria-hidden />
          {t('set.bg.custom')}
        </button>
      </div>

      <div className={`bg-custom-panel ${active ? 'on' : ''}`} data-testid="set-background-custom">
        <label className="bg-picker-wrap" title={t('set.bg.pick')} style={{ background: used, borderColor: ladder['--bg-4'] }}>
          <span className="bg-picker-tile" style={{ background: ladder['--bg-2'] }} aria-hidden>
            Aa
          </span>
          <input type="color" className="bg-picker" value={value} aria-label={t('set.bg.pick')} onChange={(e) => preview(e.target.value)} />
        </label>
        <div className="bg-custom-main">
          <div className="bg-custom-line">
            <span className="bg-custom-label">{t(theme === 'light' ? 'set.bg.customLight' : 'set.bg.customDark')}</span>
            <Input
              className="bg-hex"
              value={hexText ?? value}
              spellCheck={false}
              maxLength={7}
              aria-label={t('set.bg.hex')}
              aria-invalid={hexText !== null && !isHexColor(hexText)}
              onChange={(e) => {
                const text = e.target.value.trim()
                setHexText(text)
                const hex = text.startsWith('#') ? text : `#${text}`
                if (isHexColor(hex)) preview(hex.toLowerCase())
              }}
              onBlur={() => setHexText(null)}
            />
          </div>
          <div className="bg-ladder" aria-hidden>
            {LADDER_TOKENS.map((token) => (
              <span key={token} className="bg-ladder-step" style={{ background: ladder[token] }} />
            ))}
          </div>
          <div className="ui-row-desc">
            {used !== value.toLowerCase() ? t('set.bg.clamped', { hex: used }) : t('set.bg.customHint')}
          </div>
        </div>
      </div>
    </SettingRow>
  )
}

const UI_FONT_OPTS = [
  { v: 'maple', key: 'set.font.terminal' },
  { v: 'sans', key: 'set.font.sans' },
  { v: 'serif', key: 'set.font.serif' },
  { v: 'custom', key: 'set.font.custom' }
] as const
const CODE_FONT_OPTS = [
  { v: 'maple', key: 'set.font.maple' },
  { v: 'mono', key: 'set.font.mono' },
  { v: 'custom', key: 'set.font.custom' }
] as const

function FontRow({ kind }: { kind: 'ui' | 'code' }) {
  const t = useT()
  const patchSettings = useStore((s) => s.patchSettings)
  const preset = useStore((s) => (kind === 'ui' ? s.settings?.fontUi : s.settings?.fontCode)) ?? (kind === 'ui' ? 'sans' : 'maple')
  const custom = useStore((s) => (kind === 'ui' ? s.settings?.fontUiCustom : s.settings?.fontCodeCustom)) ?? ''
  const [text, setText] = useState<string | null>(null)
  const [fonts, setFonts] = useState<string[]>([])
  const debounce = useDebounced()
  const revision = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const patchFont = (choice: string, name?: string): Promise<void> =>
    patchSettings(
      (kind === 'ui'
        ? { fontUi: choice, ...(name !== undefined ? { fontUiCustom: name } : {}) }
        : { fontCode: choice, ...(name !== undefined ? { fontCodeCustom: name } : {}) }) as Partial<AppSettings>
    )
  const shown = text ?? custom
  const valid = shown === '' || sanitizeFontName(shown) !== undefined
  const stack = kind === 'ui' ? fontUiStack(preset, shown) : fontCodeStack(preset, shown)
  const listId = `set-font-list-${kind}`

  const commit = (name: string): void => {
    const clean = sanitizeFontName(name)
    if (name !== '' && !clean) return
    const currentRevision = ++revision.current
    void patchFont('custom', clean ?? '').then(() => {
      if (mounted.current && isCurrentGeneration(revision.current, currentRevision)) setText(null)
    }).catch(() => {
      if (mounted.current && isCurrentGeneration(revision.current, currentRevision)) setText(name)
    })
  }

  return (
    <SettingRow
      col
      name={t(kind === 'ui' ? 'set.fontUi' : 'set.fontCode')}
      desc={t(kind === 'ui' ? 'set.fontUiDesc' : 'set.fontCodeDesc')}
      ctlClassName="font-ctl"
      ctlProps={{ 'data-testid': `set-font-${kind}` }}
    >
      <div className="seg" role="group" aria-label={t(kind === 'ui' ? 'set.fontUi' : 'set.fontCode')}>
        {(kind === 'ui' ? UI_FONT_OPTS : CODE_FONT_OPTS).map((o) => (
          <button
            key={o.v}
            type="button"
            className={`seg-btn ${preset === o.v ? 'sel' : ''}`}
            data-font={o.v}
            aria-pressed={preset === o.v}
            onClick={() => void patchFont(o.v)}
          >
            {t(o.key as TKey)}
          </button>
        ))}
      </div>
      {preset === 'custom' ? (
        <div className="font-custom">
          <Input
            value={shown}
            list={listId}
            spellCheck={false}
            maxLength={64}
            placeholder={t('set.font.placeholder')}
            aria-label={t('set.font.custom')}
            aria-invalid={!valid}
            onFocus={() => void listLocalFonts().then(setFonts)}
            onChange={(e) => {
              const name = e.target.value
              setText(name)
              revision.current++
              debounce(() => commit(name), 500)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
            }}
          />
          <datalist id={listId}>
            {fonts.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          {!valid ? <span className="ui-row-desc font-invalid">{t('set.font.invalid')}</span> : null}
        </div>
      ) : null}
      <div className="font-sample" style={{ fontFamily: stack }} aria-hidden>
        {kind === 'ui' ? t('set.font.sampleUi') : 'const answer = 42 // 代码 0O1lI'}
      </div>
    </SettingRow>
  )
}

export function FontSettings() {
  return (
    <>
      <FontRow kind="ui" />
      <FontRow kind="code" />
    </>
  )
}

function SizeRow({ kind }: { kind: 'body' | 'ui' }) {
  const t = useT()
  const patchSettings = useStore((s) => s.patchSettings)
  const key = kind === 'body' ? 'fontSizeBody' : 'fontSizeUi'
  const [min, max, fallback] = kind === 'body' ? [FONT_BODY_MIN, FONT_BODY_MAX, FONT_BODY_DEFAULT] : [FONT_UI_MIN, FONT_UI_MAX, FONT_UI_DEFAULT]
  const saved = useStore((s) => s.settings?.[key]) ?? fallback
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? saved
  useEffect(() => setDraft(null), [saved])

  const preview = (v: number): void => {
    setDraft(v)
    if (applyTypography(document.documentElement, { ...(useStore.getState().settings ?? {}), [key]: v })) {
      window.dispatchEvent(new Event(APPEARANCE_EVENT))
      window.dispatchEvent(new Event('yan:stream-width'))
    }
  }
  const commit = (v: number): void => void patchSettings({ [key]: v })

  return (
    <SettingRow
      name={t(kind === 'body' ? 'set.fontSizeBody' : 'set.fontSizeUi')}
      desc={<span data-testid={`set-font-size-${kind}-now`}>{t('set.fontSizeNow', { n: shown })}</span>}
      ctlClassName="stream-width-ctl"
      ctlProps={{ 'data-testid': `set-font-size-${kind}` }}
    >
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={1}
        value={shown}
        aria-label={t(kind === 'body' ? 'set.fontSizeBody' : 'set.fontSizeUi')}
        onChange={(e) => preview(Number(e.target.value))}
        onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
      />
      <Button size="sm" variant="ghost" onClick={() => void patchSettings({ [key]: fallback })} disabled={saved === fallback && draft === null}>
        {t('set.reset')}
      </Button>
    </SettingRow>
  )
}

export function FontSizeSettings() {
  return (
    <>
      <SizeRow kind="body" />
      <SizeRow kind="ui" />
    </>
  )
}
