import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { PackageListingView } from '../../../../../shared/ipc'
import { useT } from '../../../i18n'
import { useStore } from '../../../state/store'
import { Badge, Button } from '../../../ui'

const BRIDGE_NAME = 'pi-claude-bridge'
const BRIDGE_VERSION = '0.9.3'

function bridgeEntry(listing: PackageListingView): { version: string | null } | undefined {
  return listing.entries.find(
    (entry) =>
      entry.installed &&
      (entry.name === BRIDGE_NAME || /(?:^|[/@:])pi-claude-bridge(?:@|$)/.test(entry.source))
  )
}

function olderThan(version: string, target: string): boolean {
  const parts = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const a = parts(version)
  const b = parts(target)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}

export function ClaudeCodeBridgeRow(): ReactElement {
  const t = useT()
  const cwd = useStore((s) => s.session?.cwd ?? s.settings?.cwd ?? '')
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [envOverrides, setEnvOverrides] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const applyListing = useCallback((listing: PackageListingView): void => {
    const entry = bridgeEntry(listing)
    setInstalled(listing.ok ? !!entry : null)
    setVersion(entry?.version ?? null)
  }, [])

  useEffect(() => {
    let alive = true
    void window.yan.packages
      .list(cwd)
      .then((listing) => {
        if (alive) applyListing(listing)
      })
      .catch(() => {
        if (alive) setInstalled(null)
      })
    void window.yan.packages
      .anthropicEnv()
      .then((names) => {
        if (alive) setEnvOverrides(Array.isArray(names) ? names : [])
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [cwd, applyListing])

  const install = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMessage('')
    try {
      const result = await window.yan.packages.action({
        kind: 'install',
        source: `npm:${BRIDGE_NAME}@${BRIDGE_VERSION}`,
        local: false,
        cwd
      })
      if (result.ok) applyListing(result.listing ?? (await window.yan.packages.list(cwd)))
      setMessage(result.ok ? t('cc.installed') : (result.error ?? t('cc.installFailed')))
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  const outdated = installed === true && !!version && olderThan(version, BRIDGE_VERSION)
  const stateText = installed === true ? t('cc.installedNext') : installed === null ? t('cc.stateUnknown') : ''

  return (
    <div className="ms-service" data-testid="ms-service-claude-bridge">
      <div className="ms-service-main">
        <span className="ms-service-head">
          <span className="ms-service-name">{t('cc.title')}</span>
          <Badge tone={installed === true ? 'run' : 'neutral'}>
            {installed === true ? t('cc.installedLabel') : t('cc.notInstalled')}
          </Badge>
        </span>
        <p className="ms-service-hint">{t('cc.desc')}</p>
        {stateText ? (
          <p className="ms-service-env" data-testid="cc-plugin-state">
            {stateText}
            {version ? ` · ${BRIDGE_NAME} ${version}` : ''}
          </p>
        ) : null}
        {envOverrides.length > 0 ? (
          <p className="ms-service-warn" role="note" data-testid="cc-env-warn">
            {t('cc.envWarn', { vars: envOverrides.join(', ') })}
          </p>
        ) : null}
      </div>
      <div className="ms-service-actions">
        {installed !== true || outdated ? (
          <Button size="sm" isDisabled={busy} data-testid="cc-install-bridge" onPress={() => void install()}>
            {busy ? t('cc.installing') : outdated ? t('cc.update', { version: BRIDGE_VERSION }) : t('cc.install')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onPress={() => void window.yan.browser.openExternal('https://www.npmjs.com/package/pi-claude-bridge?activeTab=versions')}
        >
          {t('set.releasePage')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={() => void window.yan.browser.openExternal('https://code.claude.com/docs/en/setup')}
        >
          {t('cc.getCli')}
        </Button>
      </div>
      {message ? (
        <p className="ms-service-env" role="status">
          {message}
        </p>
      ) : null}
    </div>
  )
}
