/** 定时任务面板的 IPC 适配（`yan:schedule:*`），与模型的 `yan schedule …` 共用同一个服务。 */
import type { IpcRegistrar } from './registrar'
import type { ScheduleService } from '../schedule-service'

export function registerScheduleIpc(ipc: IpcRegistrar, service: ScheduleService): void {
  const { handle } = ipc
  handle('yan:schedule:list', async () => service.list())
  handle('yan:schedule:create', async (input: Record<string, unknown>) => service.create(input ?? {}, 'user'))
  handle('yan:schedule:update', async (id: string, input: Record<string, unknown>) => service.update(String(id ?? ''), input ?? {}))
  handle('yan:schedule:enabled', async (id: string, enabled: boolean) => service.setEnabled(String(id ?? ''), enabled === true))
  handle('yan:schedule:remove', async (id: string) => ({ ok: await service.remove(String(id ?? '')) }))
  handle('yan:schedule:run', async (id: string) => service.runNow(String(id ?? '')))
}
