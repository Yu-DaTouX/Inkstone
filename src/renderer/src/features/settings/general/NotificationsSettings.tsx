/**
 * 设置 → 通知与提醒（v3）。
 *
 * 真实接入现有 `settings.sound`：系统通知、提示音总开关、按事件（完成 / 需要回答 /
 * 出错）开关、音量与试听。系统通知试发走既有 `window.yan.notifyAttention`。
 * 尚无后端开关的项（勿扰、手机推送、迷你小窗）不渲染占位行。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import type { SoundEvent, SoundSettings } from '../../../../../shared/ipc'
import { useStore } from '../../../state/store'
import { Button, Switch } from '../../../ui'
import { previewSound } from '../../../lib/sound'
import { generalText } from './general-text'
import { DEFAULT_SOUND_SETTINGS, mergeSound } from './general-model'
import { SettingsRow } from '../root/controls'

const EVENT_KEYS: readonly { id: SoundEvent; textKey: 'notifEventDone' | 'notifEventQuestion' | 'notifEventError' }[] = [
  { id: 'done', textKey: 'notifEventDone' },
  { id: 'question', textKey: 'notifEventQuestion' },
  { id: 'error', textKey: 'notifEventError' }
]

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

  const commitVolume = (): void => {
    if (draft === null) return
    const value = draft
    setDraft(null)
    write({ volume: value })
    previewSound('done', value)
  }

  return (
    <section className="settings-section" data-testid="v3-notifications-settings">
      <p className="settings-note" role="note">
        {text.notifNote}
      </p>

      <div className="settings-rows">
        <SettingsRow label={text.notifSystem} description={text.notifSystemDesc}>
          <Button
            size="sm"
            variant="ghost"
            data-testid="v3-notif-system-test"
            onPress={() =>
              void window.yan
                .notifyAttention({ kind: 'question', title: text.notifSystemTest, body: text.notifSystemHelp })
                .catch((error) => notify('error', String(error)))
            }
          >
            {text.notifSystemTest}
          </Button>
          <Switch
            aria-label={text.notifSystem}
            isSelected={sound.notifications}
            onChange={(on) => write({ notifications: on })}
            data-testid="v3-notif-system"
          />
        </SettingsRow>

        <SettingsRow label={text.notifSound} description={text.notifSoundDesc}>
          <Switch
            aria-label={text.notifSound}
            isSelected={sound.enabled}
            onChange={(on) => write({ enabled: on })}
            data-testid="v3-notif-sound"
          />
        </SettingsRow>

        {sound.enabled ? (
          <SettingsRow label={text.notifPreview} description={`${Math.round(shown * 100)}%`}>
            <input
              className="settings-range"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={shown}
              aria-label={text.notifPreview}
              data-testid="v3-notif-volume"
              onChange={(event) => setDraft(Number(event.target.value))}
              onPointerUp={commitVolume}
              onKeyUp={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
                commitVolume()
              }}
            />
          </SettingsRow>
        ) : null}

        {EVENT_KEYS.map((event) => (
          <SettingsRow key={event.id} label={text[event.textKey]}>
            <Button
              size="sm"
              variant="ghost"
              data-testid={`v3-notif-preview-${event.id}`}
              onPress={() => previewSound(event.id, sound.volume)}
            >
              {text.notifPreview}
            </Button>
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
    </section>
  )
}
