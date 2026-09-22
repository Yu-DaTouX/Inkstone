/*
 * 内部续行：计划 → 标准转移之后开工（S3b），以及自主档目标未完成时接着干（S3c）。
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
const RESUME_DELAY_MS = envInt('YAN_GOAL_RESUME_DELAY_MS', 1800)

/*
 * 二次确认之后的「等宿主把 resume 写下来」窗口（2026-09-22）。
 *
 * 真问题：宿主的 arm 链挂在 `state`（`isAgentRunning === false`）上，
 * 而那是 `agent_settled` **之后**的事；这里的触发点却只有 `message_end`（更早）。
 * 宿主要先 resolveWorkMode → load 三份 store → persist → 才写 resume 文件，
 * 1.8 秒那一次读盘常常还是空的。读空就 return 的后果是**死锁**：
 * 不会再有第二个 `message_end`，刚写好的 resume 没人看 ——
 * 用户看到的就是「目标停在 executing、会话不动了，要手动推一下」（真实报障）。
 *
 * 所以读空之后再等一小段、再读：默认 8 × 1.2s ≈ 9.6 秒，
 * 而宿主窗口（换会话 / 关窗口前）远大于它。消费幂等（operationId）保证
 * 多读几次也不会重复续行。
 *
 * 测试通道：`YAN_GOAL_RESUME_POLL_TRIES` / `YAN_GOAL_RESUME_POLL_MS`。
 */
const RESUME_POLL_TRIES = envInt('YAN_GOAL_RESUME_POLL_TRIES', 8)
const RESUME_POLL_MS = envInt('YAN_GOAL_RESUME_POLL_MS', 1_200)

function envInt(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  const kind = rawKind === 'continue' || rawKind === 'retry' || rawKind === 'handoff' ? rawKind : 'ready'
  return { operationId, summary, kind }
}

/** 续行种类 → 会话里的消息标签（界面 / 会话文件据此分辨是哪种续行）。
 *
 * `handoff`（实施-14 F4）是交接的 resume：与目标续行同一套防护、同一个发送方，
 * 但**不是**同一个语义 —— 它带的是交接包，而且必须是 `custom`（不冒充用户消息）。 */
const CUSTOM_TYPES = {
  ready: 'yan-goal-ready',
  continue: 'yan-goal-continue',
  retry: 'yan-auto-continue',
  handoff: 'yan-handoff-resume'
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
  /*
   * `start()` 后紧接着 `switchSession()` 时，扩展最初拿到的 pi/ctx 会被
   * pi 标成 stale；`session_start` 的第二个参数才是这次会话可用的新 ctx。
   * 定时器必须捕获它，否则重载续行会先写消费证据、再在 sendMessage 处
   * 失败，留下「已经消费但没有真正续接」的不可重试窗口。
   */
  /*
   * 发送方的选择（兼顾两种真实情况）
   *
   *   ① **pi 0.85.1 的钩子 ctx 里没有 `sendMessage`** —— `createContext()` 只给
   *      `ui / mode / cwd / sessionManager / modelRegistry / model / isIdle / compact …`。
   *      2026-09-22 的现场：日志里写着 `resume_sent`、`operationId` 也记成已消费，
   *      而消息**从未发出去** —— 因为旧代码是 `context.sendMessage?.()`，可选链把失败吞了。
   *   ② 但**重载 / 切会话后 `pi` 会被 invalidate**（`runtime.invalidate(...)`）——
   *      那时得用 `session_start` 给的新 ctx（`test-handoff-request.mjs` 里有这条护栏）。
   *
   * 于是：以 `pi` 为底，哪个钩子给了带 `sendMessage` 的 ctx 就换成它；
   * 两边都没有就**不写消费证据**（宁可少发一次，也不能留一份假证据）。
   */
  let sender = typeof pi?.sendMessage === 'function' ? pi : null
  let entryWriter = typeof pi?.appendEntry === 'function' ? pi : null
  const rememberSender = (context) => {
    if (typeof context?.sendMessage === 'function') sender = context
    else if (!sender && typeof pi?.sendMessage === 'function') sender = pi
    /* 留痕（appendEntry）同理：ctx 有就用 ctx，否则用 pi —— 重载后连它也不能碰旧的 */
    if (typeof context?.appendEntry === 'function') entryWriter = context
    else if (!entryWriter && typeof pi?.appendEntry === 'function') entryWriter = pi
    return sender
  }

  const schedule = (context) => {
    rememberSender(context)
    const token = ++activity
    const timer = setTimeout(() => {
      void maybeResume(token, context)
    }, RESUME_DELAY_MS)
    /* 不阻止 pi 退出：用户关窗口时不该等这个定时器 */
    timer.unref?.()
  }

  const maybeResume = async (token, context) => {
    /* ③ 用户消息优先：等待期间又有活动 → 这次不发（resume 仍留着） */
    if (token !== activity) {
      note('resume_skipped', { reason: 'activity', token, activity })
      return
    }
    /*
     * 窗口化读盘：宿主的 arm 比 `message_end` 晚，读空不等于「没有续行」。
     *
     * A5（实施-14）：判据不是「读到东西了没有」，而是「读到的东西**还没被消费过**没有」。
     * 以前读到「已消费的那条旧记录」就直接 return —— 而宿主把新指令写进同一个文件
     * 往往就晚几十到几百毫秒（它的 arm 挂在 `state` 推送之后）。那一次 return
     * 会把新 operationId 整个漏掉：不会再有第二个 `message_end`，会话就停在那里。
     * 每一次重试都要重新确认 token —— 窗口里用户说话了就让位。
     */
    let resume = null
    let attempts = 0
    for (;;) {
      const candidate = readResume()
      if (candidate && consumedOperationId() !== candidate.operationId) {
        resume = candidate
        break
      }
      if (attempts >= RESUME_POLL_TRIES) {
        if (candidate) {
          note('resume_skipped', { reason: 'consumed', operationId: candidate.operationId, attempts })
        }
        break
      }
      attempts += 1
      await sleep(RESUME_POLL_MS)
      if (token !== activity) {
        note('resume_skipped', { reason: 'activity', token, activity, attempts })
        return
      }
    }
    note('check', { hasResume: !!resume, operationId: resume?.operationId ?? null, attempts })
    if (!resume) return

    const target = rememberSender(context)
    if (!target) {
      /* 发不出去就别装成“已消费”：否则这份续行再也不会被重试（用户只能手动推） */
      note('resume_failed', { operationId: resume.operationId, kind: resume.kind, reason: 'no-sendMessage' })
      return
    }
    /*
     * 顺序不能反（§4 的「不盲发两次」）：**先留证据，再发消息**。
     * 极端情况下（写完就崩）会少发一次 —— 那是可接受的失败方向：
     * 用户能看到目标停在 executing，重新发一句话就能继续。
     */
    rememberConsumed(resume.operationId)
    /* 发出前记录用的哪个对象：以后再改 API 时一看日志就知道 */
    note('resume_sending', {
      operationId: resume.operationId,
      kind: resume.kind,
      token,
      via: target === pi ? 'pi' : 'ctx'
    })
    try {
      /* 会话里的留痕（自定义条目，不进模型上下文）；`kind` 让排障时能分辨是哪种续行 */
      entryWriter?.appendEntry?.('yan-goal-resume', { operationId: resume.operationId, kind: resume.kind, at: Date.now() })
    } catch (err) {
      note('entry_failed', { error: String(err?.message ?? err) })
    }
    try {
      await target.sendMessage(
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
    /* 回合真的起来了才会有这行 —— 用它区分「续行没发出去」与「发出去了但没起回合」 */
    note('before_agent_start', { activity: activity + 1 })
    activity += 1
  })
  /*
   * A package activation deliberately restarts an idle runner after writing its
   * one-shot continuation. That reload has no preceding `message_end`, so the
   * old hook-only path could leave the durable request unread forever. Startup,
   * session switch and reload all pass through `session_start`; run the same
   * delayed idle check there. Other activity still invalidates the timer.
   */
  pi.on('session_start', (event, context) => {
    note('session_start', { reason: event?.reason ?? null })
    schedule(context)
  })
  pi.on('tool_call', () => {
    activity += 1
  })
  /*
   * `agent_settled`：回合**真的**结束（比 `message_end` 更晚，更接近宿主 arm 完成的一刻）。
   *
   * 2026-09-22 加的：以前只看 `message_end`，而宿主的续行是在那之后的
   * `state` 推送里才写下来的 —— 检查点比目标晚，就会永远错过。
   * 这里**不**累加 activity：它不是用户活动，只是「再看一眼」；
   * `schedule` 的 token 会让更晚的检查点接管前一个定时器。
   */
  pi.on('agent_settled', (_event, context) => {
    note('agent_settled', { hasContext: !!(context && typeof context.sendMessage === 'function') })
    schedule(context)
  })
  pi.on('message_end', (event, context) => {
    note('message_end', { role: event?.message?.role, turnEnd: looksLikeTurnEnd(event) })
    if (!looksLikeTurnEnd(event)) return
    /* 同一条 assistant 消息可能触发多次 message_end（流结束 / 工具后），去重 */
    if (scheduledFor === activity) return
    scheduledFor = activity
    schedule(context)
  })
}
