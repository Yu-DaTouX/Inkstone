/**
 * 桌面端数据的存放位置。
 *
 * ⚠️ 这里**只**放路径常量。
 *
 * 历史上这个文件叫 `memory.ts`，装着整套「记忆」系统（MemoryStore / soul.md
 * 只读读 / 认识论规则）。记忆功能已整体移除（用户要求），只剩目录约定 ——
 * 桌面端设置（`desktop.json`）还落在这里。
 *
 * 目录里可能还留着旧的 `memory.json` / `soul.md`：**不主动删**，
 * 那是用户的数据，要清自己清。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

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
  process.env.YAN_PI_DIR?.trim() ||
  (PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'pi-agent') : join(homedir(), '.pi', 'agent'))

/** Electron 的 localStorage / cache / sessionData 所在目录。 */
export const ELECTRON_USER_DATA_DIR =
  process.env.YAN_USER_DATA?.trim() ||
  (PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'electron') : undefined)

/** 崩溃转储也可能含页面或进程片段，便携版不能让它落到系统临时目录。 */
export const ELECTRON_CRASH_DUMPS_DIR = PORTABLE_DATA_DIR
  ? join(PORTABLE_DATA_DIR, 'crash-dumps')
  : undefined

/**
 * 桌面端数据目录。`YAN_DATA_DIR` 可覆盖 —— 测试用隔离目录，免得碰真实数据。
 * 便携版则固定落在 EXE 同级的「砚数据」中。
 */
export const YAN_DIR =
  process.env.YAN_DATA_DIR?.trim() ||
  (PORTABLE_DATA_DIR ? join(PORTABLE_DATA_DIR, 'yan') : join(PI_AGENT_DIR, 'yan'))
