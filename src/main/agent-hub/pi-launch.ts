import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentOwnedPiArgs, nativePiToolsSupported } from '../../shared/agent-context'

/** Use pi's session and skill handling; only the shared authorization adapter is owned here. */
export function hubPiArgs(resourcesDir: string, sessionDir: string, version?: string, model?: string): string[] {
  const guard = ['yan-thin', 'pi-extensions'].map(dir => join(resourcesDir, dir, 'danger-guard.js')).find(existsSync)
  if (!guard) throw new Error('pi 高危操作授权适配缺失，无法开始派活')
  return agentOwnedPiArgs(['--session-dir', sessionDir, '--no-extensions', '--extension', guard, ...(model ? ['--model', model] : [])], nativePiToolsSupported(version))
}
