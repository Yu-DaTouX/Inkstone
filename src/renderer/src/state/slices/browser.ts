import { stripIpcErrorPrefix } from '../../../../shared/ipc-error'
import { uiText } from '../../i18n/ui-text'
import { OverlayBlockers, shouldShowBrowser } from '../browser-visibility'
import { BrowserOpener } from '../../features/browser/browser-open'
import { toolSurface, useRightPanel } from '../right-panel'
import { useUiV3 } from '../ui-v3'
import { requestTerminalTab } from '../../features/terminal/terminal-requests'
import { claimResource, releaseResource, resourceOwner } from '../resource-owners'
import { conversationKeyOf, workspaceKeyFor } from '../workspace-key'
import { viewKeyRef } from '../view-identity'
import { useStore, type Store } from '../store'
import { pushNotice, type SliceContext } from './shared'

let browserSurfaceActive = false

const overlayBlockers = new OverlayBlockers()

function browserVisibilityFor(state: Store): boolean {
  return shouldShowBrowser({
    browserOpen: state.browserState.open,
    rightPanelOpen: true,
    activeBrowserSurface: browserSurfaceActive,
    overlayBlockers: overlayBlockers.size
  })
}

let teardown = false
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => { teardown = true })
}

let browserVisibilitySeq = 0

export function applyBrowserVisibility(get: () => Store): void {
  if (teardown) return
  const desired = browserVisibilityFor(get())
  const seq = ++browserVisibilitySeq
  if (!desired && get().browserNativeVisible && browserSurfaceActive && typeof window.yan.browser.snapshot === 'function') {
    void window.yan.browser.snapshot().catch(() => null).then(async (cover) => {
      if (cover && typeof Image === 'function') {
        const image = new Image()
        image.src = cover
        await image.decode().catch(() => undefined)
      }
      if (seq !== browserVisibilitySeq) return
      useStore.setState({ browserCover: cover, browserNativeVisible: false })
      requestAnimationFrame(() => {
        if (seq === browserVisibilitySeq) void window.yan.browser.setVisible(false)
      })
    })
    return
  }
  if (get().browserNativeVisible !== desired) useStore.setState({ browserNativeVisible: desired })
  void window.yan.browser.setVisible(desired)
}

export function currentViewOwnerKey(view: Store): string {
  return workspaceKeyFor(viewKeyRef(view))
}

export function revealTerminalPane(get: () => Store, owner: string, terminalId: string): void {
  const viewOwner = currentViewOwnerKey(get())
  const sameOwner = (a: string, b: string): boolean => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
  if (!sameOwner(owner, viewOwner)) return
  if (!get().settings?.rightPanelOpen) void get().setRightPanelOpen(true)
  useRightPanel.getState().open(toolSurface('terminal'))
  requestTerminalTab({ ownerKey: viewOwner, terminalId })
}

export function revealBrowserPane(get: () => Store, navigate: boolean): void {
  if (!get().settings?.rightPanelOpen) void get().setRightPanelOpen(true)
  const ui = useUiV3.getState()
  if (navigate) ui.navigate({ name: 'chat' })
  useRightPanel.getState().open(toolSurface('browser'))
  applyBrowserVisibility(get)
}

export type BrowserSlice = Pick<Store, 'browserState' | 'browserStates' | 'browserNativeVisible' | 'browserCover' | 'openBrowser' | 'openLink' | 'openExternalChrome' | 'closeExternalChrome' | 'syncLocalProfile' | 'syncPageStorage' | 'setBrowserSurfaceActive' | 'acquireOverlayBlocker'>

export function createBrowserSlice({ set, get }: SliceContext): BrowserSlice {
  const browserOpener = new BrowserOpener({
    open: (url) => window.yan.browser.open(url, get().peekedSessionId ?? get().session?.sessionId ?? 'workspace'),
    currentOwnerKey: () => currentViewOwnerKey(get()),
    resourceOwner: () => resourceOwner('browser'),
    claimResource: (owner) => claimResource('browser', owner),
    releaseResource: () => releaseResource('browser'),
    isBrowserOpen: () => get().browserState.open,
    setBrowserState: (browserState) => {
      if (browserState.sessionId && browserState.sessionId !== (get().peekedSessionId ?? get().session?.sessionId ?? 'workspace')) return
      set({ browserState })
    },
    reveal: () => revealBrowserPane(get, true),
    blocked: (reason) => {
      const text =
        reason === 'foreign-owner'
          ? uiText('state.browser.foreignOwner')
          : uiText('state.browser.busy')
      set({ notices: pushNotice(get().notices, 'warning', text) })
    },
    failed: (message) => {
      set({ notices: pushNotice(get().notices, 'error', stripIpcErrorPrefix(message)) })
    }
  })

  return {
  browserState: { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false },
  browserStates: {},
  browserNativeVisible: false,
  browserCover: null,
  openBrowser: async (url, target) => {
    const view = get()
    const owner = target?.key ?? (view.peekedPath || view.peekedSessionId
      ? workspaceKeyFor(viewKeyRef(view))
      : conversationKeyOf(view.session))
    await browserOpener.open({ owner, url, guard: true, takeover: target?.takeover ?? target === undefined })
  },
  openLink: async (url) => {
    const view = get()
    const sessionId = view.session?.sessionId ?? view.session?.conversationId ?? ''
    const owner = currentViewOwnerKey(view)
    let decision: string
    try {
      decision = (await window.yan.browser.siteAccess(sessionId, url)).decision
    } catch {
      return
    }
    if (decision === 'deny' || decision === 'forbidden') {
      set({ notices: pushNotice(get().notices, 'error', uiText('state.error.siteBlocked', { url })) })
      return
    }
    if (currentViewOwnerKey(get()) !== owner) return
    await get().openBrowser(url, { key: owner, takeover: true })
  },
  openExternalChrome: async (url) => {
    const res = await window.yan.browser.openExternalChrome(url)
    if (!res.ok) {
      set({ notices: pushNotice(get().notices, 'error', res.error ?? uiText('state.error.chromeConnectFailed')) })
      return
    }
    set({ browserState: await window.yan.browser.getState() })
  },
  closeExternalChrome: async () => {
    set({ browserState: await window.yan.browser.closeExternalChrome() })
  },
  syncLocalProfile: async () => {
    const report = await window.yan.browser.syncLocalProfile()
    set({ browserState: await window.yan.browser.getState() })
    return report
  },
  syncPageStorage: async () => {
    const report = await window.yan.browser.syncPageStorage()
    set({ browserState: await window.yan.browser.getState() })
    return report
  },
  setBrowserSurfaceActive: (active) => {
    browserSurfaceActive = active
    applyBrowserVisibility(get)
  },
  acquireOverlayBlocker: (token) => {
    overlayBlockers.acquire(token)
    applyBrowserVisibility(get)
    return () => {
      overlayBlockers.release(token)
      applyBrowserVisibility(get)
    }
  },
  }
}
