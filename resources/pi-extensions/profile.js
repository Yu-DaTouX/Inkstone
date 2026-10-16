import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PROFILES = ['auto', 'coding', 'daily']
export const ACTIVITIES = ['answer', 'research', 'compose', 'organize', 'learn']

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

function profileFile() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
  return join(dataDir(), 'agent-profile', `${safe}.json`)
}

function note(hook, payload) {
  const log = process.env.YAN_PROFILE_EXT_LOG
  if (!log) return
  try {
    appendFileSync(
      log,
      JSON.stringify({ at: new Date().toISOString(), hook, sessionId: process.env.YAN_SESSION_ID ?? null, ...payload }) +
        '\n',
      'utf8'
    )
  } catch {
  }
}

function toolName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name
  return ''
}

function readProfileSnapshot() {
  let text
  try {
    text = readFileSync(profileFile(), 'utf8')
  } catch {
    return null
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`档案快照不是合法 JSON：${profileFile()}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error(`档案快照不是对象：${profileFile()}`)
  if (!PROFILES.includes(raw.profile)) throw new Error(`档案 profile 取值非法：${String(raw.profile)}`)
  if (!ACTIVITIES.includes(raw.activity)) throw new Error(`档案 activity 取值非法：${String(raw.activity)}`)
  return raw
}

export default function agentProfileExtension(pi) {
  pi.on('tool_call', (event) => {
    const snapshot = readProfileSnapshot()
    if (Array.isArray(snapshot?.deniedTools) && snapshot.deniedTools.includes(event?.toolName)) {
      return { block: true, reason: '当前活动档案不允许调用这个工具。' }
    }
  })
  pi.on('before_agent_start', (event) => {
    const options = event?.systemPromptOptions
    if (!options || typeof options !== 'object') {
      note('interface-missing', { keys: event && typeof event === 'object' ? Object.keys(event).join(',') : typeof event })
      throw new Error('活动档案扩展：before_agent_start 没有提供 systemPromptOptions，无法注入角色')
    }

    let snapshot
    try {
      snapshot = readProfileSnapshot()
    } catch (err) {
      note('invalid-snapshot', { error: String(err?.message ?? err) })
      throw err
    }
    if (!snapshot) {
      note('no-snapshot', {})
      return
    }

    if (snapshot.roleSection && typeof snapshot.roleSection.content === 'string') {
      const name = String(snapshot.roleSection.name || 'yan_role')
      options.sections = { ...(options.sections ?? {}), [name]: snapshot.roleSection.content }
    }

    const denied = Array.isArray(snapshot.deniedTools) ? snapshot.deniedTools.filter((n) => typeof n === 'string') : []
    if (denied.length > 0) {
      const active = (pi.getActiveTools?.() ?? []).map(toolName).filter(Boolean)
      const allowed = active.filter((name) => !denied.includes(name))
      if (allowed.length !== active.length) options.selectedTools = allowed
      note('tools', { profile: snapshot.profile, activity: snapshot.activity, active, allowed, denied })
    } else {
      note('role', { profile: snapshot.profile, activity: snapshot.activity, injected: !!snapshot.roleSection })
    }
  })
}
