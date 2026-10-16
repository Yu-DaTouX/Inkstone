import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const EXTENSION_FILE = /\.(?:ts|mts|cts|js|mjs|cjs)$/i

export interface ExtensionExpectation {
  piDir: string
  yanThinPaths?: string[]
  nativeDiscovery: boolean
}

export function readUserExtensions(piDir: string): string[] {
  const dir = join(piDir, 'extensions')
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => {
      if (e.isDirectory() || EXTENSION_FILE.test(e.name)) return true
      if (!e.isSymbolicLink()) return false
      try {
        const stat = statSync(join(dir, e.name))
        return stat.isDirectory() || stat.isFile() && EXTENSION_FILE.test(e.name)
      } catch { return false }
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

export function extensionDiagnostics(opts: ExtensionExpectation): string[] {
  let user: string[]
  let readError: string | undefined
  try { user = readUserExtensions(opts.piDir) }
  catch (error) { user = []; readError = error instanceof Error ? error.message : String(error) }
  const thin = (opts.yanThinPaths ?? []).map((p) => basename(p)).filter(Boolean)
  const lines: string[] = []

  if (user.length) {
    lines.push(
      `[来源] 用户扩展 ${user.length} 项：${user.join('、')}` +
        (opts.nativeDiscovery
          ? '（由 pi 原生发现；是否加载由 pi 设置与项目信任决定，目录清单不代表已加载；不删除、不改写）'
          : '（旧版 runner 使用 --no-extensions，不自动加载；不删除、不改写）')
    )
  } else {
    lines.push(readError ? `[来源] 用户扩展目录读取失败：${readError}` : '[来源] 未检测到用户扩展（pi 的扩展目录是空的）')
  }

  lines.push(
    `[来源] 砚内置薄层 ${thin.length} 项：${thin.join('、') || '（无）'}` +
      `（显式传入；承载宿主生命周期与授权适配，不注册模型工具；上下文由 Agent 原生管理，交互提问走宿主 yan question ask）`
  )

  lines.push(
    '[来源] 历史会话里的 `left-panel-tasks` 只读，砚内置任务计划写宿主日志（数据目录下的 task-plans），' +
      '不会覆盖或回写旧条目'
  )

  return lines
}

export interface BuiltinCapability {
  id: string
  file?: string
}

export function builtinCapabilities(thinPaths: readonly string[]): BuiltinCapability[] {
  const list: BuiltinCapability[] = [{ id: 'task-plan' }, { id: 'browser' }]
  const seen = new Set(list.map((c) => c.id))
  for (const p of thinPaths) {
    const file = basename(p)
    if (!file) continue
    const id = file.replace(/\.(?:js|mjs|cjs|ts|mts|cts)$/i, '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    list.push({ id, file })
  }
  return list
}
