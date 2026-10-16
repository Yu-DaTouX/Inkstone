/**
 * 用量统计的文件来源：主会话原生 JSONL 与子代理原生 JSONL。
 *
 * 为什么单独一个模块：会话搜索（session-search.ts）的 `listSessionFiles()` 范围
 * 服务于会话切换器，**不能**因为用量统计把子代理文件塞进去。这里另外枚举
 * `YAN_DIR/subagents/sessions/<sub-id>/*.jsonl`，并在交给统计前按真实路径去重。
 *
 * 边界：
 *   · 只读原生 JSONL；SubagentHistory 的 `.json` 快照不是权威用量，不读。
 *   · 不跟随目录符号链接，不递归到任意深度（默认 `<sub-id>/*.jsonl` 一层）。
 *   · 目录 / 文件缺失都返回空，不阻其它正常文件。
 */
import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { listSessionFiles } from './session-search'

/** 用量的两个来源：主会话与子代理。 */
export type UsageSourceKind = 'main' | 'subagent'

export interface UsageFileRef {
  path: string
  size: number
}

/**
 * 用量统计的路径来源。默认读真实数据目录；测试可注入临时目录，避免碰用户数据。
 */
export interface UsageSources {
  /** 主会话原生 JSONL（沿用会话搜索的枚举范围，不改它） */
  listMain(): Promise<UsageFileRef[]>
  /** 子代理原生 JSONL（每个子代理各自的 session 目录） */
  listSubagents(): Promise<UsageFileRef[]>
  /** 增量缓存文件 */
  cacheFile: string
}

/** 子代理归档根：与 `subagents.ts` 的 `archiveDir` 默认值一致。 */
export function subagentArchiveDir(): string {
  return join(YAN_DIR, 'subagents')
}

/** 子代理原生 session 根：`<archiveDir>/sessions`。 */
export function subagentSessionsRoot(archiveDir = subagentArchiveDir()): string {
  return join(archiveDir, 'sessions')
}

/**
 * 列出目录下（最多 `maxDepth` 层）的 `.jsonl` 文件。
 *
 * 默认一层，覆盖 `<root>/<sub-id>/*.jsonl`；pi 在显式 `--session-dir` 下不建项目子目录，
 * 也覆盖直接落在 `<root>/*.jsonl` 的情况。目录不存在、被删或读取失败都返回已收集的部分。
 */
export async function listRawSessionFiles(root: string, maxDepth = 1): Promise<UsageFileRef[]> {
  const files: UsageFileRef[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        /* 不进入符号链接目录，避免任意目录扩散 */
        if (depth < maxDepth) await walk(path, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const info = await stat(path)
          if (info.isFile()) files.push({ path, size: info.size })
        } catch {
          /* 列目录与 stat 之间被删：跳过 */
        }
      }
    }
  }
  await walk(root, 0)
  return files
}

/** 主会话：复用会话搜索的枚举，不扩大它的范围。 */
export async function listMainUsageFiles(): Promise<UsageFileRef[]> {
  return (await listSessionFiles()).map((file) => ({ path: file.path, size: file.size }))
}

export function defaultUsageSources(): UsageSources {
  return {
    listMain: listMainUsageFiles,
    listSubagents: () => listRawSessionFiles(subagentSessionsRoot()),
    cacheFile: join(YAN_DIR, 'usage-stats.json')
  }
}

/**
 * 规范化物理路径：解析符号链接 / 别名，Windows 下再统一大小写。
 *
 * 分辨率失败（文件刚被删）返回空串，调用方跳过该文件。
 */
export async function canonicalUsagePath(path: string): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(path)
  } catch {
    return ''
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
