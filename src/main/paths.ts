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
 * 数据目录。`YAN_DATA_DIR` 可覆盖 —— 测试用隔离目录，免得碰真实数据。
 */
export const YAN_DIR =
  process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
