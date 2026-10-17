import type { ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Switch } from '../../../ui'
import { generalText } from './general-text'
import { SettingsGroup, SettingsRow, Segmented } from '../root/controls'

const ARCHIVE_OPTIONS = [0, 7, 14, 30] as const

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

      <div className="settings-rows">
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
    </section>
  )
}
