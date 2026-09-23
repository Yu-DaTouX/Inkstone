/**
 * 上下文变换的**纯逻辑**（N21-4 / S2–S6）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个文件是什么、不是什么
 * ══════════════════════════════════════════════════════════════════
 * 它是「把 pi 的消息数组变成我们想发给模型的消息数组」的全部**判定**：
 *   · 消息 ↔ 原子单元（§12.4）↔ 可回收候选（§12.5）；
 *   · 墓碑替换（Tool Sweep）与幂等；
 *   · `<TASK_STATE>` 的渲染与注入位置（§12.8 / §13.1）；
 *   · Recall 的预算 / TTL / 过期清理（§12.9）；
 *   · 每次变换的收益指标（§12.10）。
 *
 * 它**不做** IO、不读文件、不调用模型、不知道 pi 的存在 ——
 * 这些都在 `context.js`（钩子与工具）里。这样做的唯一理由是：
 * 「什么时候能改、改完长什么样」必须能一次把边界算清并单测覆盖
 * （参照 `context-safety.js` 与 `shared/context-policy.ts` 的先例）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条不许绕过的约束（与 `docs/design/方案-上下文工具内的自动压缩` 第 12 节一致）
 * ══════════════════════════════════════════════════════════════════
 * ① **任何变换都是 working copy → 校验 → 提交**。本文件所有 `apply*`
 *    都返回新数组、不改入参；调用方拿 `violations()` 过了才准发出去。
 * ② **recentTail 只在原子单元边界截断**，tool_call 与 tool_result 不可分离。
 *    切割判定全部委托 `context-safety.js`，不在这里重写一套。
 * ③ **墓碑是占位，不是删除**：`tool_result` 被替换成一段指向
 *    `ctx://tool/<原始 entryId>` 的文本，原文仍可从 Recall 取回。
 *    所以这里**只替换 toolResult 的内容**，从不删除消息、从不改 assistant。
 *
 * ══════════════════════════════════════════════════════════════════
 * 一条实现上的取舍：token 是**估算**，而且刻意保守
 * ══════════════════════════════════════════════════════════════════
 * 扩展侧拿不到 tokenizer（pi 的 usage 是回合结束后才知道的），所以
 * `estimateTokens` 用「宽字符按 1 个/字符，其余按 UTF-16 长度 ÷ 4」的近似。
 * 它只用于**相对比较与门槛判定**（谁更大、够不够门槛），不用于任何硬上限：
 * 真正的工作集与 reserve 判定仍由主进程的 `contextBudget` 负责。
 * 因此估算误差不会突破 `窗口 − 输出预留`（§12.1 的硬规则）。
 *
 * 为什么必须按宽字符单独算（N21-11）：`÷ 4` 是**英文**的经典近似，
 * 一个汉字会被算成 0.25 token。实测 39 个汉字 → 估算 10（真实约 39），
 * **低估近 4 倍**；而 Tool Sweep / fold gate / recall 预算的门槛都是绝对值，
 * 低估意味着「中文长会话看起来还早」——真实 token 早已越过工作集线，
 * 于是整段错过状态层。宽字符按 1 token 是**宁高不低**的取法，与
 * 「刻意保守」的口径一致（真实 BPE 里中文常 1 字 ≈ 1 token，日文假名更贵）。
 */

import { planTailCut, sweepCandidates, violations } from './context-safety.js'

/* ══════════════════════════════════════════════════════════════════
 * 常量与默认值
 * ══════════════════════════════════════════════════════════════════ */

/** 墓碑首行：既是给人看的标记，也是幂等判据（第二次跑不再包一层） */
export const TOMBSTONE_PREFIX = '[Archived tool result]'

/** 召回注入的标记：TTL 清理靠它认出「这条是临时召回的内容」 */
export const RECALL_PREFIX = '[Recalled context]'

/** 被清理的召回留下的存根（只留结论与引用，不留正文） */
export const RECALL_STUB_PREFIX = '[Earlier recall expired]'

/**
 * recentTail 的容量目标（方案 §12.4 的 32k / 48k）。
 * 是**容量目标**而不是切割位置：为凑数把 tool interaction 劈开是禁止的，
 * 所以实际尾部 29k / 41k 都合法。
 */
export const DEFAULT_RECENT_TAIL = { target: 32_000, max: 48_000 }

/** Tool Sweep 的默认门槛（§12.12 的 P2：靠压力测试调，先给保守初值） */
export const DEFAULT_SWEEP = {
  /** 单条工具结果小于这个量就不值得替换（墓碑本身也要占 token） */
  minTokens: 512,
  /** 一次 sweep 至少要腾出这么多，否则「整理了但没变化」 */
  minReclaimTokens: 2_000,
  /** 相对当前用量的最低回收比例 */
  minReclaimRatio: 0.03,
  /*
   * 达到工作集线时用的门槛（实施-11 C-6）。
   *
   * 旧行为是把 `minReclaimTokens` / `minReclaimRatio` **清零** —— 于是“到线”本身
   * 就构成清扫理由，哪怕只能腾出几十一百个 token。C-6 要求普通内容清扫仍然
   * “达到统一压力门槛**或**更明确的回收收益条件”，所以默认值**等于普通门槛**，
   * 不再无条件放宽；确实需要更激进的档位可以显式把这两个数调低（包括 0）。
   */
  forcedMinReclaimTokens: 2_000,
  forcedMinReclaimRatio: 0.03
}

/**
 * 大窗口档的近期尾部（实施-11 C-6 候选 64K–96K）。
 *
 * 小窗口保留 32K / 48K；工作集进入大窗口档后，为了不把 1M 模型的近端原文
 * 贴得太紧（否则一次 sweep 就会动到刚用过的上下文），把尾部放宽一倍。
 * 阈值用一个与档位不同的量（工作集 ≥ 512K）判断，而不是直接认 600K / 700K ——
 * 用户自定义覆盖时它也跟着工作集走。
 */
export const LARGE_RECENT_TAIL = { target: 64_000, max: 96_000 }
/** 工作集达到这个量就启用大窗口尾部（不是模型窗口，是生效的工作集） */
export const LARGE_TAIL_WORKING_SET = 512_000

/**
 * 按生效工作集挑近期尾部容量。未知 / 小窗口回落给定的 base。
 *
 * 纯函数，与 `foldEligible` 同一约定：门槛由**调用点**把真实工作集传进来，
 * 扩展自己不猜档位。
 */
export function recentTailFor(workingSet, base = DEFAULT_RECENT_TAIL) {
  const w = Number(workingSet)
  const fallback = { ...base }
  if (!Number.isFinite(w) || w < LARGE_TAIL_WORKING_SET) return fallback
  return {
    target: Math.max(Number(base?.target) || 0, LARGE_RECENT_TAIL.target),
    max: Math.max(Number(base?.max) || 0, LARGE_RECENT_TAIL.max)
  }
}

/** Recall 的默认预算（§12.9；N21-7 会把它做成设置项） */
export const DEFAULT_RECALL = {
  maxTokensPerCall: 20_000,
  maxActiveRecallTokens: 40_000,
  maxEntriesPerCall: 3,
  /** 'turn'：召回内容在下一轮用户输入到来时即失效（只剩引用） */
  ttl: 'turn'
}

/* ══════════════════════════════════════════════════════════════════
 * token 估算与取文本
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 按码点判定「一个字符就值约一个 token」的宽字符（CJK 汉字、假名、韩文、
 * 全角标点/符号、CJK 兼容区）。覆盖取常用区块，宁可高估不可低估。
 */
export function isWideTokenChar(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 + 标点（、。〈〉《》「」…）
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名 + 注音 + CJK 兼容 + 单位符号
    (cp >= 0x3400 && cp <= 0x4dbf) || // 汉字扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 汉字基本区
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式（竖排标点）
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII（！？：；（）等）
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x20000 && cp <= 0x3ffff) // 汉字扩展 B 及以后
  )
}

/**
 * token 估算：宽字符按「1 个字符 = 1 token」、其余按 UTF-16 长度 ÷ 4。
 *
 * 只用于相对比较与门槛判定，不用于硬上限；口径与原因见文件头（N21-11）。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0
  let wide = 0
  for (const ch of text) if (isWideTokenChar(ch.codePointAt(0))) wide += ch.length
  return Math.ceil(wide + (text.length - wide) / 4)
}

/** 一条内容块数组里的纯文本（thinking / toolCall 不算“读到的内容”） */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** pi 消息 → 该消息承载的文本（用于估算与墓碑判据） */
export function messageText(message) {
  if (!message) return ''
  if (typeof message.summary === 'string') return message.summary // branchSummary / compactionSummary
  return blocksToText(message.content)
}

/** assistant 消息里的 toolCall 块（id / name / args），供墓碑抄确定性元数据 */
export function toolCallsOf(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return []
  const out = []
  for (const block of message.content) {
    if (block && block.type === 'toolCall' && typeof block.id === 'string') {
      out.push({ id: block.id, name: typeof block.name === 'string' ? block.name : 'tool', args: block.arguments ?? block.args ?? {} })
    }
  }
  return out
}

/**
 * 从工具参数里抄一个**确定性**的目标显示（§12.5：只抄，不推断）。
 * 抄不到就返回空串 —— 墓碑上宁可少一行，也不要编一个路径出来。
 */
export function toolTarget(args) {
  if (!args || typeof args !== 'object') return ''
  for (const key of ['path', 'file_path', 'filePath', 'pattern', 'url', 'notebook_path']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  if (typeof args.command === 'string' && args.command.trim()) {
    return args.command.trim().split('\n')[0].slice(0, 160)
  }
  return ''
}

/**
 * 从工具参数里抄出**文件路径**（只认路径类字段）。
 *
 * 与 `toolTarget()` 的区别：后者为了墓碑可读性也会接受 `pattern` / `url` / `command`，
 * 而“正在使用的 diff”判定只能拿路径 —— 把 `grep` 的 pattern 或 `bash` 的命令行
 * 当成路径去相交，会把无关条目错保护起来，清扫随之静默失效。
 */
export function toolPaths(args) {
  if (!args || typeof args !== 'object') return []
  const out = []
  for (const key of ['path', 'file_path', 'filePath', 'notebook_path']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
  }
  return out
}

/**
 * 当前用户回合里“正在使用”的文件路径（方案 §12.4 硬约束①）。
 *
 * 为什么只看**本回合**：`recentTail` 之外的旧编辑已经不再“正在使用”，
 * 若把它们也算进来，硬留集会随会话单调增长，清扫最终永远压不动（与把约束
 * 当硬留是同一个错误）。本回合尚未结束的东西才是“用户正在看的”。
 *
 * @returns {string[]} 去重后的路径清单（无本回合信息时为空数组）
 */
export function activePathsOf(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return []
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      start = i
      break
    }
  }
  const out = new Set()
  for (let i = start; i < messages.length; i++) {
    for (const call of toolCallsOf(messages[i])) {
      for (const p of toolPaths(call.args)) out.add(p)
    }
  }
  return [...out]
}

/* ══════════════════════════════════════════════════════════════════
 * 适配：pi 消息 → context-safety 的条目视图
 * ══════════════════════════════════════════════════════════════════ */

/**
 * @typedef {object} AdaptedEntry
 * @property {string} entryId
 * @property {'system'|'user'|'assistant'|'tool'|'bash'} role
 * @property {number} tokens
 * @property {number} index      在原 messages 数组里的下标（提交时按它回写）
 * @property {string[]} [toolCalls]
 * @property {string} [toolCallId]
 * @property {string[]} [paths]      该条目涉及的文件路径（`activePaths` 相交判定用）
 * @property {boolean} [isError]
 * @property {string[]} [protect]
 */

/**
 * 把 pi 消息适配成条目视图。
 *
 * `entryIds` 与 `messages` **必须等长**（调用方负责对齐原始 entry 身份，
 * 见 `context.js` 的 `mapEntryIds`）；长度不等时这里返回 null，
 * 调用方按「没有原始身份」处理 —— 宁可这次不 sweep，也不能拿错的身份
 * 去写 `ctx://` 引用（那会让 Recall 取回别人的历史）。
 *
 * 角色映射（与 `context-safety.js` 文件头声明的对应关系一致）：
 *   `assistant` 内容块 `toolCall` → `toolCalls`
 *   `role: 'toolResult'` → `role: 'tool'` + `toolCallId`
 *   `role: 'bashExecution'` → `role: 'bash'`
 * 其余（custom / branchSummary / compactionSummary）按 `user` 处理：
 * 它们是**历史**，不是系统契约，所以不享受「硬留」待遇，但也不参与 sweep
 * （sweep 只看 `tool`）。
 */
export function adaptMessages(messages, entryIds, opts = {}) {
  if (!Array.isArray(messages)) return null
  if (!Array.isArray(entryIds) || entryIds.length !== messages.length) return null
  const errorAsUnresolved = opts.errorAsUnresolved !== false
  /*
   * 先建 toolCallId → 路径 的索引：工具结果的路径只能从**发起它的那次调用**抄。
   * 先扫一遍而不是就地回看，是因为 call 与 result 可能不是相邻两条（中间夹了别的 content）。
   */
  const callPaths = new Map()
  for (const message of messages) {
    for (const call of toolCallsOf(message)) {
      const paths = toolPaths(call.args)
      if (paths.length) callPaths.set(call.id, paths)
    }
  }
  const out = []
  messages.forEach((message, index) => {
    const entryId = entryIds[index]
    if (typeof entryId !== 'string' || !entryId) return
    const role = message?.role
    /** @type {AdaptedEntry} */
    const entry = { entryId, index, role: 'user', tokens: 0 }
    if (role === 'toolResult') {
      entry.role = 'tool'
      if (typeof message.toolCallId === 'string') entry.toolCallId = message.toolCallId
      const paths = entry.toolCallId ? callPaths.get(entry.toolCallId) : undefined
      if (paths) entry.paths = paths
      if (message.isError === true) {
        entry.isError = true
        /*
         * 未解决的错误不得丢（§12.6）。这里无法判断「是否已解决」，
         * 所以保守处理：只要 `isError` 就当 unresolved-error 保护，
         * 不参与 sweep。状态层能证明它已解决时才取消保护。
         */
        if (errorAsUnresolved) entry.protect = ['unresolved-error']
      }
      entry.tokens = estimateTokens(messageText(message))
      out.push(entry)
      return
    }
    if (role === 'assistant') {
      entry.role = 'assistant'
      entry.tokens = estimateTokens(messageText(message))
      const calls = toolCallsOf(message).map((c) => c.id)
      if (calls.length) entry.toolCalls = calls
      out.push(entry)
      return
    }
    if (role === 'bashExecution') {
      entry.role = 'bash'
      entry.tokens = estimateTokens(messageText(message)) + estimateTokens(String(message.command ?? ''))
      if (message.exitCode !== undefined && message.exitCode !== 0) {
        entry.isError = true
        if (errorAsUnresolved) entry.protect = ['unresolved-error']
      }
      out.push(entry)
      return
    }
    /* user / custom / branchSummary / compactionSummary → user（历史） */
    entry.role = 'user'
    entry.tokens = estimateTokens(messageText(message))
    out.push(entry)
  })
  return out
}

/* ══════════════════════════════════════════════════════════════════
 * Tool Sweep（§12.5）
 * ══════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════
 * 原始 entry 身份对齐（N21-4 硬约束：provenance 只认 raw entry id）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 一条会话 entry 会不会在上下文里产生一条消息。
 *
 * 与 pi 的 `sessionEntryToContextMessages` 一一对应：`message` 恒产生 1 条，
 * `custom_message` / `branch_summary` / `compaction` 各产生 1 条，
 * 其余（model_change / thinking_level_change / label / …）产生 0 条。
 * 这里刻意只认这几种，认不出来的一律视为“不产生消息”——
 * 数量对不上时对齐会失败并安全回退，而不是把 id 错位贴到别人身上。
 */
export function entryProducesMessage(entry) {
  const type = entry?.type
  return type === 'message' || type === 'custom_message' || type === 'branch_summary' || type === 'compaction'
}

/** entry 产生的消息角色（用于对齐时的二次校验；认不出返回 null） */
export function entryMessageRole(entry) {
  switch (entry?.type) {
    case 'message':
      return typeof entry.message?.role === 'string' ? entry.message.role : null
    case 'custom_message':
      return 'custom'
    case 'branch_summary':
      return 'branchSummary'
    case 'compaction':
      return 'compactionSummary'
    default:
      return null
  }
}

/**
 * 复刻 pi 的 `buildContextEntries`：有压缩时只从 `firstKeptEntryId` 起保留历史。
 *
 * 为什么必须复刻：`agent.state.messages` 是**压缩后**的上下文，
 * 直接拿 `getBranch()` 去对齐会多出一截已经被压缩掉的历史，
 * 于是 entry id 全部错位 —— 那比不做 sweep 危险得多（Recall 会取回别的条目）。
 */
export function contextEntries(branch) {
  if (!Array.isArray(branch)) return []
  let compaction = null
  for (const entry of branch) if (entry?.type === 'compaction') compaction = entry
  if (!compaction) return branch.slice()
  const idx = branch.findIndex((entry) => entry?.id === compaction.id)
  if (idx < 0) return branch.slice()
  const out = [compaction]
  let found = false
  for (let i = 0; i < idx; i++) {
    if (branch[i]?.id === compaction.firstKeptEntryId) found = true
    if (found) out.push(branch[i])
  }
  out.push(...branch.slice(idx + 1))
  return out
}

/**
 * 把 pi 的消息数组对齐到原始 entry id。
 *
 * 两道校验缺一不可：**数量相等** + **角色逐条相同**。
 * 角色是一切对的第二道锁：数量碰巧相等但错位（例如 agent 状态里多了一条
 * 还没落盘的 steering 消息）时，数量检查会过而角色检查会挂 —— 那时返回
 * null，调用方放弃这次变换（宁可压不动，也不贴错身份）。
 *
 * @returns {string[] | null}
 */
export function alignEntryIds(branch, messages) {
  if (!Array.isArray(messages)) return null
  const ids = []
  for (const entry of contextEntries(branch)) {
    if (!entryProducesMessage(entry)) continue
    if (typeof entry.id !== 'string' || !entry.id) return null
    ids.push(entry.id)
  }
  if (ids.length !== messages.length) return null
  const producing = contextEntries(branch).filter(entryProducesMessage)
  for (let i = 0; i < producing.length; i++) {
    const expected = entryMessageRole(producing[i])
    const actual = messages[i]?.role
    if (expected === null || actual === undefined) continue
    if (expected !== actual) return null
  }
  return ids
}

/** sessionManager 的 entry 列表 → 水位（与 `main/context-watermark.ts` 同一口径） */
export function watermarkOfEntries(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.type !== 'session') : []
  const last = list.length ? list[list.length - 1] : null
  return { entryCount: list.length, lastEntryId: last && typeof last.id === 'string' ? last.id : null }
}

/** 这条文本是不是已经包过墓碑了（幂等判据） */
export function isTombstoneText(text) {
  return typeof text === 'string' && text.trimStart().startsWith(TOMBSTONE_PREFIX)
}

/** 墓碑文本：确定性、可读、带 `ctx://` 引用与「怎么取回原文」的一句话 */
export function renderTombstone({ tool, target, tokens, ref }) {
  const lines = [TOMBSTONE_PREFIX]
  lines.push(`Tool: ${tool || 'tool'}`)
  if (target) lines.push(`Target: ${target}`)
  lines.push(`Original tokens: ${Number(tokens) || 0}`)
  lines.push(`Ref: ${ref}`)
  /* 回读入口是随包 CLI，不是模型工具（见 context.js 头注 ③）。 */
  lines.push('Read it back with: yan context recall --ref <Ref> (stdout resultFile holds the raw text as managed plain text).')
  return lines.join('\n')
}

/**
 * 规划一次 Tool Sweep（**不改任何东西**）。
 *
 * 判定顺序（每一步不过就少一点可回收量，而不是整个放弃）：
 *   ① 只考虑 `recentTail` **之外**的 tool 条目（§12.4 硬约束）；
 *   ② 门槛：单条 ≥ `minTokens`；
 *   ③ 保护：正在使用的 diff / 用户约束 / 未解决错误 —— 由 `sweepCandidates` 判定；
 *   ④ 收益门槛：可回收总量 ≥ `minReclaimTokens` 或比例 ≥ `minReclaimRatio`（§12.2）。
 *
 * @returns {{ok: true, plan: object, metrics: object} | {ok: false, reason: string, details?: object}}
 */
export function planToolSweep(input) {
  const { messages, entryIds, watermark } = input
  const opts = input.opts ?? {}
  const sweep = { ...DEFAULT_SWEEP, ...(input.sweep ?? {}) }
  const recentTail = { ...DEFAULT_RECENT_TAIL, ...(input.recentTail ?? {}) }

  const entries = adaptMessages(messages, entryIds, { errorAsUnresolved: true })
  if (!entries) return { ok: false, reason: 'entry-identity-mismatch' }

  const cut = planTailCut(entries, recentTail, { activePaths: opts.activePaths ?? [] })
  const outsideTail = new Set(cut.droppedEntryIds)
  const { candidates, skipped } = sweepCandidates(entries, {
    activePaths: opts.activePaths ?? [],
    minTokens: sweep.minTokens
  })

  const byId = new Map(entries.map((e) => [e.entryId, e]))
  const callById = new Map()
  for (const e of entries) for (const id of e.toolCalls ?? []) callById.set(id, e)

  const edits = []
  let reclaimable = 0
  for (const candidate of candidates) {
    if (!outsideTail.has(candidate.entryId)) continue
    const entry = byId.get(candidate.entryId)
    if (!entry) continue
    const message = messages[entry.index]
    const original = messageText(message)
    if (isTombstoneText(original)) continue // 幂等：已经是墓碑
    const call = candidate.toolCallId ? callById.get(candidate.toolCallId) : undefined
    const callInfo = call ? toolCallsOf(messages[call.index]).find((c) => c.id === candidate.toolCallId) : undefined
    const ref = `ctx://tool/${candidate.entryId}`
    const tombstone = renderTombstone({
      tool: callInfo?.name ?? message?.toolName ?? 'tool',
      target: toolTarget(callInfo?.args),
      tokens: candidate.tokens,
      ref
    })
    const after = estimateTokens(tombstone)
    const reclaimed = Math.max(0, candidate.tokens - after)
    if (reclaimed <= 0) continue
    reclaimable += reclaimed
    edits.push({ index: entry.index, entryId: candidate.entryId, ref, tokens: candidate.tokens, tombstone, reclaimed, tool: callInfo?.name ?? message?.toolName ?? 'tool' })
  }

  const beforeTokens = entries.reduce((n, e) => n + e.tokens, 0)
  const ratio = beforeTokens > 0 ? reclaimable / beforeTokens : 0
  if (edits.length === 0) {
    return { ok: false, reason: 'no-candidates', details: { skipped: skipped.length } }
  }
  if (reclaimable < sweep.minReclaimTokens && ratio < sweep.minReclaimRatio) {
    return { ok: false, reason: 'below-reclaim-threshold', details: { reclaimable, ratio } }
  }

  const archiveEntries = edits.map((edit) => ({
    ref: edit.ref,
    kind: 'tool',
    label: `${edit.tool} ${edit.entryId}`.trim(),
    tokens: edit.tokens,
    recallable: 'agent',
    sourceRange: { from: edit.entryId, to: edit.entryId },
    ...(watermark ? { watermark } : {})
  }))

  return {
    ok: true,
    plan: { edits, outsideTail: [...outsideTail] },
    metrics: {
      beforeTokens,
      afterTokens: beforeTokens - reclaimable,
      reclaimedTokens: reclaimable,
      reclaimedRatio: ratio,
      affected: edits.length
    },
    archiveEntries
  }
}

/* ---------------------------------------------------------------- Episode 扇叠（§12.6）*/

/**
 * Episode 的候选区间门槛（初值；§12.12 把它们列为「靠压力测试标定」）。
 *
 * 为什么必须有：拿两三行历史去做一次归纳，产出比输入还长 —— 而「不值得」必须是
 * **不生成**，不是生成一份空的。数值与 sweep 的 `minReclaimTokens` 对齐，方便记。
 */
export const DEFAULT_EPISODE_WINDOW = { minEntries: 4, minTokens: 2_000 }

/**
 * Episode 的候选区间（方案 §12.6 + §12.7，**确定性边界**）。
 *
 * ── 边界怎么定 ──
 *   起点：上一版 Episode 覆盖到的地方（`coveredThrough`，没有就从最早一条起）
 *   终点：`recentTail` 窗口**左边界的前一条** —— 也就是「已经离开活跃窗口」的最后一条
 *
 * 为什么不用「两次状态生成之间」当边界：那一段恰恰是**最新**的（还在 recentTail 里），
 * 把它扇叠掉等于把正在进行的活儿收起来 —— 方案 §12.6 明确警告过这件事。
 * 而「离开活跃窗口」在语义上正好等价于「不再被当作当前上下文使用」，
 * 这也是它不需要额外语义判断就能当边界的原因。
 *
 * ── 为什么要有 `coveredThrough` ──
 * 每次生成都会重算一遍窗口，不记住「已经扇叠到哪」就会对同一段反复归纳（幂等靠
 * id 兜底，但白花输出）。记住它，Episode 只会向前推进。
 *
 * 返回 `null` 的情形：拿不到条目身份 / 区间为空 / 区间太短（条目或 token 不足）。
 * 调用方必须把 `null` 当作「这次不生成 Episode」，**不是**「生成一份空的」。
 */
export function episodeWindow(input = {}) {
  const { messages, entryIds } = input
  const recentTail = { ...DEFAULT_RECENT_TAIL, ...(input.recentTail ?? {}) }
  const minEntries = Number.isFinite(input.minEntries) ? input.minEntries : DEFAULT_EPISODE_WINDOW.minEntries
  const minTokens = Number.isFinite(input.minTokens) ? input.minTokens : DEFAULT_EPISODE_WINDOW.minTokens
  if (!Array.isArray(messages) || !Array.isArray(entryIds) || messages.length !== entryIds.length) return null
  const entries = adaptMessages(messages, entryIds, { errorAsUnresolved: true })
  if (!entries) return null
  /* `droppedEntryIds` 就是「尾部窗口之外」的那些（planTailCut 按条目顺序给出） */
  const outside = new Set(planTailCut(entries, recentTail).droppedEntryIds)
  const ordered = entryIds.filter((id) => outside.has(id))
  if (!ordered.length) return null
  let start = 0
  if (input.coveredThrough) {
    const at = ordered.indexOf(input.coveredThrough)
    /* 找不到（已被压缩 / 清扫掉）→ 从头开始；重复不会写重，靠 id 幂等 */
    start = at >= 0 ? at + 1 : 0
  }
  const windowIds = ordered.slice(start)
  if (windowIds.length < minEntries) return null
  const tokensById = new Map(entries.map((e) => [e.entryId, e.tokens]))
  const tokens = windowIds.reduce((n, id) => n + (tokensById.get(id) ?? 0), 0)
  if (tokens < minTokens) return null
  return { entryIds: windowIds, from: windowIds[0], to: windowIds[windowIds.length - 1], tokens }
}

/**
 * 提交一次 Tool Sweep：返回**新** messages（入参不动）。
 *
 * 只替换 `toolResult` 的 `content`，保留 `toolCallId` / `isError` / 顺序 ——
 * 于是 tool_call 与 tool_result 的配对不会被破坏（§12.4）。
 */
export function applyToolSweep(messages, plan) {
  const edits = plan?.edits ?? []
  if (!edits.length) return { messages, changed: 0 }
  const next = messages.slice()
  let changed = 0
  for (const edit of edits) {
    const current = next[edit.index]
    if (!current || current.role !== 'toolResult') continue
    if (isTombstoneText(messageText(current))) continue
    next[edit.index] = { ...current, content: [{ type: 'text', text: edit.tombstone }] }
    changed++
  }
  return { messages: next, changed }
}

/**
 * 提交前的合法性检查：切割/替换结果不得产生坏上下文。
 *
 * 这里把 `context-safety.violations()` 的语义接进 sweep 场景：
 * sweep **不切割**（kept = 全部条目），所以唯一可能踩的是「tool 配对」与
 * 「受保护内容被回收」。返回空数组才允许发出。
 */
export function sweepViolations(messages, entryIds, opts = {}) {
  const entries = adaptMessages(messages, entryIds, { errorAsUnresolved: true })
  if (!entries) return ['entry-identity-mismatch']
  const all = entries.map((e) => e.entryId)
  return violations(
    { keptEntryIds: all, droppedEntryIds: [] },
    entries,
    { activePaths: opts.activePaths ?? [], carriedIds: opts.carriedIds ?? [] }
  )
}

/* ══════════════════════════════════════════════════════════════════
 * Task State 注入（§12.8 / §13.1 / §13.4）
 * ══════════════════════════════════════════════════════════════════ */

/** 注入的 Task State 消息类型标记（幂等 / 识别用） */
export const TASK_STATE_CUSTOM_TYPE = 'yan-task-state'

function activeTexts(list) {
  return (Array.isArray(list) ? list : [])
    .filter((entry) => entry && typeof entry.text === 'string' && entry.status === 'active')
    .map((entry) => {
      const marks = []
      /*
       * `stale` 必须**显式标出来**（Codex 第三条分歧）：水位落后的快照仍然可用，
       * 但「假设 / 下一步」这类推测不能静默地当成已知事实喂过去。
       */
      if (entry.stale) marks.push('stale: verify before relying on it')
      /*
       * `hypothesis`（无证据引用）也要显式标（第五轮外部意见 Q1 的 P0-③）：
       * 没有引用的语义条目就是模型的推断，不是观察到的事实。不标出来的话，
       * 「上一版这么说」就会被当成依据一代代传下去 —— 那正是语义递归固化。
       * 模型只有在本轮材料里找到证据，才能把它变成 observed / derived。
       */
      if (entry?.source?.confidence === 'hypothesis') marks.push('inferred: no citation yet')
      return `- ${entry.text}${marks.length ? `  [${marks.join('; ')}]` : ''}`
    })
}

/**
 * 把 Task State 渲染成 `<TASK_STATE>` 文本。
 *
 * 只渲染 `status === 'active'` 的条目：`resolved` / `superseded` 留在文件里
 * 供追溯，但不再进注入（§13.1 第 21 条：状态不是长期记忆，旧决策不许
 * 反复污染）。`superseded` 必须带 `supersededBy` 的约束由 schema 校验负责。
 */
/**
 * 把 TaskState 渲染成注入块（§12.8 / §13.1）。
 *
 * 头行是**机器可识别的 authority 契约**（第四轮外部评审 P0-2）：
 *   · `derived="true" authoritative="false"` —— 这是派生的工作缓存，不是事实源；
 *   · `freshness` —— 注入时的分档（`fresh` / `partial` / `stale`）；
 *   · `sourceHead` —— 快照覆盖到的条目数（审计用）。
 * 紧跟着一句**固定优先级**（新用户指令 > 真实工具结果 > 确定性 reducer 事实 >
 * 原始转录 > 本块）—— 不能让模型自己猜高低。
 */
export function renderTaskState(task, opts = {}) {
  if (!task || typeof task !== 'object') return ''
  const freshness = typeof opts.freshness === 'string' && opts.freshness ? opts.freshness : 'fresh'
  const sourceHead = Number.isFinite(opts.sourceHead) ? ` sourceHead="${opts.sourceHead}"` : ''
  const lines = [`<TASK_STATE derived="true" authoritative="false" freshness="${freshness}"${sourceHead}>`]
  lines.push(
    'Derived working cache, not ground truth. If it conflicts with newer user instructions, real tool results, or the raw transcript, those win.'
  )
  let content = false
  const objective = task.task?.objective
  const phase = task.task?.currentPhase
  if (objective) lines.push(`Objective: ${objective}`)
  if (phase) lines.push(`Current phase: ${phase}`)

  const sections = [
    ['Current state', task.currentState],
    ['Decisions', task.decisions],
    ['Constraints', task.constraints],
    ['Completed', task.completed],
    ['Failed attempts', task.failedAttempts],
    ['Unresolved', task.unresolved],
    ['Next actions', task.nextActions],
    ['Assumptions', task.assumptions],
    ['Hypothesis', task.hypothesis]
  ]
  for (const [title, list] of sections) {
    const items = activeTexts(list)
    if (items.length) {
      lines.push(`${title}:`, ...items)
      content = true
    }
  }
  const files = (Array.isArray(task.files) ? task.files : []).filter((f) => f && f.path)
  if (files.length) {
    lines.push('Files:')
    for (const file of files) lines.push(`- ${file.path}${file.state ? ` — ${file.state}` : ''}`)
    content = true
  }
  const commands = (Array.isArray(task.commandsRun) ? task.commandsRun : []).filter((c) => c && c.command)
  if (commands.length) {
    lines.push('Commands run:')
    for (const c of commands) lines.push(`- ${c.command}${c.exitCode === undefined ? '' : ` (exit ${c.exitCode})`}`)
    content = true
  }
  const tests = (Array.isArray(task.testsRun) ? task.testsRun : []).filter((t) => t && t.command)
  if (tests.length) {
    lines.push('Tests run:')
    for (const t of tests) {
      const counts = [t.passed === undefined ? null : `${t.passed} passed`, t.failed === undefined ? null : `${t.failed} failed`].filter(Boolean)
      lines.push(`- ${t.command}${counts.length ? ` (${counts.join(', ')})` : ''}`)
    }
    content = true
  }
  const refs = (Array.isArray(task.archiveRefs) ? task.archiveRefs : []).filter(Boolean)
  if (refs.length) {
    lines.push('Archived history (read back with `yan context recall --ref`):', ...refs.map((r) => `- ${r}`))
    content = true
  }
  lines.push('</TASK_STATE>')
  /*
   * 只有目标与阶段、一个结论条目都没有 → 视为空状态。
   * 注入一个空壳会让模型以为“已经知道状态了”，比不注入危险
   * （§13.1 第 22 条：防状态幻觉）。
   */
  return content ? lines.join('\n') : ''
}

/**
 * 注入 / 替换 `<TASK_STATE>` 消息。
 *
 * 位置固定在**历史之前**（§13.1 第 1 条：`SYSTEM → TASK_STATE → HISTORY`）。
 * systemPrompt 不在 messages 数组里（pi 单独传），所以「第一条」就是历史之前。
 * 用 `role: 'custom'`（pi 的 convertToLlm 会把它映射成 user）并打上
 * `customType`，这样：
 *   · 它可被识别（幂等，不重复注入）；
 *   · 它不参与「用户回合计数」（TTL 清理用），因为它不是 `role: 'user'`。
 */
export function injectTaskState(messages, text) {
  const withoutOld = messages.filter((m) => !(m?.role === 'custom' && m.customType === TASK_STATE_CUSTOM_TYPE))
  if (!text) return { messages: withoutOld, injected: false }
  const message = { role: 'custom', customType: TASK_STATE_CUSTOM_TYPE, content: [{ type: 'text', text }] }
  return { messages: [message, ...withoutOld], injected: true }
}

/** `<TASK_STATE>` 是否已经在消息里（诊断 / 断言用） */
export function hasTaskState(messages) {
  return messages.some((m) => m?.role === 'custom' && m.customType === TASK_STATE_CUSTOM_TYPE)
}

/* ══════════════════════════════════════════════════════════════════
 * Recall（§12.9）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 单次召回的预算判定。
 *
 * 超预算的行为是**拒绝并回一句可解释的话**，不是静默截断 ——
 * 半份历史比没有历史更危险（§12.9 的明确要求）。所以这里返回拒绝原因，
 * 文案由调用方拼（要能读得懂）。
 */
export function recallBudget(policy, request, active = {}) {
  const p = { ...DEFAULT_RECALL, ...(policy ?? {}) }
  const estimated = Number(request?.tokens) || 0
  const count = Number(request?.count) || 1
  if (count > p.maxEntriesPerCall) {
    return { ok: false, reason: 'too-many-entries', limit: p.maxEntriesPerCall }
  }
  if (estimated > p.maxTokensPerCall) {
    return { ok: false, reason: 'too-large', limit: p.maxTokensPerCall, estimated }
  }
  const activeTokens = Number(active.tokens) || 0
  if (activeTokens + estimated > p.maxActiveRecallTokens) {
    return { ok: false, reason: 'active-budget', limit: p.maxActiveRecallTokens, active: activeTokens, estimated }
  }
  return { ok: true, estimated }
}

/**
 * 召回内容的注入包装：正文前面加一行机器可读的标记 + **回合号**。
 * 回合号用于 TTL：下一轮用户输入开始时，上一轮的召回正文即可清理。
 */
export function wrapRecall(text, ref, turn) {
  return `${RECALL_PREFIX} turn=${turn} ref=${ref}\n${text}`
}

/** 从召回包装里取回合号 / 引用；不是召回内容就返回 null */
export function parseRecall(text) {
  if (typeof text !== 'string' || !text.startsWith(RECALL_PREFIX)) return null
  const head = text.split('\n', 1)[0]
  const turn = /turn=(\d+)/.exec(head)?.[1]
  const ref = /ref=(\S+)/.exec(head)?.[1]
  return { turn: turn === undefined ? null : Number(turn), ref: ref ?? null }
}

/**
 * TTL 清理：把**上一轮及其之前**的召回正文换成只留引用的存根。
 *
 * 为什么保留存根而不是整条删掉：模型可能在后续回合引用「之前查过什么」。
 * 存根既保住了「查过、引用在哪」这个结论，又不再占用召回正文的 token，
 * 符合「召回是读取历史，不是永久恢复历史」。
 *
 * @param {number[]} turnMarks 每个消息的回合号（与 messages 等长；没有的填 null）
 */
export function stripStaleRecalls(messages, currentTurn) {
  let changed = 0
  const next = messages.map((message) => {
    if (message?.role !== 'toolResult') return message
    const text = messageText(message)
    const parsed = parseRecall(text)
    if (!parsed) return message
    if (parsed.turn !== null && parsed.turn >= currentTurn) return message
    changed++
    return {
      ...message,
      content: [
        {
          type: 'text',
          text: `${RECALL_STUB_PREFIX} ref=${parsed.ref ?? 'unknown'} — the full text is no longer in context; call \`yan context recall --ref ${parsed.ref ?? '<ref>'}\` again if needed.`
        }
      ]
    }
  })
  return { messages: next, changed }
}

/**
 * 当前消息数组里的「用户回合数」。
 *
 * 只数真正的 `role: 'user'`：注入的 Task State 是 `custom`、
 * 工具结果是 `toolResult`，都不该让回合号前进。
 */
export function userTurnCount(messages) {
  let n = 0
  for (const message of messages) if (message?.role === 'user') n++
  return n
}

/** 当前 active context 里召回内容占用的 token（用于 maxActiveRecallTokens） */
export function activeRecallTokens(messages) {
  let sum = 0
  for (const message of messages) {
    if (message?.role !== 'toolResult') continue
    const text = messageText(message)
    if (parseRecall(text)) sum += estimateTokens(text)
  }
  return sum
}

/* ══════════════════════════════════════════════════════════════════
 * 结构化压缩（§12.8）与 Episode 汇总（§13.4）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 从状态文件拼结构化摘要（`session_before_compact` 的返回体）。
 *
 * **它不调用模型**：输入的 Task State 与 Episode 必须已经存在
 * （由调用方生成，见 `context.js` 的说明）。本函数只做
 * 「引用而不重新摘要」的装配（§12.7）与字段完整性检查。
 *
 * @returns {{ok: true, summary: string, fields: object} | {ok: false, reason: string}}
 */
export function buildStructuredSummary(state, opts = {}) {
  if (!state || typeof state !== 'object' || !state.task) return { ok: false, reason: 'no-task-state' }
  const block = renderTaskState(state.task, {
    /* 压缩接手时的档位由调用方告知（它才知道 freshness 分档）—— 头行不能默写 fresh */
    ...(opts.freshness ? { freshness: opts.freshness } : {}),
    ...(Number.isFinite(state.sourceWatermark?.entryCount) ? { sourceHead: state.sourceWatermark.entryCount } : {})
  })
  if (!block) return { ok: false, reason: 'empty-task-state' }
  /*
   * Episode 的**消费门**（EpisodeState 切片：先 shadow 后放行）。
   *
   * 默认 `false`（不渲染）。理由与 `state.inject` 当初的 shadow 模式同源：
   * Episode 的语义是**模型自己写的段结论**，而这里的内容会直接进 pi 的压缩摘要
   * （模型可见）。没有真实会话的质量数据就让它们上场，等于拿用户的上下文做实验。
   * 生成与校验照常（落盘到 `context-state/<id>.json`），质量可以从状态文件里看。
   * 放行由 `YAN_CONTEXT_POLICY.state.episodeInject` 控制（默认关）。
   */
  const includeEpisodes = opts.includeEpisodes === true
  const episodes = includeEpisodes && Array.isArray(state.episodes) ? state.episodes : []
  /*
   * Episode 旁路防线（第四轮外部评审 P0-4）：旧 EpisodeState 的语义路径还没接上
   * 新契约，所以**有递归摘要风险的条目一律不进摘要**（§12.7 的判据在源头先做一次，
   * 真正的 schema 执法仍在 `shared/context-state.ts`）。
   */
  const risky = episodeRecursionRisk(episodes)
  const riskyIds = new Set(risky.map((r) => r.episode))
  const safeEpisodes = riskyIds.size ? episodes.filter((e) => !riskyIds.has(e?.id)) : episodes
  const lines = ['<HISTORICAL_CONTEXT>']
  for (const episode of safeEpisodes) {
    lines.push(`Episode ${episode.id}: ${episode.objective} → ${episode.outcome || '(in progress)'}`)
    for (const ref of episode.importantRefs ?? []) lines.push(`  ref: ${ref}`)
  }
  lines.push('</HISTORICAL_CONTEXT>')
  lines.push(block)
  const fields = {
    task: !!state.task.task?.objective,
    decisions: (state.task.decisions ?? []).length > 0,
    constraints: (state.task.constraints ?? []).length > 0,
    failed: (state.task.failedAttempts ?? []).length > 0,
    unresolved: (state.task.unresolved ?? []).length > 0,
    nextActions: (state.task.nextActions ?? []).length > 0
  }
  /*
   * 接管条件（N21-4 生成器落地后放宽，§16.6.2）：
   *   `schema valid ∧ ancestry usable ∧ historical generation valid`。
   * “六类字段齐备”不再是必需 —— 生成器产出的是**真实状态**，
   * “真的没有 failedAttempts”与“忘了问”是两件事；形状合法性由 schema 校验负责。
   * 需要保守判定的调用方（测试 / 未来的保守模式）仍可传 `requiredFields`。
   */
  const required = opts.requiredFields ?? []
  const missing = required.filter((key) => !fields[key])
  if (missing.length && !opts.allowMissing) return { ok: false, reason: 'missing-fields', missing, fields }
  return { ok: true, summary: lines.join('\n'), fields, episodesDropped: riskyIds.size, episodesSkipped: includeEpisodes ? 0 : (Array.isArray(state.episodes) ? state.episodes.length : 0) }
}

/**
 * 由 Episode 列表重建 Task State 的**引用型**汇总（§13.4）。
 *
 * 注意它只做三件事：合并去重、把 Episode 的 id 放进 `episodeRefs`、
 * 把重要引用放进 `archiveRefs`。**不**把 Episode 的文本再摘要一遍
 * （那正是 §12.7 禁止的递归摘要）。原始条目是否还在、sourceRange 是否
 * 合法由 schema 校验负责。
 */
export function mergeEpisodeRefs(task, episodes) {
  const base = task && typeof task === 'object' ? task : {}
  const episodeRefs = new Set(base.episodeRefs ?? [])
  const archiveRefs = new Set(base.archiveRefs ?? [])
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    if (episode?.id) episodeRefs.add(episode.id)
    for (const ref of episode?.importantRefs ?? []) archiveRefs.add(ref)
  }
  return { ...base, episodeRefs: [...episodeRefs], archiveRefs: [...archiveRefs] }
}

/**
 * 判断 state 里的 Episode 是否可能触发递归摘要。
 *
 * §12.7 的判据是 `sourceRange` 必须指回**原始条目**；这里做的是
 * 上下文层的预检（在扩展侧，拿不到原始 entry 列表），
 * 真正的 schema 执法仍在 `shared/context-state.ts`。
 */
export function episodeRecursionRisk(episodes) {
  const ids = new Set((Array.isArray(episodes) ? episodes : []).map((e) => e?.id).filter(Boolean))
  const bad = []
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    for (const key of ['from', 'to']) {
      const value = episode?.sourceRange?.[key]
      if (typeof value === 'string' && (value.startsWith('ctx://') || ids.has(value))) {
        bad.push({ episode: episode.id, key, value })
      }
    }
  }
  return bad
}

/* ══════════════════════════════════════════════════════════════════
 * 诊断
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 统一的诊断记录行（结构化，便于探针用正则断言）。
 * 只在 `YAN_CONTEXT_EXT_LOG` 指向文件时由调用方落盘。
 */
export function diagnostic(hook, payload) {
  return JSON.stringify({ ts: Date.now(), hook, ...payload })
}
