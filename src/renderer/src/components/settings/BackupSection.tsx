import { useState } from 'react'
import { useT } from '../../i18n'
import { Button, SettingRow } from '../ui'
import type { BackupSummary } from '../../../../shared/data-backup'

export function BackupSection() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<BackupSummary | null>(null)
  const run = async (action: 'create' | 'verify'): Promise<void> => {
    setBusy(true)
    setError('')
    setSummary(null)
    try {
      const result = await window.yan.backup(action)
      if (result.ok) setSummary(result.summary)
      else if (!result.cancelled) setError(result.error ?? t('storage.failed'))
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  return <SettingRow name={t('backup.title')} desc={<>
    <span>{t('backup.scope')}</span>
    {summary ? <div role="status">{t('backup.checked', { files: summary.files, mb: (summary.bytes / 1024 ** 2).toFixed(1) })}<div className="set-path">{summary.path}</div></div> : null}
    {error ? <div role="alert" className="set-warn">{error}</div> : null}
  </>}>
    <Button size="sm" disabled={busy} onClick={() => void run('create')}>{busy ? t('storage.checking') : t('backup.create')}</Button>
    <Button size="sm" disabled={busy} onClick={() => void run('verify')}>{t('backup.verify')}</Button>
    {summary ? <Button size="sm" variant="ghost" onClick={() => void window.yan.revealPath(summary.path)}>{t('storage.open')}</Button> : null}
  </SettingRow>
}
