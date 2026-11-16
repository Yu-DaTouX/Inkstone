import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUILD_DIR = '.tmp/subagent-auth-blip/build'
const { build } = await import('../node_modules/esbuild/lib/main.js')
for (const [entry, name] of [['src/main/subagents.ts', 'subagents'], ['src/main/auth-blip.ts', 'auth-blip']]) {
  await build({ entryPoints: [entry], outfile: `${BUILD_DIR}/${name}.mjs`, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
}
const { SubagentController } = await import(`../${BUILD_DIR}/subagents.mjs`)
const blip = await import(`../${BUILD_DIR}/auth-blip.mjs`)

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label}（${detail}）`)
  checks += 1
}

const piDir = process.env.YAN_PI_DIR
await mkdir(piDir, { recursive: true })
await writeFile(join(piDir, 'auth.json'), JSON.stringify({
  anthropic: { type: 'oauth', access: 'dummy-access', refresh: 'dummy-refresh', expires: 0 },
  deepseek: { type: 'api_key', key: 'dummy-key' }
}))

const UNAUTHORIZED = '401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}'
const REFRESH_FAILED = 'OAuth token refresh failed for anthropic: invalid_grant'

ok(blip.AUTH_BLIP_RETRY_MS === 5000, '认证闪断等待 5 秒')
ok(blip.isAuthBlip(UNAUTHORIZED, { retried: false, continued: false }), '401 是认证闪断')
ok(!blip.isAuthBlip(UNAUTHORIZED, { retried: true, continued: false }), 'pi 已重试过不算闪断')
ok(!blip.isAuthBlip(UNAUTHORIZED, { retried: false, continued: true }), '已续跑过一次不再续')
ok(!blip.isAuthBlip('403 Forbidden: insufficient permissions', { retried: false, continued: false }), '403 不算闪断')
for (const text of ['503 credential validation failed', '403 MODEL_NOT_IN_PLAN: model available in Pro and above plans or extra usage', '403 this model is not in your plan']) {
  ok(!blip.isAuthBlip(text, { retried: false, continued: false }), `不是 401 认证闪断，不等待续跑：${text}`)
}
ok(blip.isAuthBlipRecoverable(UNAUTHORIZED) && !blip.isAuthBlipRecoverable(REFRESH_FAILED), '刷新失败不再等待续跑')
ok(blip.providerOfModelLabel('anthropic/claude-x') === 'anthropic' && blip.providerOfModelLabel('openrouter/a/b') === 'openrouter' && blip.providerOfModelLabel('claude-x') === undefined, '从模型标签取服务商')
ok(await blip.providerUsesOAuth('anthropic') && !(await blip.providerUsesOAuth('deepseek')) && !(await blip.providerUsesOAuth('missing')), '只认 OAuth 登录的服务商')

const [agentSource, subagentSource] = await Promise.all([readFile('src/main/agent.ts', 'utf8'), readFile('src/main/subagents.ts', 'utf8')])
for (const [name, source] of [['agent.ts', agentSource], ['subagents.ts', subagentSource]]) {
  ok(/from '\.\/auth-blip'/.test(source) && /isAuthBlip\(/.test(source), `${name} 使用共用判断`)
}
ok(!/isAuthRejected/.test(agentSource) && !/AUTH_BLIP_RETRY_MS\s*=/.test(agentSource), 'agent.ts 不再自带判断与等待常量')

const fakePrepare = async (rootCwd, id, isolation) => ({ isolation, rootCwd, cwd: rootCwd })
const assistant = (text, extra = {}) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], ...extra } })
const promptCount = (rpc) => rpc.commands.filter((c) => c === 'prompt').length
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

function makeRpcFactory() {
  const created = []
  const createRpc = () => {
    const handlers = new Map()
    const rpc = {
      running: false, closed: false, closeCount: 0, commands: [],
      on(event, listener) {
        const list = handlers.get(event) ?? []
        list.push(listener)
        handlers.set(event, list)
        return rpc
      },
      spawn() { rpc.running = true },
      async command(type) {
        rpc.commands.push(type)
        if (type === 'get_state') return { success: true, data: {} }
        return { success: true }
      },
      async close() { rpc.running = false; rpc.closed = true; rpc.closeCount += 1 },
      emit(event, ...payload) { for (const listener of handlers.get(event) ?? []) listener(...payload) }
    }
    created.push(rpc)
    return rpc
  }
  return { created, createRpc }
}

async function withController(model, body, delayMs = 150) {
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-auth-blip-'))
  const factory = makeRpcFactory()
  const state = { finished: 0 }
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc, authBlipDelayMs: delayMs,
    onChange: () => {}, onFinished: () => { state.finished += 1 }
  })
  try {
    const started = await ctrl.start('认证闪断任务', model, 'shared-cwd')
    ok(started.ok === true, '假 RPC 启动成功', started.error ?? '')
    await body({ ctrl, id: started.run.id, rpc: factory.created[0], state })
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

const failWith = (rpc, text) => {
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: text }))
  rpc.emit('event', { type: 'agent_end', willRetry: false })
  rpc.emit('event', { type: 'agent_settled' })
}

await withController('anthropic/claude-test', async ({ ctrl, id, rpc, state }) => {
  failWith(rpc, UNAUTHORIZED)
  await sleep(60)
  ok(promptCount(rpc) === 1 && ctrl.get(id).status === 'running' && state.finished === 0, '等待期间不续跑也不收口', rpc.commands.join(','))
  ok(/5 秒/.test(ctrl.get(id).latestActivity ?? '') && ctrl.get(id).error === undefined, '等待期间显示重试状态并清掉旧错误', ctrl.get(id).latestActivity)
  ok(await waitFor(() => promptCount(rpc) === 2), 'OAuth 401 等待后在同一会话续跑一次', rpc.commands.join(','))
  ok(ctrl.get(id).recovery?.resumed === true, '记录已续跑')
  rpc.emit('event', assistant('续跑完成', { stopReason: 'stop' }))
  rpc.emit('event', { type: 'agent_settled' })
  ok(await waitFor(() => state.finished === 1), '续跑成功后收口', String(state.finished))
  ok(ctrl.get(id).status === 'done' && ctrl.get(id).endReason === 'completed', '续跑成功收成 done', JSON.stringify({ status: ctrl.get(id).status, endReason: ctrl.get(id).endReason }))
})

await withController('anthropic/claude-test', async ({ ctrl, id, rpc, state }) => {
  failWith(rpc, UNAUTHORIZED)
  ok(await waitFor(() => promptCount(rpc) === 2), '第一次 401 续跑', rpc.commands.join(','))
  failWith(rpc, UNAUTHORIZED)
  ok(await waitFor(() => state.finished === 1), '第二次 401 直接收口', String(state.finished))
  const failed = ctrl.get(id)
  ok(promptCount(rpc) === 2, '只续跑 1 次', String(promptCount(rpc)))
  ok(failed.status === 'error' && failed.endReason === 'model-error', '第二次 401 收成 error/model-error', JSON.stringify({ status: failed.status, endReason: failed.endReason }))
  ok(/重新登录/.test(failed.error ?? ''), '错误提示重新登录', failed.error)
})

await withController('anthropic/claude-test', async ({ ctrl, id, rpc, state }) => {
  failWith(rpc, REFRESH_FAILED)
  ok(await waitFor(() => state.finished === 1), '令牌刷新失败直接收口', String(state.finished))
  const failed = ctrl.get(id)
  ok(promptCount(rpc) === 1 && failed.status === 'error' && /重新登录/.test(failed.error ?? ''), '刷新失败不续跑并提示重新登录', failed.error)
})

await withController('deepseek/deepseek-chat', async ({ ctrl, id, rpc, state }) => {
  failWith(rpc, UNAUTHORIZED)
  ok(await waitFor(() => state.finished === 1), 'API Key 服务商的 401 直接收口', String(state.finished))
  ok(promptCount(rpc) === 1 && ctrl.get(id).status === 'error' && !ctrl.get(id).recovery, 'API Key 服务商不续跑', JSON.stringify(ctrl.get(id).recovery))
})

await withController('anthropic/claude-test', async ({ ctrl, id, rpc, state }) => {
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: UNAUTHORIZED }))
  rpc.emit('event', { type: 'agent_end', willRetry: true })
  rpc.emit('event', { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: UNAUTHORIZED })
  rpc.emit('event', { type: 'auto_retry_end', success: false, finalError: UNAUTHORIZED })
  rpc.emit('event', { type: 'agent_settled' })
  ok(await waitFor(() => state.finished === 1), 'pi 已重试过的 401 直接收口', String(state.finished))
  ok(promptCount(rpc) === 1, 'pi 已重试过不再续跑', String(promptCount(rpc)))
})

await withController('anthropic/claude-test', async ({ ctrl, id, rpc, state }) => {
  failWith(rpc, 'Request timed out')
  ok(await waitFor(() => promptCount(rpc) === 2), '暂态错误续跑一次', rpc.commands.join(','))
  failWith(rpc, UNAUTHORIZED)
  ok(await waitFor(() => state.finished === 1), '暂态续跑过后的 401 不再续跑', String(state.finished))
  ok(promptCount(rpc) === 2, '暂态与 401 共用同一次续跑额度', String(promptCount(rpc)))
})

await withController('anthropic/claude-test', async ({ ctrl, id, rpc, state }) => {
  failWith(rpc, UNAUTHORIZED)
  await sleep(40)
  await ctrl.stop(id)
  await sleep(300)
  ok(promptCount(rpc) === 1 && ctrl.get(id).status === 'cancelled', '等待期间人工停止不再续跑', `${rpc.commands.join(',')} ${ctrl.get(id).status}`)
  ok(await waitFor(() => state.finished === 1), '停止只收口一次', String(state.finished))
}, 200)

console.log(`subagent auth blip: ${checks} checks passed`)
