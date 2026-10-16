import { realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'

function directoryKey(path: string): string {
  const normalized = normalize(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export async function isRunnerProjectCwd(cwd: string, projectId: string, runners: ReadonlyArray<{ cwd: string; projectId?: string }>): Promise<boolean> {
  return isAuthorizedFileCwd(cwd, runners.filter((runner) => runner.projectId === projectId).map((runner) => runner.cwd))
}

export async function isAuthorizedFileCwd(cwd: string, allowedCwds: readonly string[]): Promise<boolean> {
  if (!isAbsolute(cwd)) return false
  const allowed = allowedCwds.filter((path) => typeof path === 'string' && isAbsolute(path))
  if (allowed.some((path) => directoryKey(path) === directoryKey(cwd))) return true
  let target: string
  try { target = directoryKey(await realpath(cwd)) } catch { return false }
  for (const path of allowed) {
    try { if (directoryKey(await realpath(path)) === target) return true } catch { }
  }
  return false
}
