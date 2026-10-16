import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { applyCodemodePreference } from './codemode-policy.js'

const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'powershell']

const HOST_YAN = '(?:(?:"(?:[A-Za-z]:[\\\\/]|/)[^"]*[\\\\/]yan(?:\\.(?:cmd|exe|mjs))?")|(?:(?:[A-Za-z]:[\\\\/]|/)[^\\s;&|<>`$(){}\\[\\]]*[\\\\/]yan(?:\\.(?:cmd|exe|mjs))?)|yan(?:\\.(?:cmd|exe|mjs))?)'
const QUESTION_COMMAND = new RegExp(`^\\s*${HOST_YAN}\\s+question\\s+ask(?:\\s|$)`)
const SHELL_METACHARS = /[;&|<>`$(){}[\]\n\r]/

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

function workModeFile() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
  return join(dataDir(), 'work-mode', `${safe}.json`)
}

const WORK_MODES = ['standard', 'clarify', 'autonomous']

function normalizeOwnerPath(value) {
  return typeof value === 'string' ? value.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '') : undefined
}

function ownerPathEquals(a, b) {
  const left = normalizeOwnerPath(a)
  const right = normalizeOwnerPath(b)
  if (!left || !right) return false
  return left === right || left.toLowerCase() === right.toLowerCase()
}

function readOwnedSnapshot(ctx) {
  try {
    const record = JSON.parse(readFileSync(workModeFile(), 'utf8'))
    if (!record || typeof record !== 'object') return { snapshot: null }
    const snapId = typeof record.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : undefined
    const snapFile = typeof record.sessionFile === 'string' && record.sessionFile.trim() ? record.sessionFile : undefined
    if (!snapId && !snapFile) return { snapshot: record }
    let manager
    try {
      manager = ctx?.sessionManager
    } catch {
      manager = undefined
    }
    const ctxId = typeof manager?.getSessionId === 'function' ? manager.getSessionId() : undefined
    const ctxFile = typeof manager?.getSessionFile === 'function' ? manager.getSessionFile() : undefined
    if (!ctxId && !ctxFile) return { snapshot: null, mismatch: true }
    if (snapId && ctxId && snapId === ctxId) return { snapshot: record }
    if (snapFile && ownerPathEquals(snapFile, ctxFile)) return { snapshot: record }
    return { snapshot: null, mismatch: true }
  } catch {
    return { snapshot: null }
  }
}

export function currentWorkMode(ctx) {
  const read = readOwnedSnapshot(ctx)
  if (read.snapshot && WORK_MODES.includes(read.snapshot.mode)) {
    return { mode: read.snapshot.mode }
  }
  if (read.mismatch) return { mode: 'standard' }
  try {
    const settings = JSON.parse(readFileSync(join(dataDir(), 'desktop.json'), 'utf8'))
    if (WORK_MODES.includes(settings?.defaultWorkMode)) {
      return { mode: settings.defaultWorkMode }
    }
    return { mode: settings?.autonomous === true ? 'autonomous' : 'standard' }
  } catch {
    return { mode: 'standard' }
  }
}

function note(hook, payload) {
  const log = process.env.YAN_WORK_MODE_EXT_LOG
  if (!log) return
  try {
    appendFileSync(
      log,
      JSON.stringify({
        at: new Date().toISOString(),
        hook,
        sessionId: process.env.YAN_SESSION_ID ?? null,
        ...payload
      }) + '\n',
      'utf8'
    )
  } catch {
  }
}

export function isAllowedBashCommand(command) {
  if (!command) return false
  if (SHELL_METACHARS.test(command)) return false
  return QUESTION_COMMAND.test(command)
}

function toolName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name
  return ''
}

export default function workModePolicy(pi) {
  let baseTools = null
  let restricted = false
  let mode = 'standard'

  const applyTools = (names) => {
    try {
      pi.setActiveTools?.(names)
      return null
    } catch (err) {
      return String(err?.message ?? err)
    }
  }

  pi.on('before_agent_start', (event, ctx) => {
    const policy = currentWorkMode(ctx)
    mode = policy.mode
    if (mode === 'clarify') {
      if (!baseTools) baseTools = (pi.getActiveTools?.() ?? []).map(toolName).filter(Boolean)
      const target = baseTools.filter((name) => READ_ONLY_TOOLS.includes(name))
      const err = applyTools(target)
      restricted = true
      note('before_agent_start', { mode, base: baseTools, applied: target, err })
      return
    }
    if (restricted) {
      const restoredTools = applyCodemodePreference(pi, baseTools ?? [])
      const err = applyTools(restoredTools)
      restricted = false
      note('before_agent_start', { mode, base: baseTools, applied: restoredTools, err, restored: true })
    }
  })

  pi.on('tool_call', (event, ctx) => {
    const policy = currentWorkMode(ctx)
    mode = policy.mode
    const name = String(event?.toolName ?? '')
    if (mode !== 'clarify' || !name) return undefined
    if (name === 'bash' || name === 'powershell') {
      const command = String((event?.input ?? {})?.command ?? '')
      if (isAllowedBashCommand(command)) return undefined
      note('tool_call_blocked', { mode, tool: name, command: command.slice(0, 140) })
      return { block: true }
    }
    if (READ_ONLY_TOOLS.includes(name)) return undefined
    note('tool_call_blocked', { mode, tool: name })
    return { block: true }
  })
}
