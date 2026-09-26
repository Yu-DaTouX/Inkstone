/*
 * 活动档案的**薄层执行**（实施-25 P01）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这件事在薄层里
 * ══════════════════════════════════════════════════════════════════
 * 系统提示是 pi 在进程内拼的，RPC 面没有任何「改提示 / 改角色」的命令。
 * 唯一能做这件事的是扩展事件 `before_agent_start` —— 所以这一段按
 * 实施-01 的边界划分（「宿主无法用 CLI / RPC 表达」）留在薄层。
 *
 * 但它**只做注入**，不做业务：
 *   · 角色文本与「本活动禁用哪些工具」都由宿主渲染好写进快照
 *     （`YAN_DIR/agent-profile/<YAN_SESSION_ID>.json`，与 work-mode 同一个
 *     交接方式），这里不抄一份文案，也就不会与 `shared/agent-profile.ts` 漂移；
 *   · 档案读取失败一律走**显式**路径：接口不符预期就报错，绝不静默退回
 *     coding 的角色（那是「profile 静默失效」，实施-25 不变量 6 禁止）。
 *
 * ── 本轮上下文（实施-25 P05）走另一条口径 ──
 * 它由宿主的 `ContextAssembler` 写进 `YAN_DIR/agent-context/<YAN_SESSION_ID>.json`，
 * 读不到或形状不对时**静默不注入**。理由：上下文是增强（少带几段来源不该
 * 让一整轮回答失败），而档案决定角色（静默失效会让日常退回代码助手）。
 *
 * ── 与 work-mode.js 的工具策略怎么共存（T01-3 的「求交集」）──
 * work-mode.js 用 `setActiveTools` 收紧（计划档只留只读集 + 受限 bash）。
 * 这里**不**碰 `setActiveTools`，而是按 `pi.getActiveTools()` 的当前值过滤后
 * 写 `systemPromptOptions.selectedTools`：
 *   · 计划档先跑 → 当前激活集已是只读集 → 过滤后再收窄，交集成立；
 *   · 本扩展先跑 → 计划档随后用 `setActiveTools` 再收紧 → 仍是交集。
 * 两边各自收紧、互不恢复对方，所以顺序不影响「更严的那个生效」。
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROFILES = ['coding', 'daily']
const ACTIVITIES = ['answer', 'research', 'compose', 'organize', 'learn']

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

/** 宿主写给这个运行实例的档案快照。 */
function profileFile() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
  return join(dataDir(), 'agent-profile', `${safe}.json`)
}

/** 宿主写给这个运行实例的上下文分区快照（实施-25 P05 / T05-3）。 */
function contextFile() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  const safe = key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
  return join(dataDir(), 'agent-context', `${safe}.json`)
}

/**
 * 诊断（只在 `YAN_PROFILE_EXT_LOG` 存在时写）。
 *
 * 「角色到底注入了没有」在界面上看不出来 —— 模型答得不一样，可能是角色生效，
 * 也可能是它本来就这么答。落一行「读到什么档案 / 注入了什么 / 工具集变成了
 * 什么」才能把两种情形分开（与 work-mode.js / language.js 同一做法）。
 */
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
    /* 诊断失败不影响注入 */
  }
}

/** 工具名归一：pi 的 `getActiveTools()` 返回字符串数组，这里兼容对象形态。 */
function toolName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name
  return ''
}

/**
 * 读档案快照。
 *
 * 返回 `null` = 没有档案（旧会话 / 刚启动）→ **不注入**，保持 pi 原生行为。
 * 抛错 = 文件在但内容不合法 → 调用方显式报错（不假装是 coding）。
 */
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

/**
 * 读本轮上下文分区。
 *
 * 与档案不同：读不到 / 坏 JSON 一律回 `null`（不注入、不报错）。
 * 分区文本由宿主渲染好，这里不拼内容。
 */
function readContextSection() {
  let text
  try {
    text = readFileSync(contextFile(), 'utf8')
  } catch {
    return null
  }
  try {
    const raw = JSON.parse(text)
    return typeof raw?.section === 'string' && raw.section.trim() ? raw.section : null
  } catch {
    note('invalid-context', {})
    return null
  }
}

export default function agentProfileExtension(pi) {
  pi.on('before_agent_start', (event) => {
    const options = event?.systemPromptOptions
    /*
     * 结构化接口不符预期 → 显式报错。
     *
     * pi 改了 `before_agent_start` 的签名时，静默 return 会让日常会话悄悄
     * 退回代码助手的角色 —— 用户只会觉得「日常模式和以前一样没用」。
     */
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

    /*
     * 本轮上下文（T05-3）与角色分区一起注入，但失败口径不同：
     * 上下文读不到就只是「这轮少带点内容」，不抛错。
     */
    const context = readContextSection()
    if (context) {
      options.sections = { ...(options.sections ?? {}), yan_context: context }
      note('context', { chars: context.length })
    }
  })
}
