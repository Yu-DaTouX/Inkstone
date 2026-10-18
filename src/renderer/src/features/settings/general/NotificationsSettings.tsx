import { useEffect, useState, type ReactElement } from 'react'
import { Volume2 } from 'lucide-react'
import { useI18n } from '../../../i18n'
import type { SoundEvent, SoundSettings } from '../../../../../shared/ipc'
import { useStore } from '../../../state/store'
import { Button, IconButton, Slider, Switch } from '../../../ui'
import { previewSound } from '../../../lib/sound'
import { generalText } from './general-text'
import { DEFAULT_SOUND_SETTINGS, mergeSound } from './general-model'
import { SettingsGroup, SettingsMore, SettingsRow } from '../root/controls'

const EVENT_KEYS: readonly { id: SoundEvent; textKey: 'notifEventDone' | 'notifEventQuestion' | 'notifEventError' }[] = [
  { id: 'done', textKey: 'notifEventDone' },
  { id: 'question', textKey: 'notifEventQuestion' },
  { id: 'error', textKey: 'notifEventError' }
]

const PERCENT_FORMAT: Intl.NumberFormatOptions = { style: 'percent' }

function modelRef(): { model?: { provider: string; id: string } } {
  const model = useStore.getState().session?.model
  return model ? { model: { provider: model.provider, id: model.id } } : {}
}

export function NotificationsSettings(): ReactElement {
  const { lang } = useI18n()
  const text = generalText(lang)
  const sound = useStore((s) => s.settings?.sound) ?? DEFAULT_SOUND_SETTINGS
  const patchSettings = useStore((s) => s.patchSettings)
  const notify = useStore((s) => s.notify)
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? sound.volume

  useEffect(() => {
    setDraft(null)
  }, [sound.volume])

  const write = (patch: Partial<SoundSettings>): void => {
    const latest = useStore.getState().settings?.sound ?? DEFAULT_SOUND_SETTINGS
    void patchSettings({ sound: mergeSound(latest, patch) })
  }

  const commitVolume = (value: number): void => {
    setDraft(null)
    if (value === sound.volume) return
    write({ volume: value })
    previewSound('done', value)
  }

  return (
    <section className="settings-section" data-testid="v3-notifications-settings">
      <SettingsGroup label={text.notifSound}>
        <SettingsRow settingId="notifications-sound" label={text.notifSound} description={text.notifSoundDesc}>
          <Switch
            aria-label={text.notifSound}
            isSelected={sound.enabled}
            onChange={(on) => write({ enabled: on })}
            data-testid="v3-notif-sound"
          />
        </SettingsRow>

        <SettingsRow
          nested
          settingId="notifications-system"
          label={text.notifSystem}
          description={sound.enabled ? text.notifSystemDesc : text.notifSystemNeedsSound}
        >
          <Switch
            aria-label={text.notifSystem}
            isSelected={sound.notifications}
            isDisabled={!sound.enabled}
            onChange={(on) => write({ notifications: on })}
            data-testid="v3-notif-system"
          />
        </SettingsRow>

        <SettingsRow nested settingId="notifications-volume" label={text.notifVolume}>
          <Slider
            className="settings-slider"
            aria-label={text.notifVolume}
            minValue={0}
            maxValue={1}
            step={0.05}
            value={shown}
            showValue
            formatOptions={PERCENT_FORMAT}
            isDisabled={!sound.enabled}
            data-testid="v3-notif-volume"
            onChange={(next) => setDraft(next as number)}
            onChangeEnd={(next) => commitVolume(next as number)}
          />
        </SettingsRow>
      </SettingsGroup>

      <div className="settings-rows">
        {EVENT_KEYS.map((event) => (
          <SettingsRow key={event.id} settingId={`notifications-event-${event.id}`} label={text[event.textKey]}>
            <IconButton
              size="sm"
              aria-label={`${text.notifPreview} · ${text[event.textKey]}`}
              data-testid={`v3-notif-preview-${event.id}`}
              onPress={() => previewSound(event.id, sound.volume)}
            >
              <Volume2 size={16} />
            </IconButton>
            <Switch
              aria-label={text[event.textKey]}
              isSelected={sound.events?.[event.id] ?? true}
              isDisabled={!sound.enabled}
              onChange={(on) => write({ events: { ...sound.events, [event.id]: on } })}
              data-testid={`v3-notif-event-${event.id}`}
            />
          </SettingsRow>
        ))}
      </div>

      <SettingsMore>
        <div className="settings-rows">
          <SettingsRow settingId="notifications-test" label={text.notifSystemTestLabel} description={text.notifSystemHelp}>
            <Button
              size="sm"
              variant="secondary"
              data-testid="v3-notif-system-test"
              onPress={() =>
                void window.yan
                  .notifyAttention({ kind: 'question', title: text.notifSystemTestLabel, body: text.notifSystemHelp, ...modelRef() })
                  .catch((error) => notify('error', String(error)))
              }
            >
              {text.notifSystemTest}
            </Button>
          </SettingsRow>
        </div>
      </SettingsMore>
    </section>
  )
}
