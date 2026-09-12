/**
 * 读 pi 的**压缩设置**，用来在界面上说明「什么时候会自动压缩上下文」。
 *
 * ── 为什么要读 pi 的文件，而不是写死 16384 ──
 * 阈值是用户可配的（`~/.pi/agent/settings.json` 或
 * `<项目>/.pi/settings.json` 里的 `compaction.reserveTokens`）。
 * 界面上显示一个和实际生效值不符的数字，比不显示更糟 ——
 * 用户会据此判断「还能聊多久」，而这是个会让他丢掉上下文的决定。
 *
 * 事实来源（已核实，见 pi 的 docs/compaction.md 与 bundle 里的
 * `DEFAULT_COMPACTION_SETTINGS`）：
 *
 *     触发条件：contextTokens > contextWindow - reserveTokens
 *     默认值：  reserveTokens = 16384, keepRecentTokens = 20000, enabled = true
 *     优先级：  项目级 settings.json 覆盖用户级（与 pi 自己的行为一致）
 *
 * ⚠️ 只读，不写 pi 的设置文件 —— 那是 TUI 和扩展的领地
 *    （与 main/settings.ts 的第一条约定相同）。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CompactionInfo } from '../shared/ipc'

/** pi 的默认值。改这里之前先看 pi 的 docs/compaction.md */
const DEFAULTS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }

interface PartialCompaction {
  enabled?: unknown
  reserveTokens?: unknown
  keepRecentTokens?: unknown
}

function pick(v: unknown, base: typeof DEFAULTS): typeof DEFAULTS {
  const o = (v && typeof v === 'object' ? v : {}) as PartialCompaction
  const num = (x: unknown, d: number): number =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : d
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    reserveTokens: num(o.reserveTokens, base.reserveTokens),
    keepRecentTokens: num(o.keepRecentTokens, base.keepRecentTokens)
  }
}

async function readJson(p: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    // 文件不存在 / 坏了都当「没配」
    return null
  }
}

/**
 * 取生效的压缩设置（项目级覆盖用户级），并算出触发点。
 *
 * `contextWindow` 由调用方传入（来自当前模型 / 会话状态）——
 * 本模块不猜它，因为不同模型的窗口差很多。
 */
export async function compactionInfo(cwd: string, contextWindow: number): Promise<CompactionInfo> {
  const userFile = join(homedir(), '.pi', 'agent', 'settings.json')
  const projFile = join(cwd, '.pi', 'settings.json')

  const [userRaw, projRaw] = await Promise.all([readJson(userFile), readJson(projFile)])
  const fromUser = pick((userRaw as { compaction?: unknown })?.compaction, DEFAULTS)
  const fromProj = pick((projRaw as { compaction?: unknown })?.compaction, fromUser)

  /*
   * 触发线：窗口 - 预留。
   * 夹到 ≥0 —— 预留比窗口还大时（用户把 reserveTokens 配得离谱）
   * 不能给出负数，那会让界面显示「已经该压缩了」。
   */
  const win = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.round(contextWindow) : 0
  const threshold = Math.max(0, win - fromProj.reserveTokens)

  return {
    enabled: fromProj.enabled,
    reserveTokens: fromProj.reserveTokens,
    keepRecentTokens: fromProj.keepRecentTokens,
    contextWindow: win,
    threshold,
    /** 触发点是用户自己配的，还是 pi 的默认值 —— 界面上要能说清 */
    custom: JSON.stringify(fromProj) !== JSON.stringify(DEFAULTS)
  }
}
