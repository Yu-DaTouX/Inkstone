import type { IpcRegistrar } from './registrar'
import {
  installOpenCodeProxy,
  openCodeProxyStatus,
  refreshOpenCodeProxy,
  setOpenCodeProxyAutoStart,
  startOpenCodeProxy,
  stopOpenCodeProxy,
  uninstallOpenCodeProxy
} from '../opencode-proxy'

export interface OpenCodeProxyIpcDeps {
  restartAgent(reason: string): Promise<void>
}

export function registerOpenCodeProxyIpc(ipc: IpcRegistrar, deps: OpenCodeProxyIpcDeps): void {
  const { handle } = ipc
  const reload = (reason: string): void => {
    void deps.restartAgent(reason).catch((error) => console.error('[opencode-proxy] 刷新运行实例失败', error))
  }
  handle('yan:opencodeProxy:status', async () => openCodeProxyStatus())
  handle('yan:opencodeProxy:install', async () => {
    const result = await installOpenCodeProxy()
    if (result.ok) reload('OpenCode 反代已安装')
    return result
  })
  handle('yan:opencodeProxy:start', async () => {
    const result = await startOpenCodeProxy()
    if (result.ok) reload('OpenCode 反代已启动')
    return result
  })
  handle('yan:opencodeProxy:stop', async () => stopOpenCodeProxy())
  handle('yan:opencodeProxy:refresh', async () => {
    const result = await refreshOpenCodeProxy()
    if (result.ok) reload('OpenCode 反代模型已刷新')
    return result
  })
  handle('yan:opencodeProxy:uninstall', async () => {
    const result = await uninstallOpenCodeProxy()
    if (result.ok) reload('OpenCode 反代已卸载')
    return result
  })
  handle('yan:opencodeProxy:autoStart', async (enabled: unknown) => setOpenCodeProxyAutoStart(enabled === true))
}
