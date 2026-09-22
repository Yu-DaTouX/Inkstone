/**
 * 单轮重复动作兜底（2026-09-22）—— 薄层侧：判定、提醒、拦下。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须是薄层
 * ══════════════════════════════════════════════════════════════════
 * `tool_call` 钩子是**唯一**能看见「这一次要调什么工具、参数是什么」的地方 ——
 * RPC 面没有「工具即将执行」这个事件。而「拦下」也只有 `{block:true}` 能做
 * （见 `work-mode.js` 的同款用法）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 判据（用户明确要求：**不干扰正常工作**）
 * ══════════════════════════════════════════════════════════════════
 *   · 只认「**同一工具 + 规范化参数逐字相同 + 连续**」：中间夹了任何别的调用
 *     就清零 —— 正常干活会不断换工具 / 换参数，碰不到这条线；
 *   · 连续 3 次 → **只提醒不打断**：在 `before_provider_request` 里贴近用户消息
 *     注入一句（`tool_call` 的返回值只有 `block` 会被 pi 采纳，没有「警告」这个返回值）；
 *   · 连续 5 次 → 拦下该次调用（模型拿到的是 error 结果，通常会换路）；
 *   · 一个「重复串」只提醒一次（不复读）；用户发言 / 目标报进展 → 整串归零。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与宿主的交接（和交接包 / 目标续行同一个形状）
 * ══════════════════════════════════════════════════════════════════
 * 薄层把「被拦下」的累计次数写进 `<YAN_DATA_DIR>/repeat-guard/<key>.json`，
 * 宿主在回合收尾时读它、计入**目标失败签名**（薄层没有 `yan` CLI，也改不了目标存储）。
 * 键的清洗规则与 `goal-resume.js` 的 `safeKey()` 相同（宿主侧 `repeatGuardKey` 交叉校验）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 可调参数（只为测试通道，默认值就是生产值）
 * ══════════════════════════════════════════════════════════════════
 *   · `YAN_REPEAT_WARN_AT`  → 默认 3
 *   · `YAN_REPEAT_BLOCK_AT` → 默认 5（**必须大于 `WARN_AT`**，否则提醒永远没机会发）
 *   · `YAN_REPEAT_EXT_LOG`  → 诊断日志文件（不设则静默）
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function envInt(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback
}

const WARN_AT = Math.max(2, envInt('YAN_REPEAT_WARN_AT', 3))
const BLOCK_AT = Math.max(WARN_AT + 1, envInt('YAN_REPEAT_BLOCK_AT', 5))

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

/**
 * 实例键（与 `goal-resume.js` 的 `safeKey()` 同语义）。
 *
 * 导出只为让宿主侧的清洗规则能与之做交叉校验 —— 两边不一致的后果是
 * 「薄层一直在拦、宿主永远不知道」，而两边单独看都「没报错」。
 */
export function safeKey() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
}

/** 宿主读的计数文件（薄层写、宿主只读）。 */
function counterFile() {
  return join(dataDir(), 'repeat-guard', `${safeKey()}.json`)
}

function note(hook, payload) {
  const log = process.env.YAN_REPEAT_EXT_LOG
  if (!log) return
  try {
    appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), hook, sessionId: process.env.YAN_SESSION_ID ?? null, ...payload }) + '\n', 'utf8')
  } catch {
    /* 诊断失败不影响兜底 */
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

/**
 * 稳定序列化：对象键排序、循环引用不炸、不可序列化的值退化说明文本。
 *
 * 为什么不用 `JSON.stringify(input)` 直接当指纹：工具参数是模型给的 JSON，
 * 键序会随生成漂移（`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 是同一个调用）。
 * 只有键序也归一，才谈得上「逐字相同」（用户口径）。
 */
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

/** 一次调用的指纹：工具名 + 规范化参数。 */
export function fingerprint(toolName, input) {
  return `${String(toolName ?? '')}\n${stableJson(input ?? {})}`
}

/** 提醒文案（英文：与 pi 自己的工具错误文案同一语言，不受界面语言影响）。 */
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
  /** 当前重复串的指纹；`null` = 还没有调用。 */
  let lastKey = null
  /** 连续相同次数。 */
  let run = 0
  /** 这一串是否已经提醒过（只提醒一次，不做复读机）。 */
  let warned = false

  const reset = (reason) => {
    if (run > 0) note('reset', { reason, run })
    lastKey = null
    run = 0
    warned = false
  }

  /**
   * 「报进展」的形状：`yan goal report`（模型换了做法或完成了某一步）。
   *
   * 只认命令形状、不看输出：输出文案会随宿主版本变化，而命令是我们自己定的。
   */
  const isGoalReportCall = (toolName, input) =>
    toolName === 'bash' && String(input?.command ?? '').includes('yan goal report')

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

  pi.on('tool_call', (event) => {
    const toolName = String(event?.toolName ?? '')
    if (!toolName) return undefined
    /* 报进展 = 换了做法：整串归零（这次调用本身也不进重复计数） */
    if (isGoalReportCall(toolName, event?.input)) {
      reset('goal-report')
      return undefined
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

  /*
   * 提醒只能走这里：`tool_call` 的返回值 pi **只采纳 `block`**
   * （见 `beforeToolCall` 的实现：`if (beforeResult?.block) {...}`），
   * 没有「只警告」这个返回值。所以第 3 次之后，在**下一次模型请求前**
   * 贴近最后一条 user 消息插一句 —— 不打断当前回合，但模型下一次决策能看到。
   */
  pi.on('before_provider_request', (event) => {
    if (run < WARN_AT || warned) return undefined
    const payload = event?.payload
    const messages = payload?.messages
    if (!payload || !Array.isArray(messages) || messages.length === 0) return undefined
    let at = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        at = i
        break
      }
    }
    /* 没有用户消息就不插（位置不确定的注入比不提醒更危险，与 `language.js` 同一取舍） */
    if (at < 0) return undefined
    warned = true
    const toolName = String(lastKey ?? '').split('\n')[0] || 'the same tool'
    note('repeat_warn', { tool: toolName, run })
    const text = remindText(toolName, run)
    /*
     * 角色跟着该 provider 已经在用的写法（与 `language.js` 同一处理）：
     * pi 会把 system 映射成 developer，照抄第一个系统角色最安全。
     */
    const already = messages.find((m) => m?.role === 'system' || m?.role === 'developer')?.role
    const role = already === 'system' || already === 'developer' ? already : 'system'
    const next = [...messages.slice(0, at), { role, content: text }, ...messages.slice(at)]
    return { ...payload, messages: next }
  })

  /* 用户发言 = 换了意图：整串归零（`reset` 只在真有串时才写日志） */
  pi.on('message_end', (event) => {
    if (String(event?.message?.role ?? '') === 'user') reset('user')
  })
}
