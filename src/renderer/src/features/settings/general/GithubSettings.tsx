import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { GithubAccountStatus } from '../../../../../shared/github'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Button, MiddleTruncate } from '../../../ui'
import { SettingsGroup, SettingsRow } from '../root/controls'

export function GithubSettingsGroup(): ReactElement {
  const t = useT()
  const cloneDir = useStore((s) => s.settings?.cloneDir)
  const patchSettings = useStore((s) => s.patchSettings)
  const [account, setAccount] = useState<GithubAccountStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [fallbackDir, setFallbackDir] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setChecking(true)
    const next = await window.yan.github.account().catch(() => ({ installed: false, authed: false }) as GithubAccountStatus)
    setAccount(next)
    setChecking(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void window.yan.github.defaultCloneDir().then(setFallbackDir).catch(() => undefined)
  }, [cloneDir])

  const choose = async (): Promise<void> => {
    const picked = await window.yan.pickCwd().catch(() => null)
    if (picked) await patchSettings({ cloneDir: picked })
  }

  const status = !account || checking
    ? t('settings.github.checking')
    : !account.installed
      ? t('settings.github.missing')
      : account.authed
        ? account.login
          ? t('settings.github.loggedIn', { login: account.login })
          : t('settings.github.loggedInPlain')
        : t('settings.github.loggedOut')

  return (
    <SettingsGroup title={t('settings.github.title')} testId="v3-github-settings">
      <SettingsRow settingId="github-account" label={t('settings.github.account')} description={<span data-testid="v3-github-status">{status}</span>}>
        <Button variant="secondary" isPending={checking} onPress={() => void refresh()} data-testid="v3-github-refresh">
          {t('settings.github.refresh')}
        </Button>
      </SettingsRow>
      <SettingsRow
        settingId="github-clone-dir"
        label={t('settings.github.cloneDir')}
        description={
          <>
            {t('settings.github.cloneDirDesc')}
            <MiddleTruncate className="settings-path" value={cloneDir || fallbackDir} />
          </>
        }
      >
        <Button variant="secondary" onPress={() => void choose()} data-testid="v3-github-clone-dir-choose">
          {t('settings.github.choose')}
        </Button>
        {cloneDir ? (
          <Button variant="ghost" onPress={() => void patchSettings({ cloneDir: '' })} data-testid="v3-github-clone-dir-reset">
            {t('settings.github.reset')}
          </Button>
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  )
}
