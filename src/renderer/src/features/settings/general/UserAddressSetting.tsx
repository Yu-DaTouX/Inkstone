import { useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { TextField } from '../../../ui'
import { SettingsRow } from '../root/controls'
import { generalText } from './general-text'

export function UserAddressSetting(): ReactElement {
  const { lang } = useI18n()
  const text = generalText(lang)
  const profile = useStore((s) => s.settings?.profile)
  const patchSettings = useStore((s) => s.patchSettings)
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (): void => {
    const current = useStore.getState().settings?.profile
    if (draft === null || !current) return
    const name = draft.trim()
    if (name === current.name) {
      setDraft(null)
      return
    }
    void patchSettings({ profile: { ...current, name } }).then(() => {
      setDraft((value) => value === draft ? null : value)
    }).catch(() => {})
  }

  return (
    <SettingsRow settingId="session-user-address" label={text.sessionUserAddress} description={text.sessionUserAddressDesc}>
      <TextField
        aria-label={text.sessionUserAddress}
        value={draft ?? profile?.name ?? ''}
        placeholder={text.sessionUserAddressPlaceholder}
        maxLength={32}
        isDisabled={!profile}
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) event.target.blur()
        }}
        data-testid="v3-session-user-address"
      />
    </SettingsRow>
  )
}
