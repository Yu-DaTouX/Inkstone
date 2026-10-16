import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { QUESTION_FREQUENCIES, normalizeQuestionFrequency } from '../../../../shared/question-frequency'
import { SettingRow, Switch } from '../ui'

const FREQUENCY_LABELS: Record<string, 'set.questionFrequencySparse' | 'set.questionFrequencyBalanced' | 'set.questionFrequencyEager'> = {
  sparse: 'set.questionFrequencySparse',
  balanced: 'set.questionFrequencyBalanced',
  eager: 'set.questionFrequencyEager'
}

export function WorkspaceTab() {
  const t = useT()
  const days = useStore((s) => s.settings?.autoArchiveDays ?? 0)
  const autoContinue = useStore((s) => s.settings?.streamLoopAutoContinue !== false)
  const frequency = normalizeQuestionFrequency(useStore((s) => s.settings?.questionFrequency))
  const patchSettings = useStore((s) => s.patchSettings)
  return (
    <div className="ui-rows">
      <SettingRow name={t('set.questionFrequency')} desc={t('set.questionFrequencyDesc')} ctlClassName="seg" ctlProps={{ 'data-testid': 'set-question-frequency' }}>
        {QUESTION_FREQUENCIES.map((value) => (
          <button
            key={value}
            className={`seg-btn ${frequency === value ? 'sel' : ''}`}
            data-question-frequency={value}
            onClick={() => void patchSettings({ questionFrequency: value })}
          >
            {t(FREQUENCY_LABELS[value])}
          </button>
        ))}
      </SettingRow>
      <SettingRow name={t('set.autoArchive')} desc={t('set.autoArchiveDesc')} ctlClassName="seg" ctlProps={{ 'data-testid': 'set-auto-archive' }}>
        {[0, 7, 14, 30].map((value) => (
          <button key={value} className={`seg-btn ${days === value ? 'sel' : ''}`} data-days={value}
            onClick={() => void patchSettings({ autoArchiveDays: value })}>
            {value === 0 ? t('set.autoArchiveNever') : t('set.autoArchiveDays', { n: value })}
          </button>
        ))}
      </SettingRow>
      <SettingRow
        name={t('set.streamLoopAutoContinue')}
        desc={t('set.streamLoopAutoContinueDesc')}
        title={t('set.streamLoopAutoContinueTip')}
      >
        <Switch
          label={t('set.streamLoopAutoContinue')}
          checked={autoContinue}
          onChange={(on) => void patchSettings({ streamLoopAutoContinue: on })}
          testId="set-stream-loop-auto-continue"
        />
      </SettingRow>
    </div>
  )
}
