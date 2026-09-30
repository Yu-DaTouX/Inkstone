import type { IpcRegistrar } from './registrar'
import type { AgentController } from '../agent'
import { AGENT_CONTEXT_ERROR } from '../../shared/agent-context'
import { readContextActions } from '../context-actions'
import { readContextBackgroundUsage } from '../context-background-usage'

export interface ContextBudgetIpcDeps { currentAgent(): AgentController | undefined }

/** Old IPC names remain readable, but cannot re-enable host context management. */
export function registerContextBudgetIpc(ipc: IpcRegistrar, deps: ContextBudgetIpcDeps): void {
  ipc.rawHandle('yan:contextBudget', () => null)
  ipc.rawHandle('yan:contextBudgetV1', () => null)
  ipc.rawHandle('yan:contextBudgetV1Enabled', () => false)
  ipc.rawHandle('yan:contextBudgetSnapshotV1', () => null)
  ipc.rawHandle('yan:contextBudgetMaintainV1', () => ({ ok: false, error: AGENT_CONTEXT_ERROR }))
  ipc.rawHandle('yan:contextBudgetMaintenanceStatusV1', () => null)
  ipc.rawHandle('yan:setContextBudgetV1', () => ({ ok: false, error: AGENT_CONTEXT_ERROR }))
  ipc.rawHandle('yan:setContextBudgetMaterialPinV1', () => ({ ok: false, error: AGENT_CONTEXT_ERROR }))
  ipc.rawHandle('yan:contextBudgetMaintenanceExitV1', () => ({ ok: false, error: AGENT_CONTEXT_ERROR }))
  ipc.rawHandle('yan:contextActions', () => readContextActions(deps.currentAgent()?.getState()?.sessionId ?? null))
  ipc.rawHandle('yan:contextBackgroundUsage', () => readContextBackgroundUsage(deps.currentAgent()?.getState()?.sessionId ?? null))
}
