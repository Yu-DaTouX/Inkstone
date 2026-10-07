import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { IconButton, Menu, MenuItem, MenuSeparator } from '../ui'
import { menuAnchor, type MenuAnchor } from '../workbench/Workspace'

/** Session-level actions in the header overflow menu (formerly the inspector's actions section). */
export function SessionMenu() {
  const t = useT()
  const [at, setAt] = useState<MenuAnchor | null>(null)
  const session = useStore(s => s.session)
  const autoRetry = useStore(s => s.autoRetryEnabled)
  useEffect(() => {
    if (!at) return
    const release = useStore.getState().acquireOverlayBlocker('session-menu')
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null) }
    document.addEventListener('keydown', key)
    return () => { release(); document.removeEventListener('keydown', key) }
  }, [at])
  if (!session?.sessionId) return null
  const run = (fn: () => unknown) => { setAt(null); void fn() }
  const state = useStore.getState
  return <>
    <IconButton size="sm" icon="menu" label={t('rp.sessionActions')} aria-haspopup="menu" aria-expanded={!!at} data-testid="session-menu"
      onClick={e => setAt(at ? null : menuAnchor(e.currentTarget))} />
    {at ? createPortal(<div className="tile-menu-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) setAt(null) }}>
      <Menu className="tile-layout-menu" label={t('rp.sessionActions')} style={{ top: at.top, right: at.right }} data-testid="session-menu-popover">
        <MenuItem icon="external" autoFocus data-testid="act-export" onClick={() => run(() => state().exportHtml())}>{t('rp.actExport')}</MenuItem>
        <MenuItem icon="branch" data-testid="act-clone" disabled={!!session.isStreaming} onClick={() => run(() => state().clone())}>{t('rp.actClone')}</MenuItem>
        {session.sessionFile ? <MenuItem icon="folder-open" data-testid="act-reveal" onClick={() => run(() => window.yan.revealPath(session.sessionFile!))}>{t('rp.actReveal')}</MenuItem> : null}
        <MenuSeparator />
        <MenuItem icon={autoRetry ? 'check' : undefined} role="menuitemcheckbox" aria-checked={autoRetry} title={t('status.autoRetryHint')} data-testid="act-auto-retry"
          onClick={() => run(() => state().setAutoRetry(!autoRetry))}>{t('status.autoRetry')}</MenuItem>
        <MenuItem icon="stop" data-testid="act-abort-retry" onClick={() => run(() => state().abortRetry())}>{t('rp.actRetry')}</MenuItem>
      </Menu>
    </div>, document.body) : null}
  </>
}
