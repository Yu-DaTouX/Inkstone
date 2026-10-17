import { ipcMain } from 'electron'
import type { AuxWindows } from './aux-controller'
import type { MiniItem, QuickAskSubmit } from './aux-types'

function isQuickAskSubmit(value: unknown): value is QuickAskSubmit {
  if (!value || typeof value !== 'object') return false
  const p = value as Partial<QuickAskSubmit>
  return typeof p.prompt === 'string' && (p.target === 'new' || p.target === 'current')
}

export function registerAuxIpc(aux: AuxWindows): void {
  const guard = <T>(contents: Electron.WebContents, run: () => T): T => {
    if (!aux.owns(contents)) throw new Error('拒绝来自非辅助小窗的 IPC 调用')
    return run()
  }

  ipcMain.handle('yan:aux:quick-ask:state', (event) => guard(event.sender, () => aux.quickAskState()))
  ipcMain.handle('yan:aux:quick-ask:submit', (event, payload: unknown) =>
    guard(event.sender, () =>
      isQuickAskSubmit(payload) ? aux.submitQuickAsk(payload) : Promise.resolve({ ok: false, code: 'unavailable' as const })
    )
  )
  ipcMain.on('yan:aux:quick-ask:close', (event) => {
    if (aux.owns(event.sender)) aux.hideQuickAsk()
  })

  ipcMain.handle('yan:aux:mini:state', (event) => guard(event.sender, () => aux.miniState()))
  ipcMain.on('yan:aux:mini:open', (event, item: unknown) => {
    if (aux.owns(event.sender) && item && typeof item === 'object') aux.openMiniItem(item as MiniItem)
  })
  ipcMain.on('yan:aux:mini:close', (event) => {
    if (aux.owns(event.sender)) aux.hideMini()
  })
  ipcMain.on('yan:aux:mini:set-enabled', (event, enabled: unknown) => {
    if (aux.owns(event.sender)) aux.setMiniEnabled(!!enabled)
  })
}
