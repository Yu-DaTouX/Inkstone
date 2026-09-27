/*
 * 交接包生成：把宿主的「请写一份交接包」变成一次真实的 completion（S5b-2）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这一层只有十几行
 * ══════════════════════════════════════════════════════════════════
 * 交接包的内容口径（写什么字段、哪些必须非空、来源字段归谁填、提示词怎么写）
 * 全部在宿主的 `shared/handoff.ts` 里 —— 那是 TS，扩展用不了。
 * 这里只做**唯一一件 RPC 做不到的事**：调一次带工具禁用的 completion：
 *
 *   ctx.modelRegistry.complete(model, { systemPrompt, messages }, { maxTokens, signal })
 *
 * 与 `context.js` 的 Deep Pass / 状态生成器同一个通道（它们也是这么调模型的），
 * 而且它**不经过会话循环**，所以不会递归触发 `context` / `before_provider_request`。
 *
 * ── 为什么触发点是 `agent_settled` ──
 *   「这一轮真的结束了」的稳定边界（context.js 的生成器用同一个边界）。
 *   交接包要的是**收尾之后**的历史，在回合中途生成会拿到半截对话。
 *
 * ── 幂等 ──
 *   结果文件里带着请求的 `operationId`：同一个 operationId 只生成一次。
 *   宿主想重做（比如上一次模型吐了坏 JSON）会写**新的** `operationId`，
 *   那时这里才会再跑一次 —— 薄层自己不重试（重试策略归宿主）。
 *
 * 请求/结果都是文件（`YAN_DATA_DIR/handoff-request|result/<runnerId>.json`），
 * 与目标续行同一条思路：两个进程之间只有磁盘，崩溃后两侧都能看出上次做到哪。
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 一次写包的时限：给它足够时间（这是唯一一次额外调用），但不许无限挂着。 */
const PRODUCE_TIMEOUT_MS = 60_000

/*
 * 等请求文件落盘的窗口（2026-09-22）。
 *
 * 为什么必须有：宿主的 arm 链是「收到 state 推送 → load 三份 store → 渲染提示词写文件」，
 * 而 `agent_settled` 是在 pi 进程里**同时**发出的 —— 首次读盘可能还没有请求。
 * 不看窗口就会一眼读完、直接 return：宿主随后把文件写好，而这一轮再也没人处理它，
 * 用户只看到 90 秒后的「交接包生成超时」（真实报障就是这个）。
 *
 * 为什么是 20 秒：宿主最多等 90 秒，生成本身要占 60 秒（`PRODUCE_TIMEOUT_MS`）——
 * 剩下约 30 秒是「宿主什么时候把请求写下来」的预算。自主档特别容易踩到这里：
 * 交接要在「目标在推进 + 不忙」时才 arm，而自主链是连续跑回合的，真正的 arm
 * 往往推到链尾那一轮之后 —— 那一刻的 `agent_settled` 早已过去，等待窗口就是它
 * 唯一的机会。取 20 秒：给宿主的 IO / RPC 往返留足余量，又不至于把
 * 「真的没有请求」拖到 30 秒。
 *
 * 测试通道：`YAN_HANDOFF_SETTLE_TRIES` / `YAN_HANDOFF_SETTLE_MS`（单测不必真等 20 秒）。
 */
function envInt(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback
}

/*
 * 这两个窗口参数**每次 produce 时读**，而不是模块加载时定死。
 *
 * 原因：ESM 模块只加载一次，而环境变量是“谁来用谁设”的。只要有另一个入口
 * 先 import 了这个模块（比如单测里另一组用例要先拿 `planRepairAttempt`），
 * 后设的窗口就再也不会生效 —— 表现为“测试里明明设了 0.8 秒，实际等了默认 20 秒”，
 * 然后卡在超时上，报错却指向一个看上去无关的用例。
 * 让值跟着调用走，这类顺序依赖就不存在了（也就不会因测试排列而易碎）。
 */
const settleTries = () => envInt('YAN_HANDOFF_SETTLE_TRIES', 20)
const settleMs = () => envInt('YAN_HANDOFF_SETTLE_MS', 1_000)

/** 请求文件的寿命，与宿主 `HANDOFF_REQUEST_TTL_MS` 对齐（30 分钟）。 */
const REQUEST_TTL_MS = 30 * 60 * 1_000

function dataDir() {
  return process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
}

/** 与 `goal-resume.js` 的 `safeKey()` 同语义（宿主侧对应 `handoffFileKey`）。 */
function safeKey() {
  const key = process.env.YAN_SESSION_ID?.trim() || 'session'
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'session'
}

function requestFile() {
  return join(dataDir(), 'handoff-request', `${safeKey()}.json`)
}

function resultFile() {
  return join(dataDir(), 'handoff-result', `${safeKey()}.json`)
}

function note(hook, payload) {
  const log = process.env.YAN_HANDOFF_EXT_LOG
  if (!log) return
  try {
    appendFileSync(
      log,
      JSON.stringify({ at: new Date().toISOString(), hook, sessionId: process.env.YAN_SESSION_ID ?? null, ...payload }) +
        '\n',
      'utf8'
    )
  } catch {
    /* 诊断失败不影响生成 */
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

/** `complete()` 的返回形状随 provider 而异，这里只认几种常见的（与 context.js 同口径）。 */
function resultTextOf(result) {
  if (typeof result === 'string') return result
  if (typeof result?.text === 'string') return result.text
  if (Array.isArray(result?.content)) {
    return result.content.filter(block => typeof block === 'string' || block?.type === 'text').map(block => typeof block === 'string' ? block : block.text ?? '').join('\n')
  }
  if (Array.isArray(result?.message?.content)) return resultTextOf({ content: result.message.content })
  if (typeof result?.message?.content === 'string') return result.message.content
  return ''
}

/**
 * 决定**下一跳**用什么预算与提示。
 *
 * 为什么单独一个纯函数：这段判断是本次修复的核心 ——
 * “输出被长度切断”与“格式不对”是两种病，上一版给它们吃同一副药
 *（同一个 maxTokens + 同一句“必须包含全部列表”），于是截断类失败必然复现：
 * 第二次跑到同一个地方再次被切断。
 *
 * 藏在 `produce()` 里就没法单测（那需要 pi 的 modelRegistry / model），
 * 抽出来之后两个分支都能用假输入钉死。
 */
export function planRepairAttempt({ stopReason, maxTokens, escalatedMaxTokens, retryPrompt, retryPromptTruncated }) {
  const truncated = stopReason === 'length'
  const base = Number(maxTokens || 0)
  /* 只有“被切断”且确实给了更大的预算才抬 —— 否则“抬预算”是个假动作 */
  const escalate = truncated && typeof escalatedMaxTokens === 'number' && escalatedMaxTokens > base
  return {
    truncated,
    maxTokens: escalate ? escalatedMaxTokens : maxTokens,
    /* 截断且没给专用提示时退回通用提示 —— 宁可说一句普通的，也不能什么都不说 */
    suffix: '\n' + ((escalate ? retryPromptTruncated : '') || retryPrompt || '')
  }
}

/** Pi 的 provider failure 可能是 completion 结果而不是 throw；两种都要交给宿主记为 failed。 */
function resultErrorOf(result) {
  if (result?.stopReason !== 'error') return null
  return typeof result.errorMessage === 'string' && result.errorMessage.trim()
    ? result.errorMessage
    : 'Provider returned an error stop reason'
}

// This transport gate decides whether to spend the one allowed repair attempt.
// Host validation remains authoritative; no textual or provider errors are silently repaired.
export function usableHandoffText(text) {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
      if (c === '"') quoted = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1))
          return typeof v.goal === 'string' && !!v.goal.trim() && typeof v.deliverable === 'string' && !!v.deliverable.trim()
            && ['constraints','acceptance','done','remaining','nextActions','blockers','files','notes'].every(k => Array.isArray(v[k]) && v[k].every(x => typeof x === 'string'))
            && v.remaining.some(x => x.trim()) && v.nextActions.some(x => x.trim())
        } catch { return false }
      }
    }
  }
  return false
}

export default function handoffs(pi) {
  /* 加载证据：没有这行就说明扩展根本没被加载（而不是「逻辑没触发」） */
  note('loaded', { request: requestFile(), result: resultFile() })

  /** 同一时刻只跑一次生成（agent_settled 可能连着来）。 */
  let running = false

  const readRequest = () => {
    const raw = readJson(requestFile())
    const handoffId = typeof raw?.handoffId === 'string' ? raw.handoffId : ''
    const operationId = typeof raw?.operationId === 'string' ? raw.operationId : ''
    const prompt = typeof raw?.prompt === 'string' ? raw.prompt : ''
    if (!handoffId || !operationId || !prompt) return null
    return {
      handoffId,
      operationId,
      prompt,
      systemPrompt: typeof raw?.systemPrompt === 'string' && raw.systemPrompt ? raw.systemPrompt : undefined,
      maxTokens: Number.isFinite(raw?.maxTokens) ? raw.maxTokens : undefined,
      maxAttempts: raw?.maxAttempts === 2 ? 2 : 1,
      retryPrompt: typeof raw?.retryPrompt === 'string' ? raw.retryPrompt : '',
      /*
       * 截断重试用的两个字段（2026-09-27）。
       * 这里也是**白名单拷贝**：漏一个字段，宿主写了也没人读（本次就踩了）。
       */
      escalatedMaxTokens: Number.isFinite(raw?.escalatedMaxTokens) ? raw.escalatedMaxTokens : undefined,
      retryPromptTruncated: typeof raw?.retryPromptTruncated === 'string' ? raw.retryPromptTruncated : '',
      createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : 0
    }
  }

  const produce = async (ctx) => {
    if (running) {
      note('skipped', { reason: 'busy' })
      return
    }
    /*
     * 从这一刻就独占：等待窗口里也可能有第二个 `agent_settled` 进来，
     * 不能等到真正调模型时才上锁（否则两边会各等一遍、各调一次模型）。
     */
    running = true
    try {
      /* 宿主写请求可能比 `agent_settled` 晚 —— 给它一个窗口，而不是一眼读完就走 */
      let request = readRequest()
      let attempts = 0
      /* 每次调用现取：环境变量改了就该立即生效（见 settleTries 的注释） */
      const tries = settleTries()
      const waitMs = settleMs()
      while (!request && attempts < tries) {
        attempts += 1
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        request = readRequest()
      }
      if (!request) {
        /* 大多数回合确实没有交接请求：只记一行（设了诊断日志才写），不啰嗦 */
        note('check', { hasRequest: false, attempts, settleMs: attempts * waitMs })
        return
      }
      /*
       * `ageMs` = 宿主的请求写下来到 `agent_settled` 之间隔了多久。
       * 这个数就是竞态的宽度：它很大而依然失败，说明窗口还要更宽（或宿主压根没 arm）。
       */
      note('check', {
        hasRequest: true,
        operationId: request.operationId,
        attempts,
        ageMs: request.createdAt ? Date.now() - request.createdAt : null
      })

      /* TTL：上一轮没跑完的遗物不重做（上下文已经往前走了） */
      if (request.createdAt && Date.now() - request.createdAt > REQUEST_TTL_MS) {
        note('skipped', { reason: 'stale', operationId: request.operationId, ageMs: Date.now() - request.createdAt })
        try {
          rmSync(requestFile(), { force: true })
        } catch {
          /* 删不掉也只是下次再看一遍 */
        }
        return
      }

      /* 幂等：同一个 operationId 已经出过结果（宿主还没消费）就不重复调模型 */
      const existing = readJson(resultFile())
      if (existing?.operationId === request.operationId) {
        note('skipped', { reason: 'already-produced', operationId: request.operationId })
        return
      }

      const registry = ctx?.modelRegistry
      const model = ctx?.model
      if (!registry || typeof registry.complete !== 'function' || !model) {
        note('skipped', { reason: 'no-model-registry', operationId: request.operationId })
        return
      }

      const startedAt = Date.now()
      let text = ''
      let error = null
      let stopReason = null
      let generationAttempts = 0
      let truncated = false
      /*
       * 每一跳带着**自己的**预算与附加提示。
       *
       * 上一版每次都用同一个 `request.maxTokens` + 同一个提示，于是当失败原因是
       * “输出被长度切断”时，重试只是把同一个上限再撞一次 —— 现场就是这样：
       * 两次尝试都停在 `stopReason=length`，那一次允许的修复重试被白花掉。
       */
      let tokensForAttempt = request.maxTokens
      let suffix = ''
      const signal = AbortSignal.timeout(PRODUCE_TIMEOUT_MS)
      for (let attempt = 0; attempt < request.maxAttempts; attempt++) {
        // A user stop or new operation revokes both initial and repair calls.
        if (readRequest()?.operationId !== request.operationId || signal.aborted) return
        generationAttempts++
        try {
          const result = await registry.complete(model, {
            ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
            messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt + suffix }] }]
          }, { maxTokens: tokensForAttempt, signal })
          stopReason = typeof result?.stopReason === 'string' ? result.stopReason : null
          error = resultErrorOf(result)
          if (!error) text = resultTextOf(result)
          if (error || usableHandoffText(text)) {
            /* 有结论了：这里不是截断导致的失败 */
            truncated = false
            break
          }
          /*
           * 决定**下一跳**用什么。被长度切断与格式不对是两种病：
           * 前者要抬预算（再试才有意义），后者只换提示。
           * 只有后者那种“原样再问一遍”的无效重试，才是上一版的毛病。
           */
          const cut = stopReason === 'length'
          truncated = cut
          if (cut && request.escalatedMaxTokens > tokensForAttempt) {
            tokensForAttempt = request.escalatedMaxTokens
            suffix = '\n' + (request.retryPromptTruncated || request.retryPrompt || '')
          } else {
            suffix = '\n' + (request.retryPrompt || '')
          }
          note('repair-needed', {
            operationId: request.operationId,
            attempt: generationAttempts,
            chars: text.length,
            stopReason,
            nextMaxTokens: tokensForAttempt
          })
        } catch (err) { error = String(err?.message ?? err); break }
      }
      if (readRequest()?.operationId !== request.operationId) return

      const ms = Date.now() - startedAt
      /*
       * 无论成败都写结果文件：宿主据此判断「跑了但没结果」与「压根没跑」——
       * 只失败不写文件的话，宿主会一直等到超时，把「模型坏了」误判成「扩展没加载」。
       */
      try {
        writeJson(resultFile(), {
          handoffId: request.handoffId,
          operationId: request.operationId,
          text,
          error,
          stopReason,
          attempts: generationAttempts,
          truncated,
          ms,
          at: Date.now()
        })
        note('produced', { operationId: request.operationId, ms, chars: text.length, error, stopReason, attempts: generationAttempts, truncated })
      } catch (err) {
        note('write-failed', { operationId: request.operationId, error: String(err?.message ?? err) })
      }
    } finally {
      running = false
    }
  }

  pi.on('agent_settled', (_event, ctx) => {
    void produce(ctx).catch((err) => note('produce-failed', { error: String(err?.message ?? err) }))
  })
}
