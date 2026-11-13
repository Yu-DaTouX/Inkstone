import { shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import { FRICTION_CAPTURE_CHANNEL, FRICTION_OPEN_CHANNEL, type FrictionCaptureResult } from '../../shared/friction'
import { FRICTION_DIR, saveFrictionCapture } from '../friction'
import { getSettings } from '../settings'
import type { IpcRegistrar } from './registrar'

export function registerFrictionIpc(ipc: IpcRegistrar): void {
  ipc.rawHandle(FRICTION_CAPTURE_CHANNEL, async (event, request: unknown): Promise<FrictionCaptureResult> => {
    const enabled = (await getSettings()).frictionRecorder === true
    try {
      return await saveFrictionCapture(event.sender, request, enabled)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipc.handle(FRICTION_OPEN_CHANNEL, async (): Promise<string> => {
    await mkdir(FRICTION_DIR, { recursive: true })
    return shell.openPath(FRICTION_DIR)
  })
}
