/** 只读文件 IPC 的目录来源边界；目录存在不等于调用方有权把它当工作区。 */
import { realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'

function directoryKey(path: string): string {
  const normalized = normalize(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** 项目默认目录变化后，只有宿主已打开、且归属此项目的会话可继续访问旧目录。 */
export async function isRunnerProjectCwd(cwd: string, projectId: string, runners: ReadonlyArray<{ cwd: string; projectId?: string }>): Promise<boolean> {
  return isAuthorizedFileCwd(cwd, runners.filter((runner) => runner.projectId === projectId).map((runner) => runner.cwd))
}

export async function isAuthorizedFileCwd(cwd: string, allowedCwds: readonly string[]): Promise<boolean> {
  if (!isAbsolute(cwd)) return false
  const allowed = allowedCwds.filter((path) => typeof path === 'string' && isAbsolute(path))
  if (allowed.some((path) => directoryKey(path) === directoryKey(cwd))) return true
  // 接受同一目录的链接路径，但不把项目的任意父目录或子目录变成新的根。
  let target: string
  try { target = directoryKey(await realpath(cwd)) } catch { return false }
  for (const path of allowed) {
    try { if (directoryKey(await realpath(path)) === target) return true } catch { /* 失效目录不授权 */ }
  }
  return false
}
