import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_TRIM_TOKENS = 80_000
export const DEFAULT_COMPACT_TOKENS = 400_000
const TRIM_WINDOW_RATIO = 0.3
const COMPACT_WINDOW_RATIO = 0.9
const TRIM_TARGET_RATIO = 0.6
const HARD_RATIO = 1.5
const MIN_BATCH_THRESHOLD_RATIO = 0.25
const MIN_BATCH_CONTEXT_RATIO = 0.2
const CAPACITY_PRESSURE_RATIO = 0.8
const MIN_PRESSURE_THRESHOLD_RATIO = 0.1
const MIN_PRESSURE_CONTEXT_RATIO = 0.05
const CACHE_COLD_MS = 5 * 60 * 1000
const COMPACT_WATCHDOG_MS = 180_000
const RETRY_GROWTH = 1.2
const KEEP_TURNS = 3
const KEEP_TOOL_GROUPS = 3
const KEEP_RECENT_TOOL_RESULTS = 8
const KEEP_RECENT_TOOL_TOKENS = 20_000
const SPILL_KEEP_MS = 7 * 24 * 60 * 60 * 1000
const MIN_TRIM_CHARS = 1_500
const MIN_INPUT_TRIM_CHARS = 1_000
const INPUT_TRIM_TOOLS = new Set(['write', 'edit'])
const IMAGE_TOKENS = 2_800

function compactWatchdogMs() {
  const raw = Number(process.env.YAN_COMPACT_WATCHDOG_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : COMPACT_WATCHDOG_MS
}

function yanDataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

function piCompactionEnabled() {
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
    const s = JSON.parse(readFileSync(join(yanDataDir(), 'desktop.json'), 'utf8'))
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

function stubText(call, size, path) {
  const head = `[Earlier tool output trimmed to save context: ${describeCall(call)}`
  if (size.images) return `${head}, ${size.images} image${size.images > 1 ? 's' : ''}. Re-read the source if you need it again.]`
  if (path) return `${head}, ~${size.tokens} tokens. Full output: ${path} (read it with offset/limit instead of re-running the call).]`
  return `${head}, ~${size.tokens} tokens. Re-run the call or read the source if you need it again.]`
}

function spillRoot() {
  return join(yanDataDir(), 'trimmed')
}

function spillKey(sessionId) {
  const key = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
  return key === '.' || key === '..' ? 'session' : key
}

export function spillDir(sessionId) {
  return join(spillRoot(), spillKey(sessionId))
}

function sweepSpills(ownName) {
  let entries
  try {
    entries = readdirSync(spillRoot())
  } catch {
    return
  }
  const now = Date.now()
  for (const name of entries) {
    if (!name || name === ownName) continue
    const path = join(spillRoot(), name)
    try {
      if (now - statSync(path).mtimeMs > SPILL_KEEP_MS) rmSync(path, { recursive: true, force: true })
    } catch {
    }
  }
}

export function spillText(message) {
  return (message.content ?? []).map(part => part?.type === 'text' ? String(part.text ?? '') : part?.type === 'image' ? '[image]' : '').join('\n')
}

export function createSpiller(dirFor) {
  const paths = new Map()
  const spill = (message) => {
    const id = String(message.toolCallId ?? '')
    if (!id || outputSize(message).images) return undefined
    const known = paths.get(id)
    if (known === null) return undefined
    const path = known ?? join(dirFor(), `${id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160)}.txt`)
    try {
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, spillText(message), { encoding: 'utf8', mode: 0o600 })
      }
      paths.set(id, path)
      return path
    } catch {
      if (known === undefined) paths.set(id, null)
      return known
    }
  }
  spill.reset = () => paths.clear()
  return spill
}

const inputKey = (id) => `input:${id}`
const baseId = (key) => (String(key).startsWith('input:') ? String(key).slice(6) : key)

function trimmedInput(call) {
  const args = call?.arguments ?? {}
  const path = args.path ?? args.file_path
  const what = call?.name === 'write'
    ? `${typeof args.content === 'string' ? args.content.split('\n').length : '?'} lines written`
    : `${Array.isArray(args.edits) ? args.edits.length : 1} replacement(s)`
  return { ...(path ? { path } : {}), trimmed: `[Earlier ${call?.name ?? 'tool'} input trimmed to save context: ${what}. Read the file for its current content.]` }
}

function inputGain(call) {
  const text = JSON.stringify(call?.arguments ?? {})
  if (text.length < MIN_INPUT_TRIM_CHARS) return 0
  return Math.max(0, estimateTokens(text) - estimateTokens(JSON.stringify(trimmedInput(call))))
}

function usageKey(message) {
  const usage = message?.usage
  if (message?.role !== 'assistant' || !usage || ['error', 'aborted'].includes(message.stopReason)) return undefined
  const total = usage.totalTokens || ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0))
  if (!(total > 0)) return undefined
  return createHash('sha256').update(JSON.stringify([message.timestamp, message.provider, message.model, usage, message.content])).digest('hex')
}

function savedTokens(messages, trimmed) {
  const ids = new Set(messages.filter(m => m?.role === 'toolResult').map(m => m.toolCallId))
  let saved = 0
  for (const [key, gain] of trimmed) if (ids.has(baseId(key))) saved += gain
  return saved
}

function toolGroups(messages) {
  const groups = new Map()
  const results = new Set(messages.filter(m => m?.role === 'toolResult').map(m => m.toolCallId))
  let turn = []
  const protect = () => {
    let budget = KEEP_RECENT_TOOL_TOKENS
    for (let i = turn.length - 1, kept = 0; i >= 0 && kept < KEEP_TOOL_GROUPS; i--, kept += 1) {
      const group = turn[i]
      if (kept > 0 && budget <= 0) break
      group.recent = true
      for (const result of group.results) budget -= outputSize(result).tokens
    }
  }
  for (const message of messages) {
    if (message?.role === 'user') { protect(); turn = [] }
    if (message?.role === 'toolResult') {
      groups.get(message.toolCallId)?.results.push(message)
      continue
    }
    if (message?.role !== 'assistant') continue
    const calls = (message.content ?? []).filter(part => part?.type === 'toolCall')
    if (!calls.length) continue
    const group = { complete: calls.every(call => results.has(call.id)), recent: false, results: [] }
    turn.push(group)
    for (const call of calls) groups.set(call.id, group)
  }
  protect()
  return groups
}

function recentToolResults(messages) {
  const keep = new Set()
  let count = 0
  let tokens = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'toolResult') continue
    if (count >= KEEP_RECENT_TOOL_RESULTS && tokens >= KEEP_RECENT_TOOL_TOKENS) break
    keep.add(m.toolCallId)
    count += 1
    tokens += outputSize(m).tokens
  }
  return keep
}

function activeToolResults(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant') continue
    const ids = (m.content ?? []).filter(part => part?.type === 'toolCall').map(part => part.id)
    if (ids.length) return new Set(ids)
  }
  return new Set()
}

export function trimMessages(messages, { trimmed, projectedTokens, threshold, cacheCold = true, contextWindow = 0, spill }) {
  const calls = new Map()
  const failed = new Set()
  for (const m of messages) {
    if (m?.role === 'toolResult' && m.isError) failed.add(m.toolCallId)
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
    const overBudget = effective > threshold
    if (capacityPressure || overBudget) {
      const before = effective
      const proposed = new Map()
      const target = Math.floor(threshold * TRIM_TARGET_RATIO)
      const groups = toolGroups(messages)
      const cut = (start, end, recentTurns, keep) => {
        for (let i = start; i < end && effective > target; i++) {
          const m = messages[i]
          if (m?.role === 'assistant') {
            for (const call of m.content ?? []) {
              if (call?.type !== 'toolCall' || !INPUT_TRIM_TOOLS.has(call.name) || failed.has(call.id)) continue
              const key = inputKey(call.id)
              if (trimmed.has(key) || proposed.has(key) || keep?.has(call.id)) continue
              const group = groups.get(call.id)
              if (!group?.complete || (recentTurns && group.recent)) continue
              const gain = inputGain(call)
              if (!gain) continue
              proposed.set(key, gain)
              effective -= gain
            }
            continue
          }
          if (m?.role !== 'toolResult' || m.isError || trimmed.has(m.toolCallId) || proposed.has(m.toolCallId)) continue
          if (keep?.has(m.toolCallId)) continue
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
      if (capacityPressure || effective > (cacheCold ? threshold : hardLine)) {
        cut(0, boundary, false)
        if (effective > hardLine || capacityPressure) cut(boundary, messages.length, true)
      }
      if (overBudget && effective > target) {
        const keep = recentToolResults(messages)
        for (const id of activeToolResults(messages)) keep.add(id)
        cut(boundary, messages.length, true, keep)
      }
      const minimumGain = Math.max(threshold * MIN_BATCH_THRESHOLD_RATIO, before * MIN_BATCH_CONTEXT_RATIO)
      const pressureGain = Math.max(threshold * MIN_PRESSURE_THRESHOLD_RATIO, before * MIN_PRESSURE_CONTEXT_RATIO)
      if (before - effective >= (capacityPressure ? pressureGain : minimumGain)) {
        for (const [id, gain] of proposed) trimmed.set(id, gain)
      }
    }
  }

  let changed = false
  const next = messages.map((m) => {
    if (m?.role === 'assistant') {
      const content = m.content ?? []
      if (!content.some(part => part?.type === 'toolCall' && trimmed.has(inputKey(part.id)))) return m
      changed = true
      return { ...m, content: content.map(part => (part?.type === 'toolCall' && trimmed.has(inputKey(part.id)) ? { ...part, arguments: trimmedInput(part) } : part)) }
    }
    if (m?.role !== 'toolResult' || !trimmed.has(m.toolCallId)) return m
    changed = true
    const call = calls.get(m.toolCallId) ?? { name: m.toolName }
    return { ...m, content: [{ type: 'text', text: stubText(call, outputSize(m), spill?.(m)) }] }
  })
  return changed ? next : undefined
}

export default function contextTrimExtension(pi) {
  const trimmed = new Map()
  let compacting = false
  let lastRequestAt
  let lastResponse
  let requestSavings = 0
  let projectionBoundary
  let sessionId
  const spill = createSpiller(() => spillDir(sessionId))
  const resetTrim = () => {
    trimmed.clear()
    spill.reset()
    if (sessionId) rmSync(spillDir(sessionId), { recursive: true, force: true })
    sweepSpills(sessionId ? spillKey(sessionId) : undefined)
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
    sessionId = ctx?.sessionManager?.getSessionId?.() || process.env.YAN_SESSION_ID
    const branch = ctx?.sessionManager?.getBranch?.() ?? []
    const boundary = branch.findLast(entry => entry.type === 'context_edit' || entry.type === 'compaction')?.id
    if (boundary !== projectionBoundary) { lastResponse = undefined; projectionBoundary = boundary }
    let anchor
    for (let i = messages.length - 1; i >= 0 && !anchor; i--) anchor = usageKey(messages[i])
    const resultIds = new Set(messages.filter(m => m?.role === 'toolResult').map(m => m.toolCallId))
    for (const id of trimmed.keys()) if (!resultIds.has(baseId(id))) trimmed.delete(id)
    const reflected = lastResponse && lastResponse.key === anchor ? lastResponse.saved : 0
    const usage = ctx?.getContextUsage?.()
    const threshold = trimAt(settings.trimTokens, usage?.contextWindow ?? 0)
    const projectedTokens = typeof usage?.tokens === 'number' ? usage.tokens + reflected : undefined
    const next = trimMessages(messages, { trimmed, projectedTokens, threshold, cacheCold, contextWindow: usage?.contextWindow ?? 0, spill })
    requestSavings = savedTokens(messages, trimmed)
    return next ? { messages: next } : undefined
  })

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
    const watchdog = setTimeout(() => { compacting = false }, compactWatchdogMs())
    watchdog.unref?.()
    const done = () => {
      clearTimeout(watchdog)
      compacting = false
      holdUntil = undefined
      justCompacted = true
      resetTrim()
    }
    const failed = () => {
      clearTimeout(watchdog)
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
