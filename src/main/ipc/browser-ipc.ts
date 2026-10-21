import type { BrowserController } from '../browser'
import type { IpcRegistrar } from './registrar'
import type { PreviewSiteGate } from '../preview-site-gate'
import { fetchRemoteImage } from '../remote-image'

const CLOSED_STATE = { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
const NOT_READY = { ok: false, error: '浏览器未初始化' }

export function registerBrowserIpc(
  ipc: IpcRegistrar,
  browserOf: () => BrowserController | null,
  siteGate?: PreviewSiteGate,
  answerSiteAsk?: (id: string, allowed: boolean) => void
): void {
  const { rawHandle } = ipc
  rawHandle('yan:browser:getState', () => browserOf()?.getState() ?? CLOSED_STATE)
  rawHandle('yan:browser:open', async (_e, url?: string) => browserOf()?.open(url) ?? CLOSED_STATE)
  rawHandle('yan:browser:observe', async () => browserOf()?.observe() ?? {
    generationId: '', url: '', title: '', text: '', elements: [], accessibilityNodeCount: 0, domSnapshotCaptured: false
  })
  rawHandle('yan:browser:network', async () => browserOf()?.network() ?? { capturedAt: Date.now(), entries: [], limit: 80 })
  rawHandle('yan:browser:newTab', async (_e, url?: string) => browserOf()?.newTab(url))
  rawHandle('yan:browser:switchTab', async (_e, id: string) => browserOf()?.switchTab(id))
  rawHandle('yan:browser:closeTab', async (_e, id?: string) => browserOf()?.closeTab(id))
  rawHandle('yan:browser:close', async () => browserOf()?.close())
  rawHandle('yan:browser:navigate', async (_e, url: string) => browserOf()?.navigate(url) ?? NOT_READY)
  rawHandle('yan:browser:siteAccess', async (_e, sessionId: unknown, url: unknown) => ({
    decision: siteGate ? await siteGate.check(typeof sessionId === 'string' ? sessionId : '', String(url ?? '')) : 'allow'
  }))
  rawHandle('yan:browser:remoteImage', async (_e, sessionId: unknown, url: unknown, prompt: unknown) => {
    await siteGate?.ready()
    return fetchRemoteImage({ gate: siteGate ?? null }, typeof sessionId === 'string' ? sessionId : '', url, prompt === true)
  })
  const loadedGate = async (): Promise<PreviewSiteGate | undefined> => {
    await siteGate?.ready()
    return siteGate
  }
  rawHandle('yan:browser:allowedSites', async () => (await loadedGate())?.sites() ?? [])
  rawHandle('yan:browser:addAllowedSite', async (_e, value: unknown) =>
    (await loadedGate())?.addSite(String(value ?? '')) ?? { result: 'unavailable', list: [] }
  )
  rawHandle('yan:browser:removeAllowedSite', async (_e, value: unknown) =>
    (await loadedGate())?.removeSite(String(value ?? '')) ?? { removed: false, list: [] }
  )
  rawHandle('yan:browser:clearAllowedSites', async () => (await loadedGate())?.clearSites() ?? [])
  rawHandle('yan:browser:siteAskAnswer', (_e, id: unknown, allowed: unknown) => {
    if (typeof id === 'string') answerSiteAsk?.(id, allowed === true)
  })
  rawHandle('yan:browser:back', () => browserOf()?.back() ?? NOT_READY)
  rawHandle('yan:browser:forward', () => browserOf()?.forward() ?? NOT_READY)
  rawHandle('yan:browser:reload', () => browserOf()?.reload() ?? NOT_READY)
  rawHandle('yan:browser:openExternal', (_e, url?: string) => browserOf()?.openExternal(url) ?? NOT_READY)
  rawHandle('yan:browser:openExternalChrome', (_e, url?: string) => browserOf()?.openExternalChrome(url) ?? NOT_READY)
  rawHandle('yan:browser:closeExternalChrome', () => browserOf()?.closeExternalChrome())
  rawHandle('yan:browser:syncLocalProfile', () =>
    browserOf()?.syncLocalProfile() ?? { found: false, copied: [], failed: [], chromeRunning: false, cookiesSynced: false }
  )
  rawHandle('yan:browser:syncPageStorage', () => browserOf()?.syncPageStorage() ?? Promise.reject(new Error('浏览器未初始化')))
  rawHandle('yan:browser:setPermission', (_e, permission: string, origin: string, allowed: boolean) =>
    browserOf()?.setPermission(String(permission ?? ''), String(origin ?? ''), Boolean(allowed)) ?? NOT_READY
  )
  rawHandle('yan:browser:setBounds', (_e, bounds: { x: number; y: number; width: number; height: number }) => {
    browserOf()?.setBounds(bounds)
  })
  rawHandle('yan:browser:setVisible', (_e, visible: unknown) => {
    browserOf()?.setViewVisible(visible !== false)
  })
}
