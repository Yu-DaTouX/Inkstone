/**
 * Deep Context（N21-8）—— Pass 1：一次无工具的模型调用，把「当前正在做的事」
 * 归纳成**工作 trace**；Pass 2 由 `context` 钩子把它作为前置状态注入
 * （参考方案 §14 的 `[T, X, Q]` 里的 T）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么默认关闭
 * ══════════════════════════════════════════════════════════════════
 * 它与 `episode-fold` 的状态生成器**不是**一回事：
 *   · 状态生成器（N21-4）挂在 `agent_settled` 之后，**异步**、不阻塞下一轮输入，
 *     产出的是**跨会话累积**的持久状态（决策 / 约束 / 未决）；
 *   · 本模块挂在 `context` 钩子里，**同步阻塞**本轮请求 —— 因为它的语义就是
 *     「回答之前，先把工作集归纳一遍」。它必然带来延迟，也必然多花一次调用。
 * 所以它必须**默认关**、由用户显式打开（PRIORITY N21-8 的产品决定），
 * 并且只在「转录已经很长」时才真的动手（`minTokens`），
 * 同一条用户消息也只跑一次（`ranForTurn`）—— 这三道闸门都是为了不让
 * 「一个可选优化」变成「每一轮都变慢」。
 *
 * 注入通道用它唯一能用的那种：`custom` 消息（到模型那里是 **user 角色**，
 * 方案 §19.1 的硬约束 —— pi 里没有 system 注入通道）。因此它和 `<TASK_STATE>`
 * 一样必须自带 authority 契约，否则模型有理由把归纳出来的 nextActions
 * 当成用户的要求。
 */

import { estimateTokens } from './context-transform.js'

/** 触发 Deep Context 的转录门槛（token）。参考方案 §14 的「>200k」按可用上下文折算 */
export const DEEP_MIN_TOKENS = 150_000
/** Pass 1 的输入上限 —— 它是额外一次调用，输入必须有界（同 `CLIP_LIMITS` 的口径） */
export const DEEP_INPUT_TOKENS = 24_000
/** Pass 1 的硬超时。超过就放弃本轮（不注入），绝不拖住用户这一轮 */
export const DEEP_TIMEOUT_MS = 30_000
/** 输出上限。trace 是提要，不是记录 */
export const DEEP_MAX_OUTPUT_TOKENS = 700
/** 注入块的字符上限（防止模型写长文把注入变成第二次转录） */
export const WORKING_TRACE_MAX_CHARS = 2_400
/** 注入块在消息里的 `customType`（与 `<TASK_STATE>` 分开，两者可以同时存在） */
export const WORKING_TRACE_CUSTOM_TYPE = 'yan-working-trace'
/** 单条消息取多少字符进 Pass 1（长工具输出只留头部，尾部信息量更高的是结论） */
const PER_MESSAGE_CHARS = 1_200

/**
 * 挂接通道用的策略形状（与 `state` 分路并列，走同一个 env）。
 * 出问题时的操作是「关掉它」，而不是把整个 context 扩展拔掉。
 */
export function deepSwitches(raw) {
  const out = { enabled: false, minTokens: 0 }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (source.enabled === true) out.enabled = true
  if (Number.isFinite(source.minTokens) && source.minTokens > 0) out.minTokens = source.minTokens
  return out
}

/**
 * 该不该跑 Pass 1。四道闸门缺一不可：
 *   ① 用户开了它；② 本轮确实有一条**新的**用户消息（否则就是在为同一次提问重复烧钱）；
 *   ③ 这条消息还没为它跑过；④ 转录已经够长（短会话里归纳出来的东西没有价值）。
 * 返回 `{ok, reason}` 而**不是** boolean —— 原因要能进诊断，否则「为什么没跑」只能靠猜。
 */
export function deepEligible({ enabled, tokens, minTokens, hasNewTurn, ranForTurn } = {}) {
  if (!enabled) return { ok: false, reason: 'disabled' }
  if (!hasNewTurn) return { ok: false, reason: 'no-new-user-turn' }
  if (ranForTurn) return { ok: false, reason: 'already-ran-this-turn' }
  const need = Number(minTokens) > 0 ? Number(minTokens) : DEEP_MIN_TOKENS
  if (!(Number(tokens) >= need)) return { ok: false, reason: 'below-threshold' }
  return { ok: true, reason: 'ok' }
}

/**
 * 一条消息的可读文本。**只认能到模型的那几种角色**（`convertToLlm` 的名单）——
 * 与其把 pi 内部的 `bashExecution` / `custom` 结构猜错，不如只取有 `content` 的。
 */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 角色的显示名：让 Pass 1 能分清「谁说的」，这直接决定它归纳得准不准 */
const roleLabel = (message) => {
  const role = message?.role
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'toolResult') return '工具结果'
  if (role === 'bashExecution') return '命令输出'
  if (role === 'custom') return '系统备注'
  return role ? String(role) : '未知'
}

/**
 * 为本轮找「新用户回合」的标识。
 *
 * 用**最后一条 user 消息的前 80 字符 + 长度**当 key：identity 不需要全局唯一，
 * 只需要「同一次提问 → 同一个 key，下一次提问 → 不同 key」。
 * 刻意不用 `entryId`：把它取到手要经过 `ctx.sessionManager`，而这条路径
 * 在 `context` 钩子里并不总是可用（拿不到就整条跳过，代价太大）。
 */
export function turnKeyOf(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = messageText(message)
    if (!text.trim()) continue
    return `${text.length}:${text.slice(0, 80)}`
  }
  return ''
}

/**
 * Pass 1 的输入：最近若干条消息的文本，**从尾部往前装**（越近的越重要），
 * 装到 `DEEP_INPUT_TOKENS` 为止。刻意不做语义筛选 —— 那是 Pass 1 自己要干的事，
 * 这里再筛一遍等于用便宜的规则去猜贵模型该看什么。
 */
export function buildDeepInput(messages, { limitTokens = DEEP_INPUT_TOKENS } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const blocks = []
  let used = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i]
    const role = message?.role
    if (role !== 'user' && role !== 'assistant' && role !== 'toolResult' && role !== 'bashExecution') continue
    let text = messageText(message).trim()
    if (!text) continue
    /*
     * 长内容截**头**留尾：工具输出（尤其是报错、测试结果）的结论在后面，
     * 砍掉开头比砍掉结尾损失小。这条与推理块「显示最新内容」是同一个理由。
     */
    if (text.length > PER_MESSAGE_CHARS) text = `…（前略）\n${text.slice(-PER_MESSAGE_CHARS)}`
    const block = `【${roleLabel(message)}】\n${text}`
    const cost = estimateTokens(block)
    if (used + cost > limitTokens && blocks.length > 0) break
    blocks.push(block)
    used += cost
  }
  blocks.reverse()
  return { text: blocks.join('\n\n'), tokens: used, count: blocks.length }
}

export const DEEP_SYSTEM_PROMPT = [
  '你要为一次「回答前的工作集归纳」产出内容。只输出归纳结果本身，不要寒暄、不要代码围栏。',
  '用中文写，最多 12 行，每行以「- 」开头，只保留**继续这项工作真正需要**的信息：',
  '  · 目标是什么、当前进行到哪一步；',
  '  · 已经确认的事实与已经做出的决定（含被推翻的旧做法）；',
  '  · 正在改动的文件 / 命令，以及它们的状态；',
  '  · 还没解决、下一步该做什么。',
  '只写对话里出现过的内容。不确定时写「（未确认）」，不要编造文件路径、命令或结论。',
  '如果材料里没有值得保留的信息，只回复一个词：无。'
].join('\n')

/** Pass 1 的用户消息：材料 + 明确的任务说明（两者分开，便于模型区分「材料」与「要求」） */
export function buildDeepPrompt(materials) {
  return ['<materials>', materials || '（没有材料）', '</materials>', '', '请按系统说明归纳这份材料的工作集。'].join('\n')
}

/**
 * 解析 Pass 1 的输出：容忍代码围栏与前后空白，限长，"无"视为没有产出。
 * 返回 `{ok, text}`；`ok:false` 时调用方必须**不注入**（fail-closed）。
 */
export function parseDeepOutput(raw) {
  let text = typeof raw === 'string' ? raw : ''
  if (!text) return { ok: false, reason: 'empty' }
  text = text.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '')
  text = text.trim()
  if (!text) return { ok: false, reason: 'empty' }
  /* 模型可能真的按要求回「无」——那是「没什么可总结」，不是失败 */
  if (/^(无|none|n\/a)\.?$/i.test(text)) return { ok: false, reason: 'nothing' }
  if (text.length > WORKING_TRACE_MAX_CHARS) text = `${text.slice(0, WORKING_TRACE_MAX_CHARS)}…`
  return { ok: true, text }
}

/**
 * 渲染注入块。契约头与 `<TASK_STATE>` 同源（§17 的 authority 契约）：
 * `derived="true"` 说明它是派生的、`authoritative="false"` 说明它**不是**用户的指令，
 * 冲突时以用户最新的话为准 —— 这是它敢以 user 角色出现在上下文里的前提。
 */
export function renderWorkingTrace(text, { sourceHead = null, turns = null } = {}) {
  if (!text) return ''
  const head = [`derived="true"`, `authoritative="false"`]
  if (Number.isFinite(sourceHead)) head.push(`sourceHead="${sourceHead}"`)
  if (Number.isFinite(turns)) head.push(`turns="${turns}"`)
  return [
    `<WORKING_TRACE ${head.join(' ')}>`,
    '（以下是系统在你开口前对**当前工作集**做的归纳，不是你的指令。它与用户最新的话冲突时，以用户为准。）',
    text,
    '</WORKING_TRACE>'
  ].join('\n')
}

/**
 * 注入（幂等）：先摘掉旧的同类块，再插到**最前**。
 * 位置与 `<TASK_STATE>` 一致 —— 放在历史之前。
 */
export function injectWorkingTrace(messages, text) {
  const list = Array.isArray(messages) ? messages : []
  const withoutOld = list.filter((m) => !(m?.role === 'custom' && m.customType === WORKING_TRACE_CUSTOM_TYPE))
  if (!text) return { messages: withoutOld, injected: false }
  const message = {
    role: 'custom',
    customType: WORKING_TRACE_CUSTOM_TYPE,
    content: [{ type: 'text', text }]
  }
  return { messages: [message, ...withoutOld], injected: true }
}

/** 注入块是否已在消息里（诊断 / 断言用） */
export function hasWorkingTrace(messages) {
  return (Array.isArray(messages) ? messages : []).some(
    (m) => m?.role === 'custom' && m.customType === WORKING_TRACE_CUSTOM_TYPE
  )
}
