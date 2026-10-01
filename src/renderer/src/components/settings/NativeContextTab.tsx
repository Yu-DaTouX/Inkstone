import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, SettingRow, Switch } from '../ui'

/** Only native pi controls remain; host budget and projection settings have retired. */
export function NativeContextTab() {
  const t = useT()
  const session = useStore(s => s.session)
  const compact = useStore(s => s.compact)
  const setAutoCompaction = useStore(s => s.setAutoCompaction)
  const busy = !!session?.isAgentRunning || !!session?.isStreaming || !!session?.isCompacting
  const available = !!session?.sessionId
  return (
    <div data-testid="ctx-native-settings">
      <SettingRow name={t('ctx.autoCompact')} desc={available ? undefined : t('ctx.nativeUnavailable')}>
        <Switch label={t('ctx.autoCompact')} checked={session?.autoCompactionEnabled === true} disabled={!available || session?.autoCompactionEnabled === undefined} onChange={on => void setAutoCompaction(on)} />
      </SettingRow>
      <SettingRow name={t('status.compact')}>
        <Button icon="compact" disabled={!available || busy} onClick={() => void compact()}>{t('status.compact')}</Button>
      </SettingRow>
    </div>
  )
}
