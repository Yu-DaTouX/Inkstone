import { useEffect, useState, type ReactElement } from 'react'
import type { PiRuntimePrefs, QueueMode } from '../../../../../shared/ipc'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Switch } from '../../../ui'
import { generalText } from './general-text'
import { SettingsGroup, SettingsRow, Segmented } from '../root/controls'
import { PiRetryDetailRows, PiSessionGroups, usePiNativeSettings } from './PiNativeSettings'
import { piNativeText } from './pi-native-text'

const ARCHIVE_OPTIONS = [0, 7, 14, 30] as const
const QUEUE_MODES: QueueMode[] = ['one-at-a-time', 'all']

export function SessionSettings(): ReactElement {
  const { lang } = useI18n()
  const text = generalText(lang)
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)

  const archiveDays = settings?.autoArchiveDays ?? 0
  const keepAwake = settings?.keepAwakeWhileWorking !== false
  const keepAwakeBattery = settings?.keepAwakeOnBattery !== false
  const checkpoints = settings?.checkpointsEnabled !== false
  const subagentNotify = settings?.subagentNotify !== false
  const loopAutoContinue = settings?.streamLoopAutoContinue !== false
  const session = useStore((s) => s.session)
  const autoRetry = useStore((s) => s.autoRetryEnabled)
  const setAutoRetry = useStore((s) => s.setAutoRetry)
  const setSteeringMode = useStore((s) => s.setSteeringMode)
  const setFollowUpMode = useStore((s) => s.setFollowUpMode)
  const [prefs, setPrefs] = useState<PiRuntimePrefs | null>(null)
  const piText = piNativeText(lang)
  const piNative = usePiNativeSettings(piText)

  useEffect(() => {
    let alive = true
    void window.yan.piRuntimePrefs().then((next) => {
      if (!alive) return
      setPrefs(next)
      useStore.setState({ autoRetryEnabled: next.autoRetry })
    })
    return () => {
      alive = false
    }
  }, [])

  const steeringMode = session?.steeringMode ?? prefs?.steeringMode ?? 'one-at-a-time'
  const followUpMode = session?.followUpMode ?? prefs?.followUpMode ?? 'one-at-a-time'
  const queueOptions = (prefix: string) =>
    QUEUE_MODES.map((value) => ({
      value,
      label: value === 'all' ? text.queueAll : text.queueOneAtATime,
      testId: `${prefix}-${value}`
    }))

  return (
    <section className="settings-section" data-testid="v3-session-settings">
      <SettingsGroup label={text.sessionAutoArchive}>
        <SettingsRow label={text.sessionAutoArchive} description={text.sessionAutoArchiveDesc} block>
          <Segmented
            label={text.sessionAutoArchive}
            value={String(archiveDays)}
            options={ARCHIVE_OPTIONS.map((value) => ({
              value: String(value),
              label: value === 0 ? text.archiveNever : text.archiveDays.replace('{n}', String(value)),
              testId: `v3-session-archive-${value}`
            }))}
            onChange={(value) => void patchSettings({ autoArchiveDays: Number(value) })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={text.sessionKeepAwake}>
        <SettingsRow label={text.sessionKeepAwake}description={text.sessionKeepAwakeDesc}>
          <Switch
            aria-label={text.sessionKeepAwake}
            isSelected={keepAwake}
            onChange={(on) => void patchSettings({ keepAwakeWhileWorking: on })}
            data-testid="v3-session-keep-awake"
          />
        </SettingsRow>

        <SettingsRow
          nested
          label={text.sessionKeepAwakeBattery}
          description={keepAwake ? text.sessionKeepAwakeBatteryDesc : text.securityOutsideDisabled}
        >
          <Switch
            aria-label={text.sessionKeepAwakeBattery}
            isSelected={keepAwakeBattery}
            isDisabled={!keepAwake}
            onChange={(on) => void patchSettings({ keepAwakeOnBattery: on })}
            data-testid="v3-session-keep-awake-battery"
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label={text.sessionDelivery}>
        <SettingsRow label={text.sessionSteeringMode} description={text.sessionSteeringModeDesc} block>
          <Segmented
            label={text.sessionSteeringMode}
            value={steeringMode}
            options={queueOptions('v3-session-steering')}
            onChange={(value) => void setSteeringMode(value as QueueMode)}
          />
        </SettingsRow>
        <SettingsRow label={text.sessionFollowUpMode} description={text.sessionFollowUpModeDesc} block>
          <Segmented
            label={text.sessionFollowUpMode}
            value={followUpMode}
            options={queueOptions('v3-session-follow-up')}
            onChange={(value) => void setFollowUpMode(value as QueueMode)}
          />
        </SettingsRow>
      </SettingsGroup>

      <div className="settings-rows">
        <SettingsRow label={text.sessionAutoRetry} description={text.sessionAutoRetryDesc}>
          <Switch
            aria-label={text.sessionAutoRetry}
            isSelected={autoRetry}
            onChange={(on) => void setAutoRetry(on)}
            data-testid="v3-session-auto-retry"
          />
        </SettingsRow>
        <PiRetryDetailRows state={piNative} text={piText} disabled={!autoRetry} />

        <SettingsRow label={text.sessionCheckpoints} description={text.sessionCheckpointsDesc}>
          <Switch
            aria-label={text.sessionCheckpoints}
            isSelected={checkpoints}
            onChange={(on) => void patchSettings({ checkpointsEnabled: on })}
            data-testid="v3-session-checkpoints"
          />
        </SettingsRow>

        <SettingsRow label={text.sessionSubagentNotify} description={text.sessionSubagentNotifyDesc}>
          <Switch
            aria-label={text.sessionSubagentNotify}
            isSelected={subagentNotify}
            onChange={(on) => void patchSettings({ subagentNotify: on })}
            data-testid="v3-session-subagent-notify"
          />
        </SettingsRow>

        <SettingsRow label={text.sessionLoopAutoContinue} description={text.sessionLoopAutoContinueDesc}>
          <Switch
            aria-label={text.sessionLoopAutoContinue}
            isSelected={loopAutoContinue}
            onChange={(on) => void patchSettings({ streamLoopAutoContinue: on })}
            data-testid="v3-session-loop-auto-continue"
          />
        </SettingsRow>
      </div>

      <PiSessionGroups state={piNative} text={piText} />
    </section>
  )
}
