/*
 * 钩子实测用的探针扩展（配合 `scripts/hook-probe.mjs`，不是随包分发的东西）。
 *
 * 除 S1_MODE 指定的那一件事外**不改行为**，这样打出来的时序就是如实的过程。
 *   plain    什么都不做
 *   block    tool_call 对 bash 返回 {block:true}
 *   abort    before_provider_request 第 2 次调 ctx.abort()
 *   compact  tool_call 里调 ctx.compact()
 */
import { appendFileSync } from 'node:fs'

const LOG = process.env.S1_LOG
const MODE = process.env.S1_MODE || 'plain'

export default function hookProbe(pi) {
  const log = (o) => appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + '\n')
  let reqN = 0
  let toolN = 0

  log({ hook: 'loaded', mode: MODE })

  pi.on('input', (event) => log({ hook: 'input', event: event?.type }))

  pi.on('before_agent_start', () =>
    log({
      hook: 'before_agent_start',
      tools: (pi.getActiveTools?.() ?? []).map((t) => t.name ?? t).slice(0, 20)
    })
  )

  pi.on('context', (event) => {
    const msgs = event?.messages ?? []
    log({ hook: 'context', count: msgs.length, roles: msgs.map((m) => m.role ?? m.type) })
    /* 不返回任何东西：不替换上下文 */
  })

  pi.on('before_provider_request', (event, ctx) => {
    reqN += 1
    const payload = event?.payload ?? {}
    log({
      hook: 'before_provider_request',
      n: reqN,
      model: payload.model,
      messageCount: (payload.messages ?? []).length,
      toolNames: (payload.tools ?? []).map((t) => t.function?.name ?? t.name)
    })
    if (MODE === 'payload') {
      /* 追加一条 system 消息：假 provider 那边的 roles 列表是决定性证据 */
      return {
        ...payload,
        messages: [...(payload.messages ?? []), { role: 'system', content: 'S1-INJECTED' }]
      }
    }
    if (MODE === 'abort' && reqN >= 2) {
      log({ hook: 'abort_call', n: reqN })
      try {
        ctx.abort()
        log({ hook: 'abort_returned', n: reqN })
      } catch (err) {
        log({ hook: 'abort_threw', n: reqN, error: String(err?.message ?? err) })
      }
    }
  })

  pi.on('after_provider_response', (event) =>
    log({ hook: 'after_provider_response', status: event?.response?.status })
  )

  pi.on('tool_call', async (event, ctx) => {
    toolN += 1
    log({ hook: 'tool_call', n: toolN, name: event?.toolName, input: event?.input })
    if (MODE === 'compact') {
      try {
        const r = await ctx.compact()
        log({ hook: 'compact_result', n: toolN, raw: JSON.stringify(r ?? null).slice(0, 300) })
      } catch (err) {
        log({ hook: 'compact_threw', n: toolN, error: String(err?.message ?? err) })
      }
    }
    if (MODE === 'block' && event?.toolName === 'bash') {
      log({ hook: 'tool_call_block_return', n: toolN })
      return { block: true, content: [{ type: 'text', text: 'S1-BLOCKED' }], isError: false }
    }
    return undefined
  })

  pi.on('tool_result', (event) =>
    log({
      hook: 'tool_result',
      name: event?.toolName,
      isError: event?.isError === true,
      text: JSON.stringify(event?.content ?? '').slice(0, 220)
    })
  )

  pi.on('session_before_compact', (event) => log({ hook: 'session_before_compact', reason: event?.reason }))

  pi.on('message_end', (event) =>
    log({ hook: 'message_end', role: event?.message?.role, textLen: (event?.message?.content ?? '').length })
  )
}
