import { useEffect, useState, type ReactElement } from 'react'
import { STREAM_WIDTH_MAX, STREAM_WIDTH_MIN, sanitizeStreamWidth } from '../../../../../shared/appearance'
import tokens from '../../../design/tokens.json'
import { useT } from '../../../i18n'
import { applyAppearanceV3 } from '../../../lib/appearance-v3'
import { useStore } from '../../../state/store'
import { SettingsRange, SettingsRow } from '../root/controls'

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
      <SettingsRange
        label={t('set.streamWidth')}
        value={shown}
        min={STREAM_WIDTH_MIN}
        max={STREAM_WIDTH_MAX}
        step={16}
        format={(value) => `${value}px`}
        unit="px"
        disabled={saving}
        onChange={setDraft}
        onChangeEnd={(value) => void save(value)}
        reset={
          draft !== null || settings?.streamWidth !== undefined
            ? { label: t('set.streamWidthReset', { n: tokens.size.chat }), disabled: saving, onPress: () => void save(undefined), testId: 'v3-stream-width-reset' }
            : undefined
        }
        testId="v3-stream-width"
      />
    </SettingsRow>
  )
}
