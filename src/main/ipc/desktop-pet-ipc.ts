import type { IpcRegistrar } from './registrar'
import {
  desktopPetStatus,
  installDesktopPet,
  setDesktopPetAutoStart,
  setDesktopPetModel,
  startDesktopPet,
  stopDesktopPet,
  uninstallDesktopPet
} from '../desktop-pet'

export function registerDesktopPetIpc(ipc: IpcRegistrar): void {
  const { handle } = ipc
  handle('yan:desktopPet:status', async () => desktopPetStatus())
  handle('yan:desktopPet:install', async () => installDesktopPet())
  handle('yan:desktopPet:start', async () => startDesktopPet())
  handle('yan:desktopPet:stop', async () => stopDesktopPet())
  handle('yan:desktopPet:uninstall', async () => uninstallDesktopPet())
  handle('yan:desktopPet:autoStart', async (enabled: unknown) => setDesktopPetAutoStart(enabled === true))
  handle('yan:desktopPet:setModel', async (model: unknown) => setDesktopPetModel(typeof model === 'string' ? model : null))
}
