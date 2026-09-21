/*
 * 内部续行：澄清 → 标准转移之后开工（S3b），以及自主档目标未完成时接着干（S3c）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么只能由薄层做
 * ══════════════════════════════════════════════════════════════════
 * 续行必须是一条 **`custom` 消息**：它的角色不是 `user`，界面与上下文都能看出
 * 「这是宿主控制消息，不是用户说的话」（§4 明确禁止伪造用户消息）。
 * 而 pi 只有**扩展 API** 能发出这种消息：
 *
 *   pi.sendMessage({ customType, content, display }, { triggerTurn: true })
 *     → 空闲时真的触发一次模型回合（`_runAgentPrompt`），消息角色是 custom
 *
 * RPC 面没有「注入 custom 消息」的命令（详见证据-04-S1 §5）。所以分工是：
 *   · 宿主：写 resume 记录（与转移**同一次落盘**）、用户停止/改档时撤销、
 *     自主档报进展时 arm 下一次续接（S3c）；
 *   · 这个扩展：把「该续行了」变成一次真实回合。
 *
 * 两种来源共用一套防护，只靠记录里的 `kind` 区分正文标签：
 *   · `ready`    → `yan-goal-ready`（就绪转移，S3b）；
 *   · `continue` → `yan-goal-continue`（自主档接着干，S3c）；
 *   · `retry`    → `yan-auto-continue`（模型出错后的自动继续，S5c）。
 *
 * ── 三道防护（§4）──
 *   ① **唯一 operationId**：一次 arm 一个续行；
 *   ② **消费幂等**：发之前先把 operationId 写进 `goal-resume/<runnerId>.consumed.json`；
 *      崩溃重启后据此判断，**不盲发两次**（宁可少发一次，也不能重复执行）；
 *   ③ **用户消息优先**：assistant 消息结束 ≠ 回合立刻空闲（可能还有工具/队列），
 *      所以延迟一次**二次确认**；期间用户又发话或又调了工具，就放弃这次续行，
 *      resume 留着，等下一次真正空闲。
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 二次确认的等待时长：够让「工具还在跑 / 用户接着说话」暴露出来。 */
const RESUME_DELAY_MS = 1800

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

/**
 * 实例文件名（宿主侧对应 `handoffFileKey` / 续行快照的命名）。
 *
 * 导出只为让单测与宿主侧的清洗规则做**交叉校验** —— 两边不一致的后果是
 * 「宿主写了请求、薄层永远看不见」（句法看起来都对，只是文件名不同）。
 */
export function safeKey() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
}

/** 宿主写的每实例快照（与 `work-mode/<runnerId>.json` 同一个约定）。 */
function resumeFile() {
  return join(dataDir(), 'goal-resume', `${safeKey()}.json`)
}

/** 这个扩展自己的消费证据（薄层可写；宿主不参与）。 */
function consumedFile() {
  return join(dataDir(), 'goal-resume', `${safeKey()}.consumed.json`)
}

function note(hook, payload) {
  const log = process.env.YAN_GOAL_RESUME_EXT_LOG
  if (!log) return
  try {
    appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), hook, sessionId: process.env.YAN_SESSION_ID ?? null, ...payload }) + '\n', 'utf8')
  } catch {
    /* 诊断失败不影响续行 */
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 读待发续行；空记录（用户已撤销）返回 null。 */
function readResume() {
  const raw = readJson(resumeFile())
  const operationId = typeof raw?.operationId === 'string' ? raw.operationId : ''
  const summary = typeof raw?.summary === 'string' ? raw.summary.trim() : ''
  if (!operationId || !summary) return null
  /* 旧快照没有 kind：一律当就绪续行（S3b 的行为不能因为 S3c / S5c 而变） */
  const rawKind = raw?.kind
  const kind = rawKind === 'continue' || rawKind === 'retry' ? rawKind : 'ready'
  return { operationId, summary, kind }
}

/** 续行种类 → 会话里的消息标签（界面 / 会话文件据此分辨是哪种续行）。 */
const CUSTOM_TYPES = {
  ready: 'yan-goal-ready',
  continue: 'yan-goal-continue',
  retry: 'yan-auto-continue'
}

function consumedOperationId() {
  const raw = readJson(consumedFile())
  return typeof raw?.operationId === 'string' ? raw.operationId : null
}

function rememberConsumed(operationId) {
  const path = consumedFile()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ operationId, at: new Date().toISOString() }), 'utf8')
}

/** 这条 assistant 消息是不是「回合可能结束」的样子（没有工具调用）。 */
function looksLikeTurnEnd(event) {
  const message = event?.message
  if (!message || message.role !== 'assistant') return false
  const content = message.content
  if (!Array.isArray(content)) return true
  return !content.some((part) => part && (part.type === 'toolCall' || part.type === 'tool_call'))
}

export default function goalResume(pi) {
  /* 加载证据：没有这行就说明扩展根本没被加载（而不是「逻辑没触发」） */
  note('loaded', { resumeFile: resumeFile(), consumedFile: consumedFile() })

  /*
   * 活动计数：`before_agent_start`（用户发话来）、`tool_call`（还在干活）……
   * 二次确认时比一比就知道「这段时间里到底有没有别的事发生」。
   */
  let activity = 0
  let scheduledFor = -1

  const schedule = () => {
    const token = ++activity
    const timer = setTimeout(() => {
      void maybeResume(token)
    }, RESUME_DELAY_MS)
    /* 不阻止 pi 退出：用户关窗口时不该等这个定时器 */
    timer.unref?.()
  }

  const maybeResume = async (token) => {
    /* ③ 用户消息优先：等待期间又有活动 → 这次不发（resume 仍留着） */
    if (token !== activity) {
      note('resume_skipped', { reason: 'activity', token, activity })
      return
    }
    const resume = readResume()
    note('check', { hasResume: !!resume, operationId: resume?.operationId ?? null })
    if (!resume) return
    /* ② 消费幂等：同一个 operationId 只发一次 */
    if (consumedOperationId() === resume.operationId) {
      note('resume_skipped', { reason: 'consumed', operationId: resume.operationId })
      return
    }

    /*
     * 顺序不能反（§4 的「不盲发两次」）：**先留证据，再发消息**。
     * 极端情况下（写完就崩）会少发一次 —— 那是可接受的失败方向：
     * 用户能看到目标停在 executing，重新发一句话就能继续。
     */
    rememberConsumed(resume.operationId)
    try {
      /* 会话里的留痕（自定义条目，不进模型上下文）；`kind` 让排障时能分辨是哪种续行 */
      pi.appendEntry?.('yan-goal-resume', { operationId: resume.operationId, kind: resume.kind, at: Date.now() })
    } catch (err) {
      note('entry_failed', { error: String(err?.message ?? err) })
    }
    try {
      await pi.sendMessage?.(
        {
          customType: CUSTOM_TYPES[resume.kind] ?? 'yan-goal-ready',
          content: [{ type: 'text', text: resume.summary }],
          display: true
        },
        { triggerTurn: true }
      )
      note('resume_sent', { operationId: resume.operationId, kind: resume.kind, token })
    } catch (err) {
      note('resume_failed', { operationId: resume.operationId, kind: resume.kind, error: String(err?.message ?? err) })
    }
  }

  pi.on('before_agent_start', () => {
    activity += 1
  })
  /*
   * A package activation deliberately restarts an idle runner after writing its
   * one-shot continuation. That reload has no preceding `message_end`, so the
   * old hook-only path could leave the durable request unread forever. Startup,
   * session switch and reload all pass through `session_start`; run the same
   * delayed idle check there. Other activity still invalidates the timer.
   */
  pi.on('session_start', (event) => {
    note('session_start', { reason: event?.reason ?? null })
    schedule()
  })
  pi.on('tool_call', () => {
    activity += 1
  })
  pi.on('message_end', (event) => {
    note('message_end', { role: event?.message?.role, turnEnd: looksLikeTurnEnd(event) })
    if (!looksLikeTurnEnd(event)) return
    /* 同一条 assistant 消息可能触发多次 message_end（流结束 / 工具后），去重 */
    if (scheduledFor === activity) return
    scheduledFor = activity
    schedule()
  })
}
