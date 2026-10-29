import { CapabilityCommandError, type CapabilityCommandResult } from './capability-server'

export type PluginCommandHandler = (command: string, params: Record<string, unknown>, context: { cwd: string }, signal?: AbortSignal) => Promise<CapabilityCommandResult>
let handler: PluginCommandHandler | undefined
export function configurePluginCommands(next: PluginCommandHandler): void { handler = next }
export function runPluginCommand(command: string, params: Record<string, unknown>, context: { cwd: string }, signal?: AbortSignal): Promise<CapabilityCommandResult> {
  if (!handler) throw new CapabilityCommandError('plugin_unavailable', '此命令由可安装插件提供，请先在插件市场安装并重载会话')
  return handler(command, params, context, signal).catch((error: unknown) => {
    const failure = error as { code?: unknown; message?: unknown }
    if (typeof failure?.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(failure.code)) throw new CapabilityCommandError(failure.code, String(failure.message ?? error))
    throw error
  })
}
