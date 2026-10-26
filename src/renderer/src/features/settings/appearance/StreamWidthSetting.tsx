import { useEffect, useState, type ReactElement } from 'react'
import { STREAM_WIDTH_MAX, STREAM_WIDTH_MIN, sanitizeStreamWidth } from '../../../../../shared/appearance'
import tokens from '../../../design/tokens.json'
import { useT } from '../../../i18n'
import { applyAppearanceV3 } from '../../../lib/appearance-v3'
import { useStore } from '../../../state/store'
import { Button, Slider } from '../../../ui'
import { SettingsRow } from '../root/controls'

export function StreamWidthSetting(): ReactElement {
  const t = useT()
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const [draft, setDraft] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const saved = sanitizeStreamWidth(settings?.streamWidth) ?? tokens.size.chat
  const shown = draft ?? saved

  useEffect(() => {
    if (settings) applyAppearanceV3(document.documentElement, { ...settings, streamWidth: draft ?? settings.streamWidth })
  }, [settings, draft])

  useEffect(() => () => {
    const current = useStore.getState().settings
    if (current) applyAppearanceV3(document.documentElement, current)
  }, [])

  const save = async (width: number | undefined): Promise<void> => {
    setSaving(true)
    try {
      await patchSettings({ streamWidth: width })
    } catch {
    } finally {
      setDraft(null)
      setSaving(false)
    }
  }

  return (
    <SettingsRow settingId="appearance-stream-width" label={t('set.streamWidth')} description={t('set.streamWidthDesc')}>
      <Slider
        className="settings-slider"
        aria-label={t('set.streamWidth')}
        value={shown}
        minValue={STREAM_WIDTH_MIN}
        maxValue={STREAM_WIDTH_MAX}
        step={16}
        showValue
        isDisabled={saving}
        onChange={(value) => setDraft(Array.isArray(value) ? value[0] : value)}
        onChangeEnd={(value) => void save(Array.isArray(value) ? value[0] : value)}
        data-testid="v3-stream-width"
      />
      {draft !== null || settings?.streamWidth !== undefined ? (
        <Button variant="ghost" size="sm" aria-label={t('set.streamWidthReset')} isDisabled={saving} onPress={() => void save(undefined)}>
          {t('set.streamWidthDefault', { n: tokens.size.chat })}
        </Button>
      ) : null}
    </SettingsRow>
  )
}
