import type { IpcRegistrar } from './registrar'
import { normalizeWorkflowId } from '../../shared/workflows'
import type { WorkflowService } from '../workflows/service'
import { pick } from '../../shared/ui-lang'

export function registerWorkflowsIpc(ipc: IpcRegistrar, service: WorkflowService): void {
  const { handle } = ipc
  handle('yan:workflows:list', async () => service.list())
  for (const action of ['pause', 'resume', 'stop'] as const) {
    handle(`yan:workflows:${action}`, async (id: unknown) => {
      const runId = normalizeWorkflowId(id)
      if (!runId) return { ok: false, error: pick('工作流 id 不合法', 'Invalid workflow id') }
      const result = await service.control(runId, action)
      return { ok: result.ok, ...(result.error ? { error: result.error } : {}) }
    })
  }
}
