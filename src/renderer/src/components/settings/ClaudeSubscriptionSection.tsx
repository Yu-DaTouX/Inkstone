import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button, SettingRow } from '../ui'

/** 复用 pi 包管理；用户点选后才安装，不自动读取或迁移 Claude 登录凭证。 */
export function ClaudeSubscriptionSection() {
  const t = useT()
  const cwd = useStore(s => s.session?.cwd ?? s.settings?.cwd ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [installed, setInstalled] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void window.yan.packages.list(cwd).then(result => {
      if (alive) setInstalled(result.ok ? result.entries.some(entry => entry.installed && (entry.name === 'pi-claude-bridge' || /(?:^|[/@:])pi-claude-bridge(?:@|$)/.test(entry.source))) : null)
    }).catch(() => { if (alive) setInstalled(null) })
    return () => { alive = false }
  }, [cwd])
  const install = async () => {
    if (busy) return
    setBusy(true); setMessage('')
    try {
      const result = await window.yan.packages.action({ kind: 'install', source: 'npm:pi-claude-bridge@0.9.2', local: false, cwd })
      if (result.ok) setInstalled(true)
      setMessage(result.ok ? t('cc.installed') : result.error ?? t('delegate.failed'))
    } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }
  return <SettingRow col name={t('cc.title')} desc={t('cc.desc')}>
    <span className="ui-row-desc" data-testid="cc-plugin-state">{installed === true ? t('cc.installedNext') : installed === false ? t('cc.notInstalled') : t('cc.stateUnknown')}</span>
    <Button data-testid="cc-install-bridge" disabled={busy || installed === true} onClick={() => void install()}>{busy ? t('cc.installing') : installed ? t('cc.installedLabel') : t('cc.install')}</Button>
    {message ? <div className="ui-row-desc" role="status">{message}</div> : null}
  </SettingRow>
}
