import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { SettingRow } from '../ui'

/** 会话整理设置；旧空间和活动数据继续保留，不参与新会话入口。 */
export function WorkspaceTab() {
  const t = useT()
  const days = useStore((s) => s.settings?.autoArchiveDays ?? 0)
  const patchSettings = useStore((s) => s.patchSettings)
  return (
    <div className="ui-rows">
      <SettingRow name={t('set.autoArchive')} desc={t('set.autoArchiveDesc')} ctlClassName="seg" ctlProps={{ 'data-testid': 'set-auto-archive' }}>
        {[0, 7, 14, 30].map((value) => (
          <button key={value} className={`seg-btn ${days === value ? 'sel' : ''}`} data-days={value}
            onClick={() => void patchSettings({ autoArchiveDays: value })}>
            {value === 0 ? t('set.autoArchiveNever') : t('set.autoArchiveDays', { n: value })}
          </button>
        ))}
      </SettingRow>
    </div>
  )
}
