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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function projectTrusted(trustRaw, cwd) {
  if (!trustRaw || typeof trustRaw !== 'object' || Array.isArray(trustRaw)) return false
  const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  let cur = norm(cwd)
  for (;;) {
    for (const [key, value] of Object.entries(trustRaw)) {
      if (norm(key) === cur) return value === true
    }
    const idx = cur.lastIndexOf('/')
    if (idx <= 0) return false
    cur = cur.slice(0, idx)
  }
}

function piCompactionEnabled(cwd) {
  const dir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent')
  const user = readJson(join(dir, 'settings.json'))?.compaction?.enabled !== false
  if (!cwd) return user
  const project = readJson(join(cwd, '.pi', 'settings.json'))?.compaction
  if (!project || typeof project !== 'object' || typeof project.enabled !== 'boolean') return user
  return projectTrusted(readJson(join(dir, 'trust.json')), cwd) ? project.enabled : user
}

export function readContextSettings(cwd) {
  const compact = piCompactionEnabled(cwd)
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
    const settings = readContextSettings(ctx?.cwd)
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
