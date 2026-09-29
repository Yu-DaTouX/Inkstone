import { useEffect, useState } from 'react'
import type { AppUpdateStatus } from '../../../../shared/app-update'
import { useT, type MessageKey } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, SettingRow, Switch } from '../ui'

export function AppUpdateSection(): React.JSX.Element {
  const t = useT()
  const [status, setStatus] = useState<AppUpdateStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const refresh = (): void => { void window.yan.appUpdate.status().then((value) => { if (alive) setStatus(value) }).catch((error) => { if (alive) setError(String(error)) }) }
    refresh(); const timer = setInterval(refresh, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const act = async (action: 'check' | 'download'): Promise<void> => {
    try { setStatus(await window.yan.appUpdate[action]()) } catch (error) { setError(String(error)) }
  }
  return <>
    <SettingRow name={t('update.automatic')} desc={t('update.automaticHint')}>
      <Switch label={t('update.automatic')} checked={status?.automatic ?? true} onChange={(enabled) => { void window.yan.appUpdate.automatic(enabled).then(setStatus).catch((error) => setError(String(error))) }} testId="update-automatic" />
    </SettingRow>
    <SettingRow name={t('update.title')} desc={<span data-testid="update-state">{status ? t(`update.${status.phase}` as MessageKey) : '…'}{status?.latest ? ` · ${status.latest}` : ''}{status?.phase === 'downloading' ? ` · ${Math.round(status.percent ?? 0)}%` : ''}{status?.error || error ? ` · ${status?.error || error}` : ''}</span>}>
      <Button size="sm" disabled={status?.phase === 'checking' || status?.phase === 'downloading'} onClick={() => void act('check')} data-testid="update-check">{t('update.check')}</Button>
      {status?.phase === 'available' ? <Button size="sm" onClick={() => void act('download')}>{t('update.download')}</Button> : null}
      {status?.phase === 'manual' ? <Button size="sm" onClick={() => { useStore.getState().closeSettings(); void useStore.getState().openBrowser(status.releaseUrl) }}>{t('update.releases')}</Button> : null}
      {status?.phase === 'downloaded' ? <Button size="sm" onClick={() => { if (window.confirm(t('update.installConfirm'))) void window.yan.appUpdate.install().then((result) => { if (!result.ok) setError(result.error ?? '') }) }}>{t('update.install')}</Button> : null}
    </SettingRow>
  </>
}

