import type { ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Switch } from '../../../ui'
import { SettingsGroup, SettingsRow } from '../root/controls'

export function AgentToolSwitches(): ReactElement {
  const t = useT()
  const codemode = useStore((s) => s.settings?.codemodeEnabled !== false)
  const visualAnswers = useStore((s) => s.settings?.visualAnswers !== false)
  const patchSettings = useStore((s) => s.patchSettings)
  return (
    <SettingsGroup label={t('cap.codemodeTitle')} testId="cap-agent-switches">
      <SettingsRow settingId="caps-tools-codemode" label={t('cap.codemodeTitle')} description={t('cap.codemodeDesc')}>
        <Switch
          aria-label={t('cap.codemodeTitle')}
          isSelected={codemode}
          onChange={(on) => void patchSettings({ codemodeEnabled: on })}
          data-testid="cap-codemode-switch"
        />
      </SettingsRow>
      <SettingsRow settingId="caps-tools-visual-answers" label={t('picker.visual')} description={t('picker.visualDesc')}>
        <Switch
          aria-label={t('picker.visual')}
          isSelected={visualAnswers}
          onChange={(on) => void patchSettings({ visualAnswers: on })}
          data-testid="cap-visual-answers-switch"
        />
      </SettingsRow>
    </SettingsGroup>
  )
}
