import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendReminder } from './request-reminder.js'

function envInt(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback
}

const WARN_AT = Math.max(2, envInt('YAN_REPEAT_WARN_AT', 3))
const BLOCK_AT = Math.max(WARN_AT + 1, envInt('YAN_REPEAT_BLOCK_AT', 5))
const COUNTER_TTL_MS = 7 * 24 * 60 * 60 * 1000

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

function safeKey() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
}

function counterFile() {
  return join(dataDir(), 'repeat-guard', `${safeKey()}.json`)
}

function pruneOldCounters() {
  const dir = dirname(counterFile())
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - COUNTER_TTL_MS
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true })
    } catch {
    }
  }
}

function note(hook, payload) {
  const log = process.env.YAN_REPEAT_EXT_LOG
  if (!log) return
  try {
    appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), hook, sessionId: process.env.YAN_SESSION_ID ?? null, ...payload }) + '\n', 'utf8')
  } catch {
  }
}

function readCounter() {
  try {
    const parsed = JSON.parse(readFileSync(counterFile(), 'utf8'))
    const blocks = Number(parsed?.blocks)
    return Number.isFinite(blocks) && blocks > 0 ? Math.floor(blocks) : 0
  } catch {
    return 0
  }
}

function stableJson(value, depth = 0) {
  if (value === null || typeof value !== 'object') {
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  }
  if (depth > 12) return '"[deep]"'
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(',')}}`
}

export function fingerprint(toolName, input) {
  return `${String(toolName ?? '')}\n${stableJson(input ?? {})}`
}

export function isSubagentPollLoop(toolName, input) {
  if (toolName !== 'bash') return false
  const command = String(input?.command ?? '')
  if (!/\byan\s+subagent\s+(?:list|get)\b/.test(command)) return false
  return /\bsleep\s+\d|\bstart-sleep\b|\btimeout\s+\/t\b|\bping\s+-n\s+\d/i.test(command)
}

function remindText(toolName, run) {
  return (
    `Repeat guard: you have called \`${toolName}\` ${run} times in a row with **byte-identical arguments**.\n` +
    'Running the same call again will very likely return the same result. Either\n' +
    '(a) explain what you are still missing and change the arguments, or\n' +
    '(b) if you are stuck because of a blocker, say so and stop.\n' +
    `After ${BLOCK_AT} consecutive identical calls this guard will block the call.`
  )
}

export default function repeatGuard(pi) {
  let lastKey = null
  let run = 0
  let warned = false

  const reset = (reason) => {
    if (run > 0) note('reset', { reason, run })
    lastKey = null
    run = 0
    warned = false
  }

  const writeCounter = (toolName) => {
    const blocks = readCounter() + 1
    const file = counterFile()
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ blocks, tool: toolName, updatedAt: Date.now() }), 'utf8')
    } catch (err) {
      note('counter_failed', { error: String(err?.message ?? err) })
    }
    return blocks
  }

  pi.on('session_start', () => {
    try {
      rmSync(counterFile(), { force: true })
    } catch {
    }
    pruneOldCounters()
  })

  pi.on('tool_call', (event) => {
    const toolName = String(event?.toolName ?? '')
    if (!toolName) return undefined
    if (isSubagentPollLoop(toolName, event?.input)) {
      note('subagent_poll_blocked', {})
      return {
        block: true,
        reason:
          'Do not poll subagents with sleep. The host notifies this session when a subagent finishes, ' +
          'so waiting here only wastes time and lets the prompt cache expire. Either keep working on something ' +
          'that does not depend on it, or end this turn and tell the user the subagent is running and you will be notified.'
      }
    }
    const key = fingerprint(toolName, event?.input)
    if (key === lastKey) {
      run += 1
    } else {
      lastKey = key
      run = 1
      warned = false
    }
    if (run >= BLOCK_AT) {
      const blocks = writeCounter(toolName)
      note('repeat_blocked', { tool: toolName, run, blocks, key: key.slice(0, 200) })
      return {
        block: true,
        reason:
          `Blocked by the repeat guard: \`${toolName}\` was called ${run} times in a row with identical arguments. ` +
          'Do not retry it. Either change the arguments, or report that you are blocked.'
      }
    }
    if (run >= WARN_AT) note('repeat_detected', { tool: toolName, run, warned })
    return undefined
  })

  pi.on('before_provider_request', (event) => {
    if (run < WARN_AT || warned) return undefined
    const toolName = String(lastKey ?? '').split('\n')[0] || 'the same tool'
    const next = appendReminder(event?.payload, `<system-reminder>${remindText(toolName, run)}</system-reminder>`)
    if (!next) return undefined
    warned = true
    note('repeat_warn', { tool: toolName, run })
    return next
  })

  pi.on('message_end', (event) => {
    if (String(event?.message?.role ?? '') === 'user') reset('user')
  })
}
