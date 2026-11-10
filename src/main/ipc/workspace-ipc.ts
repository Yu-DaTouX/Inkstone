import type { IpcRegistrar } from './registrar'
import { changeProjectDirectory } from '../project-directory'
import { providerQuotaWithFallback } from '../quota'

export function registerWorkspaceIpc(ipc: IpcRegistrar): void {
  const { rawHandle } = ipc
  rawHandle('yan:project:changeDirectory', (_event, request: unknown) => changeProjectDirectory(request))

  rawHandle('yan:providerQuota', (_e, provider: unknown, budget: unknown) => providerQuotaWithFallback(String(provider ?? ''), Number(budget) || undefined))
}
