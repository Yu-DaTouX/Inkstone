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
    return result.content.map((block) => (typeof block === 'string' ? block : (block?.text ?? ''))).join('\n')
  }
  if (typeof result?.message?.content === 'string') return result.message.content
  return ''
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
      createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : 0
    }
  }

  const produce = async (ctx) => {
    if (running) {
      note('skipped', { reason: 'busy' })
      return
    }
    const request = readRequest()
    note('check', { hasRequest: !!request, operationId: request?.operationId ?? null })
    if (!request) return

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

    running = true
    const startedAt = Date.now()
    let text = ''
    let error = null
    try {
      const result = await registry.complete(
        model,
        {
          ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
          messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }]
        },
        { maxTokens: request.maxTokens, signal: AbortSignal.timeout(PRODUCE_TIMEOUT_MS) }
      )
      text = resultTextOf(result)
    } catch (err) {
      error = String(err?.message ?? err)
    }
    running = false

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
        ms,
        at: Date.now()
      })
      note('produced', { operationId: request.operationId, ms, chars: text.length, error })
    } catch (err) {
      note('write-failed', { operationId: request.operationId, error: String(err?.message ?? err) })
    }
  }

  pi.on('agent_settled', (_event, ctx) => {
    void produce(ctx).catch((err) => note('produce-failed', { error: String(err?.message ?? err) }))
  })
}
