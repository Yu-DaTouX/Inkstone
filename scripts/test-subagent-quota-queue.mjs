import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUILD_DIR = '.tmp/audit-subagent'

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/subagents.ts'],
    outfile: `${BUILD_DIR}/subagents-quota-queue.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)

const { SubagentController, approvalOriginFor } = await import(`../${BUILD_DIR}/subagents-quota-queue.mjs`)

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label}（${detail}）`)
  checks += 1
}

const fakePrepare = async (rootCwd, id, isolation) => ({ isolation, rootCwd, cwd: rootCwd })
const USAGE_LIMIT = "You've hit your usage limit. Your limit resets at 5pm."

async function waitFor(predicate, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return predicate()
}

function makeBusyRpcFactory() {
  const created = []
  const createRpc = () => {
    const handlers = new Map()
    const rpc = {
      running: false,
      commands: [],
      prompts: [],
      busy: false,
      hooks: [],
      on(event, listener) {
        const list = handlers.get(event) ?? []
        list.push(listener)
        handlers.set(event, list)
        return rpc
      },
      spawn() {
        rpc.running = true
      },
      async command(type, payload) {
        const intercepted = rpc.hooks.map((hook) => hook(type, payload)).find((result) => result !== undefined)
        if (intercepted !== undefined) {
          rpc.commands.push(type)
          if (type === 'prompt') rpc.prompts.push(payload ?? {})
          return intercepted
        }
        rpc.commands.push(type)
        if (type === 'get_state') return { success: true, data: {} }
        if (type !== 'prompt') return { success: true }
        rpc.prompts.push(payload ?? {})
        if (rpc.busy && !payload?.streamingBehavior) {
          return { success: false, error: 'the agent is already streaming; pass streamingBehavior' }
        }
        rpc.busy = true
        return { success: true, data: { disposition: 'queued' } }
      },
      async close() {
        rpc.running = false
      },
      emit(event, ...payload) {
        if (event === 'event' && payload[0]?.type === 'agent_settled') rpc.busy = false
        for (const listener of handlers.get(event) ?? []) listener(...payload)
      }
    }
    created.push(rpc)
    return rpc
  }
  return { created, createRpc }
}

const assistant = (text, extra = {}) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], ...extra } })
const promptCount = (rpc) => rpc.commands.filter((c) => c === 'prompt').length
const blocked = () => ({ windows: [{ id: 'five', label: '5 小时', used: 100, total: 100, resetAt: Date.now() + 200 }], accounts: 1 })
const freed = () => ({ windows: [{ id: 'five', label: '5 小时', used: 3, total: 100 }], accounts: 1 })

async function withQuotaController(body) {
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-quota-queue-'))
  const factory = makeBusyRpcFactory()
  const state = { finished: 0, checks: 0, answers: [blocked, freed] }
  const ctrl = new SubagentController({
    cwd: archive,
    archiveDir: archive,
    prepare: fakePrepare,
    createRpc: factory.createRpc,
    quotaWatch: {
      check: async () => state.answers[Math.min(state.checks++, state.answers.length - 1)](),
      waiting: () => {}
    },
    onChange: () => {},
    onFinished: () => { state.finished += 1 }
  })
  try {
    const started = await ctrl.start('等额度时有追加消息', 'anthropic/claude-test', 'shared-cwd')
    ok(started.ok === true, '假 RPC 启动成功（带模型）', started.error ?? '')
    await body({ ctrl, id: started.run.id, rpc: factory.created[0], state })
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

const hitQuota = (rpc) => {
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: USAGE_LIMIT }))
  rpc.emit('event', { type: 'agent_settled' })
}

await withQuotaController(async ({ ctrl, id, rpc }) => {
  hitQuota(rpc)
  ok(await waitFor(() => ctrl.get(id)?.quotaWait !== undefined), '额度用尽后进入等额度', JSON.stringify(ctrl.get(id)?.quotaWait))
  const before = promptCount(rpc)
  const first = await ctrl.send(id, '补充一', 'steer')
  const second = await ctrl.send(id, '补充二', 'followUp')
  ok(first.ok && first.delivery === 'queued' && second.ok && second.delivery === 'queued', '等额度时追加消息先收下排队', JSON.stringify([first.delivery, second.delivery]))
  ok(promptCount(rpc) === before, '排队时不打断额度等待、不立即发 prompt', String(promptCount(rpc)))
  ok(/额度等待中/.test(ctrl.get(id).latestActivity ?? ''), '进度说明追加信息在排队', ctrl.get(id).latestActivity)
  ok(ctrl.get(id).quotaWait !== undefined, '排队不动额度等待状态', JSON.stringify(ctrl.get(id).quotaWait))

  ok(await waitFor(() => promptCount(rpc) === before + 3), '额度恢复后先续跑再送出排队的追加信息', rpc.commands.join(','))
  ok(!rpc.prompts[before].streamingBehavior && /Auto-continue/.test(rpc.prompts[before].message ?? ''), '续跑提示用英文子代理模板、不当作追加消息', JSON.stringify(rpc.prompts[before]))
  const delivered = rpc.prompts.slice(-2)
  ok(delivered[0].streamingBehavior === 'steer' && /补充一/.test(delivered[0].message ?? ''), '第一条排队消息按 steer 送达（带 streamingBehavior）', JSON.stringify(delivered[0]))
  ok(delivered[1].streamingBehavior === 'followUp' && /补充二/.test(delivered[1].message ?? ''), '第二条排队消息按 followUp 送达（带 streamingBehavior）', JSON.stringify(delivered[1]))
  ok(ctrl.get(id).status === 'running', '恢复并送出排队信息后仍在运行', ctrl.get(id).status)
})

await withQuotaController(async ({ ctrl, id, rpc, state }) => {
  hitQuota(rpc)
  ok(await waitFor(() => ctrl.get(id)?.quotaWait !== undefined), '额度用尽后进入等额度（失败用例）', JSON.stringify(ctrl.get(id)?.quotaWait))
  await ctrl.send(id, '先送到的一条', 'steer')
  await ctrl.send(id, '会送失败的一条', 'steer')
  let steerAttempts = 0
  rpc.hooks.push((type, payload) => {
    if (type !== 'prompt' || payload?.streamingBehavior !== 'steer') return undefined
    steerAttempts += 1
    return steerAttempts === 2 ? { success: false, error: 'streaming channel closed' } : undefined
  })
  ok(await waitFor(() => state.finished === 1), '排队消息送达失败时收口一次', String(state.finished))
  const run = ctrl.get(id)
  ok(run.status === 'error', '排队消息送不出去时如实报失败', JSON.stringify({ status: run.status, error: run.error }))
  ok(steerAttempts === 2 && promptCount(rpc) >= 3, '先成功的一条已送达，失败的一条不再静默重发', rpc.commands.join(','))
  ok(/1 条追加信息没有送出/.test(run.error ?? ''), '未确认送出的追加消息在终态里如实计数', run.error)
})

await withQuotaController(async ({ ctrl, id, rpc, state }) => {
  hitQuota(rpc)
  ok(await waitFor(() => ctrl.get(id)?.quotaWait !== undefined), '额度用尽后进入等额度（续跑失败用例）', JSON.stringify(ctrl.get(id)?.quotaWait))
  await ctrl.send(id, '等恢复后要发的', 'steer')
  rpc.hooks.push((type, payload) =>
    type === 'prompt' && !payload?.streamingBehavior ? { success: false, error: 'resume prompt failed' } : undefined
  )
  rpc.emit('event', assistant('继续做', { stopReason: 'stop' }))
  ok(await waitFor(() => state.finished === 1), '续跑提示发送失败时收口一次', String(state.finished))
  const run = ctrl.get(id)
  ok(run.status === 'error' && /resume prompt failed/.test(run.error ?? ''), '续跑提示失败如实报错', JSON.stringify({ status: run.status, error: run.error }))
  ok(/1 条追加信息没有送出/.test(run.error ?? ''), '续跑失败时排队的追加消息不当作已送出', run.error)
})

{
  const origin = approvalOriginFor({ parentSessionId: 'session-real', parentRunId: 'run-1' }, { parentSessionId: 'pending:run-1', parentRunId: 'run-1' }, 'sub-1')
  ok(origin.sessionId === 'session-real' && origin.runId === 'run-1' && origin.subagentId === 'sub-1', '审批来源按当前 run 的父会话取真实会话身份', JSON.stringify(origin))
  const adopted = approvalOriginFor({ parentSessionId: 'session-after-move', parentRunId: 'run-1' }, { parentSessionId: 'pending:run-1', parentRunId: 'run-1' }, 'sub-2')
  ok(adopted.sessionId === 'session-after-move', '会话被收养后审批来源跟着 run 更新', JSON.stringify(adopted))
  const pending = approvalOriginFor(undefined, { parentSessionId: 'pending:run-2', parentRunId: 'run-2' }, 'sub-3')
  ok(pending.sessionId === undefined && pending.runId === 'run-2', '仍待定会话时不把带冒号的 pending 身份交给审批台账', JSON.stringify(pending))
  const noRun = approvalOriginFor(undefined, { parentSessionId: 'session-x' }, 'sub-4')
  ok(noRun.sessionId === 'session-x' && noRun.runId === undefined, '没有运行身份时退回上下文里的真实会话', JSON.stringify(noRun))
}

console.log(`subagent-quota-queue: ${checks} checks passed`)
