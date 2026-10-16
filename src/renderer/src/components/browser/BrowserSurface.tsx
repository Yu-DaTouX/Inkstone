import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons/Icon'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { nextAddressInput } from '../../../../shared/browser-navigation'
import { IconButton } from '../ui'

export function BrowserSurface() {
  const t = useT()
  const state = useStore((s) => s.browserState)
  const close = useStore((s) => s.closeBrowser)
  const openExternalChrome = useStore((s) => s.openExternalChrome)
  const closeExternalChrome = useStore((s) => s.closeExternalChrome)
  const syncLocalProfile = useStore((s) => s.syncLocalProfile)
  const syncPageStorage = useStore((s) => s.syncPageStorage)
  const [syncing, setSyncing] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const tabs = state.tabs ?? []
  const external = state.external
  const externalActive = state.mode === 'external' ? external : undefined
  const shownUrl = state.url === 'about:blank' ? '' : state.url
  const [address, setAddress] = useState(shownUrl)
  const [addressDirty, setAddressDirty] = useState(false)
  const navSeq = useRef(0)
  const [error, setError] = useState('')
  const [syncNotice, setSyncNotice] = useState('')
  const syncCookies = async (): Promise<void> => {
    setSyncing(true)
    try {
      const report = await syncLocalProfile()
      setSyncNotice(`${report.source ?? ''} → ${report.target ?? ''}: ${report.copied.join(', ')}${report.failed.length ? ' · ' + report.failed.map((x) => x.reason).join('; ') : ''}`)
    } catch { setError(t('browser.syncFailed')) } finally { setSyncing(false) }
  }
  const syncStorage = async (): Promise<void> => {
    setSyncing(true)
    try { const report = await syncPageStorage(); setSyncNotice(`${report.source ?? ''} → ${report.target ?? ''}: ${report.copied.join(', ')}`) }
    catch (e) { setError(e instanceof Error ? e.message : t('browser.syncFailed')) } finally { setSyncing(false) }
  }
  const changePermission = async (permission: string, origin: string, allowed: boolean): Promise<void> => {
    try {
      const result = await window.yan.browser.setPermission(permission, origin, allowed)
      if (!result.ok) setError(result.error ?? t('browser.permissionUpdateFailed'))
      else setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('browser.permissionUpdateFailed'))
    }
  }
  const viewportRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setAddress((prev) => nextAddressInput(shownUrl, prev, addressDirty))
  }, [shownUrl, addressDirty])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent): void => {
      const el = e.target as HTMLElement
      if (menuRef.current?.contains(el) || el.closest('.browser-actions')) return
      setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    let frame = 0
    let disposed = false
    let lastBounds = ''
    const syncBounds = (): void => {
      const r = el.getBoundingClientRect()
      const clip = el.closest('.tile-workspace-scroll')?.getBoundingClientRect()
      const left = clip ? Math.max(r.left, clip.left) : r.left
      const top = clip ? Math.max(r.top, clip.top) : r.top
      const right = clip ? Math.min(r.right, clip.right) : r.right
      const bottom = clip ? Math.min(r.bottom, clip.bottom) : r.bottom
      const bounds = {
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top)
      }
      const signature = [bounds.x, bounds.y, bounds.width, bounds.height].map((v) => Math.round(v * 2) / 2).join(',')
      if (signature !== lastBounds) {
        lastBounds = signature
        void window.yan.browser.setBounds(bounds)
      }
      if (!disposed) frame = requestAnimationFrame(syncBounds)
    }
    frame = requestAnimationFrame(syncBounds)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
    }
  }, [])

  const toggleChrome = async (): Promise<void> => {
    if (connecting) return
    setMenuOpen(false)
    if (external) { await closeExternalChrome(); return }
    setConnecting(true)
    try { await openExternalChrome() } finally { setConnecting(false) }
  }

  const navigate = async (target?: string): Promise<void> => {
    let value = (target ?? address).trim()
    if (!value) return
    if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
      value = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(value) ? `http://${value}` : `https://${value}`
    }
    const seq = ++navSeq.current
    const result = await window.yan.browser.navigate(value)
    if (seq !== navSeq.current) return
    setAddressDirty(false)
    if (!result.ok) setError(result.error ?? t('browser.navigateError'))
    else setError('')
  }

  return (
    <div className="browser-surface" data-testid="browser-surface">
      <div className="ui-tabs browser-tabs" role="tablist">
        {tabs.map((tab) => (
          <div key={tab.id} className="ui-tab-group">
          <button
            type="button"
            className={`ui-tab doc browser-tab ${tab.id.startsWith('chrome:') ? 'external' : ''}`}
            role="tab"
            aria-selected={tab.id === state.activeTabId}
            onClick={() => void window.yan.browser.switchTab(tab.id)}
            title={tab.url}
          >
            <span className="ui-tab-label">{tab.id.startsWith('chrome:') ? 'Chrome · ' : ''}{tab.title || tab.url || t('browser.newTab')}</span>
          </button>
            <button
              type="button"
              className="ui-tab-close"
              aria-label={t('browser.closeTab')}
              title={t('browser.closeTab')}
              onClick={(event) => { event.stopPropagation(); void window.yan.browser.closeTab(tab.id) }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <IconButton icon="plus" label={t('browser.newTab')} size="sm" className="browser-new-tab" onClick={() => void window.yan.browser.newTab()} />
      </div>

      <div className="browser-toolbar">
        <IconButton icon="back" label={t('browser.back')} size="sm" iconSize={14} className="browser-nav" onClick={() => void window.yan.browser.back()} disabled={!state.canGoBack} />
        <IconButton icon="forward" label={t('browser.forward')} size="sm" iconSize={14} className="browser-nav" onClick={() => void window.yan.browser.forward()} disabled={!state.canGoForward} />
        <IconButton icon="refresh" label={t('browser.reload')} size="sm" iconSize={14} className="browser-nav" onClick={() => void window.yan.browser.reload()} />
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            void navigate()
          }}
        >
          <input
            value={address}
            onChange={(event) => {
              setAddress(event.target.value)
              setAddressDirty(true)
            }}
            aria-label={t('browser.address')}
            data-testid="browser-address-input"
          />
        </form>

        <IconButton
          icon="plug"
          size="sm"
          iconSize={14}
          active={!!external || connecting}
          disabled={connecting}
          className="browser-nav browser-chrome"
          label={connecting ? t('browser.connectingChrome') : external ? t('browser.disconnectChrome') : t('browser.connectChrome')}
          data-testid="browser-external-chrome"
          onClick={() => void toggleChrome()}
        />

        <IconButton
          icon="external"
          size="sm"
          iconSize={14}
          className="browser-nav browser-open-external"
          label={t('browser.openExternal')}
          disabled={!shownUrl}
          data-testid="browser-open-external"
          onClick={() => void window.yan.browser.openExternal(state.url || address)}
        />

        <div className="browser-menu-wrap" ref={menuRef}>
          <IconButton
            icon="menu"
            size="sm"
            iconSize={14}
            className={`browser-nav browser-more ${menuOpen ? 'on' : ''}`}
            label={t('browser.more')}
            aria-expanded={menuOpen}
            data-testid="browser-more"
            onClick={() => setMenuOpen((v) => !v)}
          />
        </div>

        <IconButton icon="close" label={t('browser.close')} size="sm" iconSize={14} className="browser-close" onClick={() => void close()} />
      </div>

      {menuOpen ? (
        <div className="browser-actions" data-testid="browser-menu">
          {state.lastDownload ? (
            <span className="browser-sync-result" data-testid="browser-download-menu" title={state.lastDownload.path}>
              {t('browser.downloaded', { name: state.lastDownload.filename })}
              {state.lastDownload.source ? ` · ${downloadHost(state.lastDownload.source)}` : ''} ·{' '}
              {t('browser.downloadNotOpened')}
            </span>
          ) : null}
          {external ? <button className="browser-action" disabled={syncing} onClick={() => void syncCookies()} title={t('browser.cookieScope')}>
            {syncing ? t('browser.syncing') : state.mode === 'external' ? t('browser.cookiesToEmbedded') : t('browser.cookiesToChrome')}
          </button> : null}
          {external ? <button className="browser-action" disabled={syncing} onClick={() => void syncStorage()} title={t('browser.storageScope')}>
            {syncing ? t('browser.syncing') : t('browser.storageCopy')}
          </button> : null}
          {syncNotice ? <span className="browser-sync-result" title={syncNotice}>{syncNotice}</span> : null}
          {state.permissions?.length ? (
            <div className="browser-permission-list" data-testid="browser-permissions">
              <span className="browser-sync-result">
                {t('browser.permissionsBlocked', { n: state.permissions.length })}
              </span>
              {state.permissions.slice(-8).map((permission, index) => (
                <div
                  className={`browser-permission-row ${permission.status === 'allowed' ? 'allowed' : 'blocked'}`}
                  key={`${permission.permission}:${permission.origin}:${permission.status}:${index}`}
                >
                  <span
                    className="browser-permission-meta"
                    title={`${permission.permission} · ${permission.origin || '—'}`}
                  >
                    {permission.permission} · {permission.origin || '—'} · {permission.status === 'allowed'
                      ? t('browser.permissionAllowed')
                      : t('browser.permissionBlockedStatus')}
                  </span>
                  <button
                    className="browser-action"
                    data-testid="browser-permission-toggle"
                    onClick={() => void changePermission(permission.permission, permission.origin, permission.status !== 'allowed')}
                  >
                    {permission.status === 'allowed' ? t('browser.revokePermission') : t('browser.allowPermission')}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {state.blockedRequests?.length ? (
            <div className="browser-permission-list" data-testid="browser-blocked">
              <span className="browser-sync-result">
                {t('browser.blockedRequests', { n: state.blockedRequests.length })}
              </span>
              {state.blockedRequests.slice(-5).map((item, index) => (
                <div
                  className="browser-permission-row blocked"
                  key={`${item.host}:${item.reason}:${item.from ?? ''}:${index}`}
                >
                  <span
                    className="browser-permission-meta"
                    title={`${item.host} · ${item.from || '—'}`}
                  >
                    {item.host} ·{' '}
                    {item.reason === 'dns-rebind'
                      ? t('browser.blockedDnsRebind')
                      : t('browser.blockedPrivate')}
                    {item.from ? ` · ${t('browser.blockedFrom', { host: item.from })}` : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {state.userControl ? (
            <button
              className="browser-action"
              onClick={() => {
                setMenuOpen(false)
                void window.yan.browser.setUserControl(false)
              }}
            >
              {t('browser.recoverAgent')}
            </button>
          ) : null}
        </div>
      ) : state.loading || error || state.loadError || state.userControl || state.lastDownload || state.blockedRequests?.length ? (
        <div className="browser-status" data-testid="browser-status">
          {state.loading ? <span className="browser-loading">{t('browser.loading')}</span> : null}
          {state.loadError ? (
            <div className="browser-loaderror" data-testid="browser-load-error" role="alert">
              <span className="browser-error" title={state.loadError.description}>
                {t('browser.pageFailed')}
              </span>
              <button
                className="browser-action"
                data-testid="browser-error-retry"
                onClick={() => void navigate(state.loadError?.url)}
              >
                {t('browser.retry')}
              </button>
              <button
                className="browser-action"
                data-testid="browser-error-external"
                onClick={() => void window.yan.browser.openExternal(state.loadError?.url ?? state.url)}
              >
                {t('browser.openExternal')}
              </button>
              <span className="browser-error-url" title={state.loadError.url} data-testid="browser-error-url">
                {state.loadError.url}
              </span>
            </div>
          ) : null}
          {state.blockedRequests?.length ? (
            <span className="browser-error" data-testid="browser-blocked-hint">
              {t('browser.blockedRequests', { n: state.blockedRequests.length })}
            </span>
          ) : null}
          {state.userControl ? (
            <button
              className="browser-control"
              onClick={() => void window.yan.browser.setUserControl(false)}
              title={t('browser.recoverAgent')}
            >
              {t('browser.recoverAgent')}
            </button>
          ) : null}
          {error ? (
            <span className="browser-error" title={error}>
              {error}
            </span>
          ) : null}
          {state.lastDownload ? (
            <span className="browser-download" data-testid="browser-download" title={state.lastDownload.path}>
              {t('browser.downloaded', { name: state.lastDownload.filename })}
              {state.lastDownload.source ? ` · ${downloadHost(state.lastDownload.source)}` : ''}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="browser-viewport" ref={viewportRef}>
        {externalActive ? (
          <div className="browser-ext-note" data-testid="browser-external-note">
            <div className="browser-ext-title">{t('browser.externalActive')}</div>
            <div className="browser-ext-desc">{t('browser.externalDesc')}</div>
            {externalActive.profileDir ? <code className="browser-ext-path">{externalActive.profileDir}</code> : null}
            {externalActive.debuggingPort ? <span className="browser-ext-port">:{externalActive.debuggingPort}</span> : null}

            {externalActive.sync ? (
              <div className="browser-ext-sync" data-testid="browser-ext-sync">
                {externalActive.sync.found ? (
                  <div className="browser-ext-sync-line">
                    {externalActive.sync.cookiesSynced
                      ? t('browser.cookiesCopied')
                      : t('browser.syncNoCookies')}
                  </div>
                ) : (
                  <div className="browser-ext-sync-line">{t('browser.syncNoChrome')}</div>
                )}
                {externalActive.sync.failed.length ? (
                  <ul className="browser-ext-sync-failed" data-testid="browser-ext-sync-failed">
                    {externalActive.sync.failed.map((f) => (
                      <li key={f.item}>
                        <code>{f.item}</code> — {f.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {externalActive.sync && !externalActive.sync.cookiesSynced ? (
              <button
                className="browser-ext-resync"
                data-testid="browser-ext-resync"
                disabled={syncing}
                onClick={async () => {
                  setSyncing(true)
                  try {
                    await syncCookies()
                  } finally {
                    setSyncing(false)
                  }
                }}
              >
                {syncing ? t('browser.syncing') : t('browser.cookiesToEmbedded')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function downloadHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 40)
  }
}
