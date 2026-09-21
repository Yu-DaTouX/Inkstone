/**
 * 桌面端数据的存放位置。
 *
 * ⚠️ 这里**只**放路径常量。
 *
 * 数据目录职责：桌面端设置（`desktop.json`）落在这里；`YAN_DIR` 下还有会话派生状态、
 * 任务日志、项目知识等子目录 —— 各自由对应模块维护，本文件**只管路径常量**。
 *
 * 这里历史上是「记忆」系统（`memory.ts` / MemoryStore / soul.md 只读）。那套功能已整体移除，
 * 且**不会恢复**（AGENTS.md 第五节）；新「项目知识」（`docs/plan/实施-03-项目知识与旧记忆清理-已完成.md`）
 * 是独立新功能，不是把它接回来。
 *
 * 但用户目录里可能还留着旧的 `memory.json` / `soul.md`：**不主动删** ——
 * 那是用户的数据，要清自己清。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/*
 * electron-builder 的 portable wrapper 在部分启动方式下不会把自定义
 * 环境变量完整带到解压后的 GUI 子进程。验收脚本因此可以用同名的
 * `--yan-*-dir=` 参数兜底；正常启动没有这些参数，仍只看环境变量。
 * 这里要在本模块导出路径常量之前恢复环境变量，因为 sessions/settings
 * 等模块会在导入时直接读取 process.env。
 */
function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length).trim() || undefined : undefined
}

function envOrArg(envName: string, argName: string): string | undefined {
  const current = process.env[envName]?.trim()
  if (current) return current
  const fallback = argValue(argName)
  if (fallback) process.env[envName] = fallback
  return fallback
}

/**
 * electron-builder 的 single-file portable wrapper 会传入这个环境变量。
 * 它指向用户双击的 EXE 所在目录，而不是 wrapper 临时解压出来的目录。
 *
 * 便携版的用户数据必须以它为根：否则 Electron / pi 会悄悄把会话、凭证或
 * cache 写回用户主目录，移动 EXE 时也无法把私人数据一起带走。
 */
const PORTABLE_EXECUTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR?.trim()
export const PORTABLE_DATA_DIR = PORTABLE_EXECUTABLE_DIR
  ? join(PORTABLE_EXECUTABLE_DIR, '砚数据')
  : undefined

/** pi 的完整私有目录：凭证、pi 设置、会话和 pi 自己的缓存都在这里。 */
export const PI_AGENT_DIR =
  envOrArg('YAN_PI_DIR', 'yan-pi-dir') ||
  (PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'pi-agent') : join(homedir(), '.pi', 'agent'))

/** Electron 的 localStorage / cache / sessionData 所在目录。 */
export const ELECTRON_USER_DATA_DIR =
  envOrArg('YAN_USER_DATA', 'yan-user-data') ||
  (PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'electron') : undefined)

/** 崩溃转储也可能含页面或进程片段，便携版不能让它落到系统临时目录。 */
export const ELECTRON_CRASH_DUMPS_DIR = PORTABLE_DATA_DIR
  ? join(PORTABLE_DATA_DIR, 'crash-dumps')
  : undefined

/**
 * 浏览器下载的落盘目录。默认是系统下载目录。
 *
 * `YAN_DOWNLOADS_DIR` 可覆盖 —— 验收测试会真的触发下载，
 * 往用户真实的下载目录里丢测试文件是不可接受的。
 *（下载过的文件就是用户文件，测试不能自己删。）
 */
export const DOWNLOADS_DIR = envOrArg('YAN_DOWNLOADS_DIR', 'yan-downloads-dir') || undefined

/**
 * 桌面端数据目录。`YAN_DATA_DIR` 可覆盖 —— 测试用隔离目录，免得碰真实数据。
 * 便携版则固定落在 EXE 同级的「砚数据」中。
 */
export const YAN_DIR =
  envOrArg('YAN_DATA_DIR', 'yan-data-dir') ||
  (PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'yan') : join(PI_AGENT_DIR, 'yan'))

/**
 * 项目知识的根目录（实施-03）：一个项目一个子目录。
 *
 * 为什么按 `projectId` 分目录而不是一个大文件：项目之间必须**物理隔离** ——
 * 「A 项目读不到 B 项目的知识」这类保证不该只靠查询条件（漏一个 where 就串了）。
 * `projectId` 由项目登记给出，条目写入前会再校验形状（见 project-memory-store）。
 */
export const PROJECT_KNOWLEDGE_DIRNAME = 'project-knowledge'
export const PROJECT_KNOWLEDGE_ROOT = join(YAN_DIR, PROJECT_KNOWLEDGE_DIRNAME)

/** 单个项目的知识目录：`YAN_DIR/project-knowledge/<projectId>/`。 */
export function projectKnowledgeDir(projectId: string): string {
  return join(PROJECT_KNOWLEDGE_ROOT, projectId)
}
