import type { ReactElement } from 'react'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import { SegmentedControl, Switch, TooltipText } from '../../../ui'
import { SettingsGroup, SettingsRow } from '../root/controls'

export function AgentToolSwitches(): ReactElement {
  const t = useT()
  const codemode = useStore((s) => s.settings?.codemode ?? 'auto')
  const visualAnswers = useStore((s) => s.settings?.visualAnswers !== false)
  const patchSettings = useStore((s) => s.patchSettings)
  return (
    <SettingsGroup label={t('cap.codemodeTitle')} testId="cap-agent-switches">
      <SettingsRow
        settingId="caps-tools-codemode"
        label={<TooltipText tooltip={t('cap.codemodeHint')} tooltipPlacement="right">{t('cap.codemodeTitle')}</TooltipText>}
        description={t('cap.codemodeDesc')}>
        <SegmentedControl
          label={t('cap.codemodeTitle')}
          value={codemode}
          onChange={(value) => void patchSettings({ codemode: value })}
          options={[
            { value: 'auto', label: t('cap.codemodeAuto'), title: t('cap.codemodeAutoHint'), testId: 'cap-codemode-auto' },
            { value: 'on', label: t('cap.codemodeOn'), testId: 'cap-codemode-on' },
            { value: 'off', label: t('cap.codemodeOff'), testId: 'cap-codemode-off' }
          ]}
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
