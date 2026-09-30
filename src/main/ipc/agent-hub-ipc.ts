import type { IpcRegistrar } from './registrar'
import type { AgentHubService } from '../agent-hub/service'
import type { HubCommand } from '../../shared/agent-hub'

export function registerAgentHubIpc(ipc: IpcRegistrar, hub: AgentHubService): void {
  ipc.handle('yan:hub:snapshot', () => hub.snapshot())
  ipc.handle('yan:hub:command', (command: HubCommand) => hub.command(command))
  ipc.handle('yan:hub:detect', async () => { await hub.detect(); return hub.snapshot() })
}
