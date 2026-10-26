import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_COMPACT_TOKENS = 400_000
const COMPACT_WINDOW_RATIO = 0.9
const COMPACT_WATCHDOG_MS = 180_000
const RETRY_GROWTH = 1.2

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
    const tokens = s?.autoCompactTokens
    return { compact, compactTokens: typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? tokens : DEFAULT_COMPACT_TOKENS }
  } catch {
    return { compact, compactTokens: DEFAULT_COMPACT_TOKENS }
  }
}

export function compactAt(setting, contextWindow) {
  return contextWindow > 0 ? Math.min(setting, Math.floor(contextWindow * COMPACT_WINDOW_RATIO)) : setting
}

export default function autoCompactExtension(pi) {
  let compacting = false
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
