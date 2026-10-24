import { useStore } from './store'

export const MCP_SETTINGS_CHANGED = 'inkstone:mcp-settings-changed'

export function mcpViewKey(): string {
  const state = useStore.getState()
  return JSON.stringify([state.activeRunnerId, state.session?.sessionId, state.session?.cwd, state.peekedSessionId, state.peekedPath])
}

export function notifyMcpSettingsChanged(): void {
  window.dispatchEvent(new Event(MCP_SETTINGS_CHANGED))
}

export async function reloadCurrentMcp(expectedSessionId: string, context: string): Promise<void> {
  const result = await window.yan.capabilities.applyMcpServices({ context, expectedSessionId })
  if (!result.ok) throw new Error(result.error || 'MCP 重新加载失败')
  notifyMcpSettingsChanged()
}
