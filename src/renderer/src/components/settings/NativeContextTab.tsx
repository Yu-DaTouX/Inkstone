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
      <SettingRow col name={t('ctx.nativeOwner')} desc={t('ctx.nativeDescription')} />
      <SettingRow col name={t('ctx.autoCompact')} desc={available ? t('ctx.nativePiControls') : t('ctx.nativeUnavailable')}>
        <Switch label={t('ctx.autoCompact')} checked={session?.autoCompactionEnabled === true} disabled={!available || session?.autoCompactionEnabled === undefined} onChange={on => void setAutoCompaction(on)} />
        <Button icon="compact" disabled={!available || busy} onClick={() => void compact()}>{t('status.compact')}</Button>
      </SettingRow>
      <SettingRow col name={t('ctx.nativeMaterials')} desc={t('ctx.nativeHistory')} />
    </div>
  )
}
