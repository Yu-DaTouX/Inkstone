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
 *   模型服务按前缀缓存，命中缓存的部分约为原价的一成。每改一条旧消息，它之后的内容都要按全价重发，
 *   实测（Codex，2026-10-10）一次裁剪那轮的全价输入从 0.5K 涨到 14.6K —— 短期内比不裁更贵。
 *   所以：① 等发送量超过软线，再一次裁到软线的 60%，不每轮小裁；
 *        ② 只在缓存大概率已经过期时开新的一批：距上次请求超过 CACHE_COLD_MS，或进程刚启动；
 *           发送量超过软线 HARD_RATIO 倍时不再等。
 *   已裁的条目记在进程内，只增不减，之后的请求前缀保持稳定。
 *
 * ── 边界 ──
 *   · 最近 KEEP_TURNS 轮原样保留；技能文件（SKILL.md）的读取结果不裁，那是模型要遵循的说明；
 *   · 裁剪开关与两个阈值读 desktop.json（每次读，切换下一次请求就生效）；读不到按缺省开；
 *     是否提前压缩跟随 pi 原生的自动压缩开关（pi 的 settings.json），砚不另设开关；
 *   · 阈值公式与 src/main/compaction.ts 的 inkstoneCompactAt 保持一致。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_TRIM_TOKENS = 80_000
export const DEFAULT_COMPACT_TOKENS = 250_000
/** 窗口较小的模型按比例提前：裁剪线不超过窗口的 30%，压缩线不超过窗口的 90%（给 pi 原生保底线留余量）。 */
const TRIM_WINDOW_RATIO = 0.3
const COMPACT_WINDOW_RATIO = 0.9
/** 一批裁到软线的这个比例以下，留出余量，避免下一轮又撞线。 */
const TRIM_TARGET_RATIO = 0.6
/** 超过软线这么多倍时不再等缓存过期。 */
const HARD_RATIO = 1.5
/** 主流服务的前缀缓存在空闲 5–10 分钟后失效；超过这个间隔再裁不会额外破坏缓存。 */
export const CACHE_COLD_MS = 5 * 60 * 1000
/** 压缩失败（例如 pi 认为可压缩的部分太少）后，上下文要再增长这么多倍才重试。 */
const RETRY_GROWTH = 1.2
const KEEP_TURNS = 3
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

/**
 * 纯函数：给出这一次请求要发的消息。
 *
 * `trimmed` 是进程内的已裁集合（toolCallId → 省下的 token），会被就地追加。
 * `projectedTokens` 是 pi 估算的完整上下文大小（未裁剪）。
 * `cacheCold` 为 true 表示缓存大概率已过期，可以在软线处开新的一批；否则要到硬线才开。
 */
export function trimMessages(messages, { trimmed, projectedTokens, threshold, cacheCold = true }) {
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
    let saved = 0
    for (const m of messages) if (m?.role === 'toolResult' && trimmed.has(m.toolCallId)) saved += trimmed.get(m.toolCallId)
    let effective = projectedTokens - saved
    if (effective > (cacheCold ? threshold : threshold * HARD_RATIO)) {
      const target = Math.floor(threshold * TRIM_TARGET_RATIO)
      for (let i = 0; i < boundary && effective > target; i++) {
        const m = messages[i]
        if (m?.role !== 'toolResult' || trimmed.has(m.toolCallId)) continue
        const call = calls.get(m.toolCallId)
        if (isSkillRead(call)) continue
        const size = outputSize(m)
        if (size.chars < MIN_TRIM_CHARS && size.images === 0) continue
        const stubTokens = estimateTokens(stubText(call ?? { name: m.toolName }, size))
        const gain = Math.max(0, size.tokens - stubTokens)
        trimmed.set(m.toolCallId, gain)
        effective -= gain
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

  pi.on('context', (event, ctx) => {
    const now = Date.now()
    const cacheCold = lastRequestAt === undefined || now - lastRequestAt > CACHE_COLD_MS
    lastRequestAt = now
    const settings = readContextSettings()
    if (!settings.trim) return undefined
    const messages = event?.messages
    if (!Array.isArray(messages) || messages.length === 0) return undefined
    const usage = ctx?.getContextUsage?.()
    const threshold = trimAt(settings.trimTokens, usage?.contextWindow ?? 0)
    const next = trimMessages(messages, { trimmed, projectedTokens: usage?.tokens ?? undefined, threshold, cacheCold })
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
      trimmed.clear()
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
