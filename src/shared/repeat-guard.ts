/**
 * 单轮重复动作兜底 —— 契约与宿主侧纯逻辑（2026-09-22）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要这一层
 * ══════════════════════════════════════════════════════════════════
 * 模型抽风时最典型的形状是：**用完全相同的参数反复调同一个工具**
 * （同一个 `bash` 命令反复跑、同一个文件反复读、同一个 grep 反复搜）。
 * 轮与轮之间早就有上限了（自主档 `AUTONOMOUS_CONTINUE_LIMIT = 8`、
 * 标准档 3 次退避、`FAILURE_BLOCK_THRESHOLD = 2`），但**一轮之内**原来
 * 没有任何检测 —— 它可以在一次回合里烧掉很多次调用而没人拦。
 *
 * ══════════════════════════════════════════════════════════════════
 * 分工（和交接包、目标续行同一个形状：看得见的做判定，宿主做存储）
 * ══════════════════════════════════════════════════════════════════
 *   · **薄层 `resources/pi-extensions/repeat-guard.js`** 是唯一能看见每次
 *     工具调用参数的地方（`tool_call` 钩子），所以判定与拦截在那里：
     连续 3 次 → 下一次请求前注入一句提醒（**不打断**）、连续 5 次 → 拦下该次调用。
 *   · **宿主**只做薄层做不到的那件事：把「被拦下」计入**目标失败签名**
 *     （薄层既没有 `yan` CLI，也不能改目标存储）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 边界（用户明确要求：**不干扰正常工作**）
 * ══════════════════════════════════════════════════════════════════
 *   · 判据只认「**同一工具 + 规范化参数逐字相同 + 连续**」：中间夹了任何
 *     别的调用就清零 —— 正常干活会不断换工具 / 换参数，碰不到这条线；
 *   · 一个「重复串」里只提醒一次（不做每轮唠叨的复读机）；
 *   · 不设单轮步数硬上限（那是另一件事：不拿「跑了多少步」当罪状）；
 *   · 用户发言、或目标报了进展（换路径了）→ 整串归零。
 *
 * 指纹与阈值必须与薄层**同语义**（薄层是 JS，不能 import 这里的 TS）：
 *   · 指纹 = `工具名 + '\n' + 参数按 key 排序后的 JSON`；
 *   · 阈值默认 3 / 5，薄层可用 `YAN_REPEAT_WARN_AT` / `YAN_REPEAT_BLOCK_AT` 覆盖（测试用）。
 */

/**
 * 计入目标失败签名时用的**固定签名**。
 *
 * 为什么不带工具名或参数：这条机制要表达的是「同一个坏习惯又出现了」，
 * 而 `FAILURE_BLOCK_THRESHOLD` 的语义正是「同一失败签名连续两次 → blocked」。
 * 带上参数会让每次调用都是一个新签名、阈值永远攒不满，等于没有兜底。
 * 具体是哪个工具、哪条命令，留在薄层的日志与计数文件里（排障用的那一层）。
 */
export const REPEAT_BLOCK_SIGNATURE = 'repeat-tool-call'

/** 薄层写计数文件的目录名（`<YAN_DATA_DIR>/repeat-guard/`）。 */
export const REPEAT_GUARD_DIR = 'repeat-guard'

/** 默认阈值：连续 3 次提醒（不打断）、连续 5 次拦下。 */
export const REPEAT_WARN_AT = 3
export const REPEAT_BLOCK_AT = 5

/**
 * 一次「被拦下」最多能补记几次失败。
 *
 * 防的是**脏文件**：把计数一次推到几千，会把目标瞬间打成 blocked。
 * 真到需要看这么大的数字时，日志里早就写得清清楚楚了。
 */
const MAX_PENDING_FAILURES = 10

/**
 * 计数文件的键（与薄层 `goal-resume.js` 的 `safeKey()` 同语义）。
 *
 * 清洗规则不一致会让两边指向不同文件 —— 表现是「薄层一直在拦、宿主永远不知道」。
 * 单测对这两处做了交叉校验（与 `handoffFileKey` 同一个约定）。
 * 路径本身由 main 侧用 `join()` 拼（shared 不放 node 依赖，和 `handoffFileKey` 一样）。
 */
export function repeatGuardKey(sessionKey: unknown): string {
  const key = typeof sessionKey === 'string' ? sessionKey.trim() : ''
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
}

/** 薄层写进计数文件的内容。 */
export interface RepeatGuardSnapshot {
  /** 累计被拦下的次数（薄层写；含拦下前的提醒次数不在此列）。 */
  blocks: number
  /** 最近一次被拦下的工具名（只用于日志与界面文案）。 */
  tool: string | null
  /** 最近一次被拦下的时间。 */
  updatedAt: number | null
}

/**
 * 宽容解析计数文件。
 *
 * 脏值 / 缺字段 / 根本不是对象，一律当 0（**宁可少记一次失败，也不凭空 blocked**）：
 * 这条链路里「多拦一次」的代价远小于「把正常目标误判成 blocked」。
 */
export function parseRepeatGuardSnapshot(raw: unknown): RepeatGuardSnapshot {
  const empty: RepeatGuardSnapshot = { blocks: 0, tool: null, updatedAt: null }
  if (!raw || typeof raw !== 'object') return empty
  const source = raw as Record<string, unknown>
  const blocks = Number(source.blocks)
  return {
    blocks: Number.isFinite(blocks) && blocks > 0 ? Math.floor(blocks) : 0,
    tool: typeof source.tool === 'string' && source.tool.trim() ? source.tool.trim() : null,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : null
  }
}

/**
 * 还需要把几次「被拦下」补记进失败签名。
 *
 * ⚠️ `counted` 必须是**独立持久化的消费游标**（`GoalEntry.repeatCursor.blocks`），
 *    不能用目标自己的 `failure.count` 当账本（实施-14 A4）：
 *    · 目标报了进展 / 换了签名会把 `failure` 清空，旧 blocks 会**再计一遍**，
 *      把正常推进的目标一瞬间打成 blocked；
 *    · 新目标一开始 `failure` 为空，也会把上一个目标欠下的 blocks 全算到自己头上。
 *
 * 计数回退（薄层归零后重新累计）在这里返回 0，由调用方把游标同步到新值。
 */
export function pendingRepeatFailures(counted: number, blocks: number): number {
  const already = Number.isFinite(counted) && counted > 0 ? Math.floor(counted) : 0
  const wanted = Number.isFinite(blocks) && blocks > 0 ? Math.floor(blocks) : 0
  return Math.max(0, Math.min(wanted - already, MAX_PENDING_FAILURES))
}
