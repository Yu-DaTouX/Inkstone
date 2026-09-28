/**
 * 内置浏览器的 IPC 适配（`yan:browser:*`）。
 *
 * 浏览器控制器是原生层（WebContentsView），生命周期由应用入口管理：
 * 窗口重建时控制器会换一个实例，所以这里每次调用都经 `browserOf()` 取当前那个，
 * 而不是在注册时抓住一个引用。控制器还没建好时返回与真实结果同形的「未打开」值。
 */
import type { BrowserController } from '../browser'
import type { IpcRegistrar } from './registrar'

const CLOSED_STATE = { open: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
const NOT_READY = { ok: false, error: '浏览器未初始化' }

export function registerBrowserIpc(ipc: IpcRegistrar, browserOf: () => BrowserController | null): void {
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
  rawHandle('yan:browser:setUserControl', (_e, value: boolean) => browserOf()?.setUserControl(Boolean(value)))
  rawHandle('yan:browser:setBounds', (_e, bounds: { x: number; y: number; width: number; height: number }) => {
    browserOf()?.setBounds(bounds)
  })
  /* 文件预览占用同一区域时，把原生视图临时藏起来（方案 5.2） */
  rawHandle('yan:browser:setVisible', (_e, visible: unknown) => {
    browserOf()?.setViewVisible(visible !== false)
  })
}
