/*
 * 砚内置「旧工具输出裁剪 + 自动压缩上限」扩展。
 *
 * ── 做什么 ──
 *   ① 裁剪：上下文变大后，把较早的大段工具输出换成一行存根，再发给模型。
 *      只改 pi `context` 钩子里「这一次请求的视图」：会话文件、界面历史、
 *      压缩输入都不变；不调模型、不做摘要、不提供召回（模型需要时重新运行或 read 原文件）。
 *   ② 自动压缩上限：整轮结束（agent_settled）后上下文超过上限，就调 pi 原生 compact()。
 *      大窗口模型（1M、272K）按 pi 默认要到「窗口 − 16K」才压缩，这里把触发线提前。
 *
 * ── 为什么按批次、挑时机裁剪 ──
 *   修改旧消息可能使后续前缀不再命中；具体折扣、写入时机与有效期取决于服务商。
 *   因此先规划候选批次，不直接改消息：新节省不足时继续复用原前缀，等候选积累后一次提交。
 *   距上次请求超过 CACHE_COLD_MS 或新进程只表示缓存可能已冷，不保证服务端过期；
 *   此时在软线尝试规划，否则要超过硬线。两种情况都需要足够批次收益。
 *   接近已知模型窗口时，容量优先于缓存收益，但不突破技能和近期工具组等保护。
 *   同一投影中已裁的条目保持存根，只有提交新批次才改变已有请求前缀。
 *
 * ── 边界 ──
 *   · 通常保留最近 KEEP_TURNS 轮；超过硬线时也可裁这些轮里的旧工具组，但每轮最近 KEEP_TOOL_GROUPS 组保留；
 *     技能文件（SKILL.md）、错误结果及尚未完成的工具组不裁；
 *   · 裁剪开关与两个阈值读 desktop.json（每次读，切换下一次请求就生效）；读不到按缺省开；
 *     是否提前压缩跟随 pi 原生的自动压缩开关（pi 的 settings.json），砚不另设开关；
 *   · 阈值公式与 src/main/compaction.ts 的 inkstoneCompactAt 保持一致。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_TRIM_TOKENS = 80_000
/** 自动压缩上限的缺省值，与 src/shared/context-limits.ts 的 DEFAULT_AUTO_COMPACT_TOKENS 必须一致（test-unit 有对照断言）。 */
export const DEFAULT_COMPACT_TOKENS = 400_000
/** 窗口较小的模型按比例提前：裁剪线不超过窗口的 30%，压缩线不超过窗口的 90%（给 pi 原生保底线留余量）。 */
const TRIM_WINDOW_RATIO = 0.3
const COMPACT_WINDOW_RATIO = 0.9
/** 一批裁到软线的这个比例以下，留出余量，避免下一轮又撞线。 */
const TRIM_TARGET_RATIO = 0.6
/** 超过软线这么多倍时允许规划新批次，但仍需通过收益门槛。 */
const HARD_RATIO = 1.5
/** 新批次至少省软线的四分之一和当前发送量的五分之一，避免保护区移动导致逐轮小裁。 */
const MIN_BATCH_THRESHOLD_RATIO = 0.25
const MIN_BATCH_CONTEXT_RATIO = 0.2
/** 到已知窗口的80%时优先腾空间；仍由 pi 原生压缩处理无法裁掉的内容。 */
const CAPACITY_PRESSURE_RATIO = 0.8
/** 缓存冷热的启发式间隔，不表示服务商承诺的TTL；超过间隔也不跳过批次收益门槛。 */
export const CACHE_COLD_MS = 5 * 60 * 1000
/** 压缩失败（例如 pi 认为可压缩的部分太少）后，上下文要再增长这么多倍才重试。 */
const RETRY_GROWTH = 1.2
const KEEP_TURNS = 3
const KEEP_TOOL_GROUPS = 3
/** 小于这个字符数（约 1K token）的输出不值得换成存根。 */
const MIN_TRIM_CHARS = 4_000
const IMAGE_TOKENS = 1_200

/**
 * 提前压缩跟随 pi 原生的「自动压缩」开关（设置页同一个开关，pi 写在全局 settings.json 的 compaction.enabled）：
 * 用户关掉自动压缩时，砚也不提前压缩。读不到按 pi 的缺省（开）。
 */
export function piCompactionEnabled() {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
    return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))?.compaction?.enabled !== false
  } catch {
    return true
  }
}

export function readContextSettings() {
  const compact = piCompactionEnabled()
  try {
    const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    const s = JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
    return {
      trim: s?.contextTrim !== false,
      trimTokens: num(s?.contextTrimTokens, DEFAULT_TRIM_TOKENS),
      compact,
      compactTokens: num(s?.autoCompactTokens, DEFAULT_COMPACT_TOKENS)
    }
  } catch {
    return { trim: true, trimTokens: DEFAULT_TRIM_TOKENS, compact, compactTokens: DEFAULT_COMPACT_TOKENS }
  }
}

export function trimAt(setting, contextWindow) {
  return contextWindow > 0 ? Math.min(setting, Math.floor(contextWindow * TRIM_WINDOW_RATIO)) : setting
}

export function compactAt(setting, contextWindow) {
  return contextWindow > 0 ? Math.min(setting, Math.floor(contextWindow * COMPACT_WINDOW_RATIO)) : setting
}

/** 粗估 token：CJK 约 1.5 字一个，其余约 4 字符一个（与 context-inspect.js 一致）。 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  const cjk = (s.match(/[　-鿿가-힯＀-￯]/g) ?? []).length
  return Math.ceil((s.length - cjk) / 4 + cjk / 1.5)
}

function outputSize(message) {
  let chars = 0
  let tokens = 0
  let images = 0
  for (const part of message.content ?? []) {
    if (part?.type === 'text') {
      chars += String(part.text ?? '').length
      tokens += estimateTokens(part.text)
    } else if (part?.type === 'image') {
      images += 1
      tokens += IMAGE_TOKENS
    }
  }
  return { chars, tokens, images }
}

function describeCall(call) {
  const args = call?.arguments ?? {}
  const brief = args.command ?? args.path ?? args.file_path ?? args.url ?? ''
  const text = String(brief).replace(/\s+/g, ' ').trim()
  return text ? `${call.name} \`${text.length > 120 ? `${text.slice(0, 117)}…` : text}\`` : String(call?.name ?? 'tool')
}

function isSkillRead(call) {
  const path = String(call?.arguments?.path ?? call?.arguments?.file_path ?? '')
  return call?.name === 'read' && /(^|[\\/])SKILL\.md$/i.test(path)
}

export function stubText(call, size) {
  const what = size.images ? `${size.images} 张图片` : `约 ${size.tokens} token`
  return `[较早的工具输出已省略：${describeCall(call)}，${what}。需要时重新运行，或用 read 读原文件。]`
}

/** 原生用量锚在最近一次成功且有用量的回复；错误/取消不能覆盖它。 */
function usageKey(message) {
  const usage = message?.usage
  if (message?.role !== 'assistant' || !usage || ['error', 'aborted'].includes(message.stopReason)) return undefined
  const total = usage.totalTokens || ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0))
  if (!(total > 0)) return undefined
  return createHash('sha256').update(JSON.stringify([message.timestamp, message.provider, message.model, usage, message.content])).digest('hex')
}

function savedTokens(messages, trimmed) {
  let saved = 0
  for (const message of messages) if (message?.role === 'toolResult') saved += trimmed.get(message.toolCallId) ?? 0
  return saved
}

/** 同一 assistant 发出的并行调用是一组；每个用户轮分别保护最近几组。 */
function toolGroups(messages) {
  const groups = new Map()
  const results = new Set(messages.filter(m => m?.role === 'toolResult').map(m => m.toolCallId))
  let turn = []
  const protect = () => { for (const group of turn.slice(-KEEP_TOOL_GROUPS)) group.recent = true }
  for (const message of messages) {
    if (message?.role === 'user') { protect(); turn = [] }
    if (message?.role !== 'assistant') continue
    const calls = (message.content ?? []).filter(part => part?.type === 'toolCall')
    if (!calls.length) continue
    const group = { complete: calls.every(call => results.has(call.id)), recent: false }
    turn.push(group)
    for (const call of calls) groups.set(call.id, group)
  }
  protect()
  return groups
}

/**
 * 纯函数：给出这一次请求要发的消息。
 *
 * `trimmed` 是进程内的已裁集合（toolCallId → 省下的 token），会被就地追加。
 * `projectedTokens` 是未裁剪口径的上下文大小。宿主调用处先补回用量已包含的裁剪量，
 * 再由这里扣一次当前存根节省；不能直接把 pi 的已裁请求用量当作未裁估值。
 * `cacheCold` 只决定软线/硬线的规划时机；提交前仍要有足够收益，除非逼近已知 contextWindow。
 */
export function trimMessages(messages, { trimmed, projectedTokens, threshold, cacheCold = true, contextWindow = 0 }) {
  const calls = new Map()
  for (const m of messages) {
    if (m?.role !== 'assistant') continue
    for (const part of m.content ?? []) if (part?.type === 'toolCall') calls.set(part.id, part)
  }

  let userSeen = 0
  let boundary = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user' && ++userSeen === KEEP_TURNS) {
      boundary = i
      break
    }
  }
  if (userSeen < KEEP_TURNS) boundary = 0

  if (typeof projectedTokens === 'number' && threshold > 0) {
    let effective = projectedTokens - savedTokens(messages, trimmed)
    const hardLine = threshold * HARD_RATIO
    const capacityPressure = contextWindow > 0 && Number.isFinite(contextWindow) && effective >= contextWindow * CAPACITY_PRESSURE_RATIO
    if (capacityPressure || effective > (cacheCold ? threshold : hardLine)) {
      const before = effective
      const proposed = new Map()
      const target = Math.floor(threshold * TRIM_TARGET_RATIO)
      const groups = toolGroups(messages)
      const cut = (start, end, recentTurns) => {
        for (let i = start; i < end && effective > target; i++) {
          const m = messages[i]
          if (m?.role !== 'toolResult' || m.isError || trimmed.has(m.toolCallId) || proposed.has(m.toolCallId)) continue
          const group = groups.get(m.toolCallId)
          if (!group?.complete || (recentTurns && group.recent)) continue
          const call = calls.get(m.toolCallId)
          if (isSkillRead(call)) continue
          const size = outputSize(m)
          if (size.chars < MIN_TRIM_CHARS && size.images === 0) continue
          const stubTokens = estimateTokens(stubText(call, size))
          const gain = Math.max(0, size.tokens - stubTokens)
          if (!gain) continue
          proposed.set(m.toolCallId, gain)
          effective -= gain
        }
      }
      cut(0, boundary, false)
      // 只有旧轮裁过后仍超过硬线，才放宽近期长轮；不为少量超软线破坏近期证据。
      if (effective > hardLine || capacityPressure) cut(boundary, messages.length, true)
      const minimumGain = Math.max(threshold * MIN_BATCH_THRESHOLD_RATIO, before * MIN_BATCH_CONTEXT_RATIO)
      // 不足一批时完全不提交，既有存根和候选原文都保持不变；下一请求会重新规划。
      if (capacityPressure || before - effective >= minimumGain) {
        for (const [id, gain] of proposed) trimmed.set(id, gain)
      }
    }
  }

  let changed = false
  const next = messages.map((m) => {
    if (m?.role !== 'toolResult' || !trimmed.has(m.toolCallId)) return m
    changed = true
    const call = calls.get(m.toolCallId) ?? { name: m.toolName }
    return { ...m, content: [{ type: 'text', text: stubText(call, outputSize(m)) }] }
  })
  return changed ? next : undefined
}

export default function contextTrimExtension(pi) {
  /** toolCallId → 省下的 token；只增不减，保证之后请求的前缀稳定。 */
  const trimmed = new Map()
  let compacting = false
  /** 上一次发请求的时间；进程刚启动时没有，视为缓存已冷。 */
  let lastRequestAt
  let lastResponse
  let requestSavings = 0
  let projectionBoundary
  const resetTrim = () => {
    trimmed.clear()
    lastResponse = undefined
    requestSavings = 0
    projectionBoundary = undefined
    lastRequestAt = undefined
  }
  pi.on('session_start', resetTrim)
  pi.on('session_tree', resetTrim)
  pi.on('session_compact', resetTrim)
  pi.on('message_end', (event) => {
    const key = usageKey(event?.message)
    if (key) lastResponse = { key, saved: requestSavings }
  })

  pi.on('context', (event, ctx) => {
    const now = Date.now()
    const cacheCold = lastRequestAt === undefined || now - lastRequestAt > CACHE_COLD_MS
    lastRequestAt = now
    requestSavings = 0
    const settings = readContextSettings()
    if (!settings.trim) return undefined
    const messages = event?.messages
    if (!Array.isArray(messages) || messages.length === 0) return undefined
    // 原生 context_edit 会使此前用量失去参考意义，改为估算完整投影。
    const branch = ctx?.sessionManager?.getBranch?.() ?? []
    const boundary = branch.findLast(entry => entry.type === 'context_edit' || entry.type === 'compaction')?.id
    if (boundary !== projectionBoundary) { lastResponse = undefined; projectionBoundary = boundary }
    let anchor
    for (let i = messages.length - 1; i >= 0 && !anchor; i--) anchor = usageKey(messages[i])
    const resultIds = new Set(messages.filter(m => m?.role === 'toolResult').map(m => m.toolCallId))
    for (const id of trimmed.keys()) if (!resultIds.has(id)) trimmed.delete(id)
    const reflected = lastResponse && lastResponse.key === anchor ? lastResponse.saved : 0
    const usage = ctx?.getContextUsage?.()
    const threshold = trimAt(settings.trimTokens, usage?.contextWindow ?? 0)
    const projectedTokens = typeof usage?.tokens === 'number' ? usage.tokens + reflected : undefined
    const next = trimMessages(messages, { trimmed, projectedTokens, threshold, cacheCold, contextWindow: usage?.contextWindow ?? 0 })
    requestSavings = savedTokens(messages, trimmed)
    return next ? { messages: next } : undefined
  })

  /*
   * 压缩没能把上下文压到上限以下（失败，或 pi 保留的近期内容本身就超过上限）时，
   * 上下文要再增长 RETRY_GROWTH 倍才重试 —— 否则每轮结束都会再调一次模型做压缩。
   * 实测：pi 按「字符 ÷ 4」估算保留量，中文内容实际保留的 token 明显多于 keepRecentTokens。
   */
  let holdUntil
  let justCompacted = false
  pi.on('agent_settled', (_event, ctx) => {
    const settings = readContextSettings()
    if (!settings.compact || compacting) return
    const usage = ctx?.getContextUsage?.()
    if (typeof usage?.tokens !== 'number') return
    const line = compactAt(settings.compactTokens, usage.contextWindow ?? 0)
    if (usage.tokens <= line) {
      holdUntil = undefined
      justCompacted = false
      return
    }
    if (justCompacted) {
      justCompacted = false
      holdUntil = usage.tokens * RETRY_GROWTH
      return
    }
    if (holdUntil !== undefined && usage.tokens < holdUntil) return
    compacting = true
    const tokens = usage.tokens
    const done = () => {
      compacting = false
      holdUntil = undefined
      justCompacted = true
      /* 压缩后旧消息已换成摘要，旧的已裁记录不再对应任何消息 */
      resetTrim()
    }
    const failed = () => {
      compacting = false
      holdUntil = tokens * RETRY_GROWTH
    }
    try {
      ctx.compact({ onComplete: done, onError: failed })
    } catch {
      failed()
    }
  })
}
