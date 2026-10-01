import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentOwnedPiArgs, nativePiToolsSupported } from '../../shared/agent-context'

/** Use native sessions and skills with shared authorization and desktop tool preferences. */
export function hubPiArgs(resourcesDir: string, sessionDir: string, version?: string, model?: string): string[] {
  const guard = ['yan-thin', 'pi-extensions'].map(dir => join(resourcesDir, dir, 'danger-guard.js')).find(existsSync)
  if (!guard) throw new Error('pi 高危操作授权适配缺失，无法开始派活')
  const native = nativePiToolsSupported(version)
  const policy = ['yan-thin', 'pi-extensions'].map(dir => join(resourcesDir, dir, 'codemode-policy.js')).find(existsSync)
  return agentOwnedPiArgs(['--session-dir', sessionDir, '--no-extensions', ...(native && policy ? ['--extension', policy] : []), '--extension', guard, ...(model ? ['--model', model] : [])], native)
}
