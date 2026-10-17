import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUILD_DIR = '.tmp/v3-ui/ER10-port/build'

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/subagents.ts'],
    outfile: `${BUILD_DIR}/subagents-native-retry.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)

const { SubagentController, sanitizeStderrLine } = await import(`../${BUILD_DIR}/subagents-native-retry.mjs`)

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label}（${detail}）`)
  checks += 1
}

const fakePrepare = async (rootCwd, id, isolation) => ({ isolation, rootCwd, cwd: rootCwd })

function makeRpcFactory() {
  const created = []
  const createRpc = () => {
    const handlers = new Map()
    const rpc = {
      running: false,
      closed: false,
      closeCount: 0,
      commands: [],
      on(event, listener) {
        const list = handlers.get(event) ?? []
        list.push(listener)
        handlers.set(event, list)
        return rpc
      },
      spawn() {
        rpc.running = true
      },
      async command(type) {
        rpc.commands.push(type)
        if (type === 'get_state') return { success: true, data: {} }
        return { success: true }
      },
      async close() {
        rpc.running = false
        rpc.closed = true
        rpc.closeCount += 1
      },
      emit(event, ...payload) {
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

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return predicate()
}

{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-native-retry-'))
  const factory = makeRpcFactory()
  let finished = 0
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc,
    onChange: () => {}, onFinished: () => { finished += 1 }
  })
  try {
    const started = await ctrl.start('原生重试任务', undefined, 'shared-cwd')
    ok(started.ok === true, '假 RPC 启动成功', started.error ?? '')
    const id = started.run.id
    const rpc = factory.created[0]

    rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'connection reset by peer' }))
    rpc.emit('event', { type: 'agent_end', willRetry: true })
    ok(ctrl.get(id).status === 'running', 'agent_end(willRetry:true) 不终结运行', ctrl.get(id).status)
    ok(rpc.closed === false, 'agent_end(willRetry:true) 不 close 子进程')
    ok(rpc.closeCount === 0, 'agent_end(willRetry:true) 未触发任何 close')
    ok(ctrl.get(id).endedAt === undefined, 'agent_end(willRetry:true) 不写结束时间')

    rpc.emit('event', { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'connection reset by peer' })
    const retrying = ctrl.get(id)
    ok(retrying.status === 'running' && rpc.closed === false, 'auto_retry_start 期间仍运行', retrying.status)
    ok(/第 1\/3 次/.test(retrying.latestActivity ?? ''), '按真实 attempt/maxAttempts 显示重试进度', retrying.latestActivity)
    ok(promptCount(rpc) === 1, '宿主没有为重试重发 prompt', String(promptCount(rpc)))

    rpc.emit('event', assistant('恢复后的回答', { stopReason: 'stop' }))
    rpc.emit('event', { type: 'auto_retry_end', success: true })
    ok(ctrl.get(id).error === undefined, '重试成功后暂态模型失败被清掉', ctrl.get(id).error)
    rpc.emit('event', { type: 'agent_settled' })
    ok(await waitFor(() => finished === 1), 'settled 后只通知一次收口', String(finished))
    const done = ctrl.get(id)
    ok(done.status === 'done' && done.endReason === 'completed', 'settled 收成 done/completed', JSON.stringify({ status: done.status, endReason: done.endReason }))
    ok(done.error === undefined, '最终记录不含旧模型错误', done.error)
    ok(done.latestActivity === '已完成', '终态活动为已完成', done.latestActivity)
    ok(rpc.closeCount === 1, '整个回合只 close 一次', String(rpc.closeCount))
    ok(promptCount(rpc) === 1, '成功回合仍只发过一次 prompt', String(promptCount(rpc)))
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-native-retry-'))
  const factory = makeRpcFactory()
  let finished = 0
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc,
    onChange: () => {}, onFinished: () => { finished += 1 }
  })
  try {
    const started = await ctrl.start('重试耗尽任务', undefined, 'shared-cwd')
    const id = started.run.id
    const rpc = factory.created[0]
    rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'provider unavailable' }))
    rpc.emit('event', { type: 'agent_end', willRetry: true })
    rpc.emit('event', { type: 'auto_retry_start', attempt: 'not-a-number', maxAttempts: null })
    ok(ctrl.get(id).latestActivity === '模型请求失败，正在自动重试…', 'attempt 不可靠时只显示状态', ctrl.get(id).latestActivity)
    rpc.emit('event', { type: 'auto_retry_start', attempt: 2, maxAttempts: 2 })
    rpc.emit('event', { type: 'auto_retry_end', success: false, finalError: 'invalid api key' })
    rpc.emit('event', { type: 'agent_settled' })
    ok(await waitFor(() => finished === 1), '失败回合也收口一次', String(finished))
    const failed = ctrl.get(id)
    ok(failed.status === 'error' && failed.endReason === 'model-error', '全失败 settled 仍为 error/model-error', JSON.stringify({ status: failed.status, endReason: failed.endReason }))
    ok(typeof failed.error === 'string' && failed.error.length > 0, '失败保留错误文本', failed.error)
    ok(rpc.closeCount === 1, '失败回合只 close 一次', String(rpc.closeCount))
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-native-retry-'))
  const factory = makeRpcFactory()
  let finished = 0
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc,
    onChange: () => {}, onFinished: () => { finished += 1 }
  })
  try {
    const started = await ctrl.start('取消后迟到事件', undefined, 'shared-cwd')
    const id = started.run.id
    const rpc = factory.created[0]
    await ctrl.stop(id)
    const endedAt = ctrl.get(id).endedAt
    ok(ctrl.get(id).status === 'cancelled', '人工停止是 cancelled', ctrl.get(id).status)
    rpc.emit('event', { type: 'agent_end', willRetry: true })
    rpc.emit('event', { type: 'auto_retry_start', attempt: 1, maxAttempts: 3 })
    rpc.emit('event', { type: 'auto_retry_end', success: true })
    rpc.emit('event', { type: 'agent_settled' })
    const after = ctrl.get(id)
    ok(after.status === 'cancelled' && after.error === undefined, '迟到 retry/settled 不复活 cancelled', JSON.stringify({ status: after.status, error: after.error }))
    ok(after.endedAt === endedAt, '迟到事件不改写结束时间')
    ok(rpc.closeCount === 1, '取消后迟到 settled 不再 close', String(rpc.closeCount))
    ok(await waitFor(() => finished === 1), '取消只收口通知一次', String(finished))
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-native-retry-'))
  const factory = makeRpcFactory()
  let finished = 0
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc,
    onChange: () => {}, onFinished: () => { finished += 1 }
  })
  try {
    const started = await ctrl.start('工具与重复 settled', undefined, 'shared-cwd')
    const id = started.run.id
    const rpc = factory.created[0]
    rpc.emit('event', { type: 'tool_execution_start', toolName: 'read', toolCallId: 'call-1' })
    rpc.emit('event', { type: 'tool_execution_end', toolCallId: 'call-1' })
    ok(ctrl.get(id).toolCalls === 1, '工具调用计一次', String(ctrl.get(id).toolCalls))
    rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'reset' }))
    rpc.emit('event', { type: 'agent_end', willRetry: true })
    rpc.emit('event', { type: 'auto_retry_start', attempt: 1, maxAttempts: 2 })
    ok(ctrl.get(id).toolCalls === 1, '重试不重发/重计已执行工具', String(ctrl.get(id).toolCalls))
    rpc.emit('event', { type: 'auto_retry_end', success: true })
    rpc.emit('event', assistant('完成', { stopReason: 'stop' }))
    rpc.emit('event', { type: 'agent_settled' })
    rpc.emit('event', { type: 'agent_settled' })
    ok(await waitFor(() => finished === 1), '重复 settled 只收口一次', String(finished))
    ok(rpc.closeCount === 1, '重复 settled 只 close 一次', String(rpc.closeCount))
    ok(rpc.commands.filter((c) => c === 'prompt' || c === 'steer').length === 1, '宿主未重发 prompt/steer', rpc.commands.join(','))
    ok(ctrl.get(id).status === 'done', '重复 settled 不改变终态', ctrl.get(id).status)
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

{
  const bearerUpper = sanitizeStderrLine('Authorization: Bearer ZHVtbXktYmVhcmVy')
  const bearerLower = sanitizeStderrLine('Authorization: bearer ZHVtbXktYmVhcmVy')
  const basicLower = sanitizeStderrLine('authorization: basic ZHVtbXk6c2VjcmV0')
  ok(!bearerUpper.includes('ZHVtbXktYmVhcmVy') && bearerUpper.includes('[redacted]'), 'Bearer 大写脱敏', bearerUpper)
  ok(!bearerLower.includes('ZHVtbXktYmVhcmVy') && bearerLower.includes('[redacted]'), 'bearer 小写脱敏', bearerLower)
  ok(!basicLower.includes('ZHVtbXk6c2VjcmV0') && basicLower.includes('[redacted]'), 'basic 小写脱敏', basicLower)

  const unclosedDouble = sanitizeStderrLine('{"api_key":"dummy-local-credential')
  const unclosedSingle = sanitizeStderrLine("{'token': 'dummy-local-credential")
  ok(!unclosedDouble.includes('dummy-local-credential') && unclosedDouble.includes('[redacted]'), '未闭合双引号 JSON credential 脱敏', unclosedDouble)
  ok(!unclosedSingle.includes('dummy-local-credential') && unclosedSingle.includes('[redacted]'), '未闭合单引号 JSON credential 脱敏', unclosedSingle)
  const closed = sanitizeStderrLine('{"token":"dummy-local-credential"}')
  ok(!closed.includes('dummy-local-credential') && closed.includes('[redacted]'), '闭合引号仍整体替换', closed)
}

{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-native-retry-'))
  const factory = makeRpcFactory()
  let finished = 0
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc,
    onChange: () => {}, onFinished: () => { finished += 1 }
  })
  try {
    const started = await ctrl.start('未知结果重试任务', undefined, 'shared-cwd')
    ok(started.ok === true, '假 RPC 启动成功', started.error ?? '')
    const id = started.run.id
    const rpc = factory.created[0]
    rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'connection reset by peer' }))
    rpc.emit('event', { type: 'agent_end', willRetry: true })
    rpc.emit('event', { type: 'auto_retry_start', attempt: 1, maxAttempts: 3 })
    rpc.emit('event', { type: 'auto_retry_end', success: false, finalError: 'still failing' })
    ok(typeof ctrl.get(id).error === 'string' && ctrl.get(id).error.length > 0, '失败先落到 run.error', ctrl.get(id).error)
    rpc.emit('event', { type: 'auto_retry_end', success: undefined })
    ok(ctrl.get(id).error !== undefined, 'success:undefined 不抹掉已有错误', ctrl.get(id).error)
    ok(ctrl.get(id).status === 'running' && rpc.closeCount === 0, 'success:undefined 不收口', ctrl.get(id).status)
    ok(ctrl.get(id).latestActivity === '自动重试结束（结果未知）', '未知结果只记录中性状态', ctrl.get(id).latestActivity)
    rpc.emit('event', { type: 'auto_retry_end', success: null })
    rpc.emit('event', { type: 'auto_retry_end', success: 'yes' })
    ok(ctrl.get(id).error !== undefined, 'success:null / 非布尔字符串都不抹错', ctrl.get(id).error)
    ok(finished === 0, '未知结果不触发收口通知', String(finished))
    rpc.emit('event', { type: 'auto_retry_end', success: true })
    ok(ctrl.get(id).error === undefined, '明确 success:true 才清暂态错', ctrl.get(id).error)
    rpc.emit('event', { type: 'agent_settled' })
    ok(await waitFor(() => finished === 1), '明确成功后 settled 正常收口一次', String(finished))
    const done = ctrl.get(id)
    ok(done.status === 'done' && done.endReason === 'completed', '未知结果之后的明确成功仍收成 done', JSON.stringify({ status: done.status, endReason: done.endReason }))
    ok(rpc.closeCount === 1, '整个回合只 close 一次', String(rpc.closeCount))
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

{
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-native-retry-'))
  const factory = makeRpcFactory()
  let finished = 0
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc,
    onChange: () => {}, onFinished: () => { finished += 1 }
  })
  try {
    const started = await ctrl.start('计数沿用任务', undefined, 'shared-cwd')
    ok(started.ok === true, '假 RPC 启动成功', started.error ?? '')
    const id = started.run.id
    const rpc = factory.created[0]
    rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'reset' }))
    rpc.emit('event', { type: 'agent_end', willRetry: true })
    rpc.emit('event', { type: 'auto_retry_start', attempt: 2, maxAttempts: 5 })
    ok(/第 2\/5 次/.test(ctrl.get(id).latestActivity ?? ''), '有效计数按 N/M 显示', ctrl.get(id).latestActivity)
    rpc.emit('event', { type: 'auto_retry_start' })
    ok(ctrl.get(id).latestActivity === '模型请求失败，正在自动重试…', '缺字段清旧计数不沿用，只显示状态', ctrl.get(id).latestActivity)
    rpc.emit('event', { type: 'auto_retry_start', attempt: '3', maxAttempts: '5' })
    ok(ctrl.get(id).latestActivity === '模型请求失败，正在自动重试…', '字符串数字不 coerce', ctrl.get(id).latestActivity)
    rpc.emit('event', { type: 'auto_retry_start', attempt: 1.5, maxAttempts: 2.9 })
    ok(ctrl.get(id).latestActivity === '模型请求失败，正在自动重试…', '小数不取整沿用', ctrl.get(id).latestActivity)
    rpc.emit('event', { type: 'auto_retry_start', attempt: Number.NaN, maxAttempts: Number.POSITIVE_INFINITY })
    ok(ctrl.get(id).latestActivity === '模型请求失败，正在自动重试…', 'NaN/Infinity 不计数', ctrl.get(id).latestActivity)
    rpc.emit('event', { type: 'auto_retry_start', attempt: 0, maxAttempts: -1 })
    ok(ctrl.get(id).latestActivity === '模型请求失败，正在自动重试…', '非正整数不计数', ctrl.get(id).latestActivity)
    rpc.emit('event', { type: 'auto_retry_start', attempt: 2, maxAttempts: 1 })
    const activity = ctrl.get(id).latestActivity ?? ''
    ok(/第 2 次/.test(activity) && !activity.includes('/1'), 'max<attempt 不展示伪总数', activity)
    rpc.emit('event', { type: 'auto_retry_end', success: false, finalError: 'exhausted' })
    ok(/已观察到第 2 次/.test(ctrl.get(id).latestActivity ?? ''), '失败文案带真实 attempt', ctrl.get(id).latestActivity)
    rpc.emit('event', { type: 'agent_settled' })
    ok(await waitFor(() => finished === 1), '矛盾计数场景仍正常收口', String(finished))
    ok(ctrl.get(id).status === 'error' && ctrl.get(id).endReason === 'model-error', '失败收口不受计数影响', JSON.stringify({ status: ctrl.get(id).status, endReason: ctrl.get(id).endReason }))
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

{
  await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
    build({ entryPoints: ['src/shared/model-errors.ts'], outfile: `${BUILD_DIR}/model-errors-transient.mjs`, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  )
  const { isTransientModelError } = await import(`../${BUILD_DIR}/model-errors-transient.mjs`)
  for (const text of ['Request timed out', 'connect ETIMEDOUT 1.2.3.4:443', '等待响应超时', 'socket hang up', 'WebSocket closed 1012', '502 Bad Gateway', 'fetch failed']) {
    ok(isTransientModelError(text) === true, `暂态错误：${text}`)
  }
  for (const text of ['429 Too Many Requests', 'insufficient balance', '401 Unauthorized', 'prompt is too long', 'Request aborted', 'unable to verify the first certificate', 'model not found', '', undefined]) {
    ok(isTransientModelError(text) === false, `非暂态错误：${String(text)}`)
  }
}

async function withController(task, body) {
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-native-retry-'))
  const factory = makeRpcFactory()
  const state = { finished: 0 }
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive, prepare: fakePrepare, createRpc: factory.createRpc,
    onChange: () => {}, onFinished: () => { state.finished += 1 }
  })
  try {
    const started = await ctrl.start(task, undefined, 'shared-cwd')
    ok(started.ok === true, '假 RPC 启动成功', started.error ?? '')
    await body({ ctrl, id: started.run.id, rpc: factory.created[0], state })
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
}

await withController('超时未重试续跑成功', async ({ ctrl, id, rpc, state }) => {
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'connect ETIMEDOUT 1.2.3.4:443' }))
  rpc.emit('event', { type: 'agent_end', willRetry: false })
  rpc.emit('event', { type: 'agent_settled' })
  ok(await waitFor(() => promptCount(rpc) === 2), 'pi 未重试的超时由宿主在同一会话续跑一次', rpc.commands.join(','))
  const resuming = ctrl.get(id)
  ok(resuming.status === 'running' && resuming.recovery?.resumed === true, '续跑期间仍运行并记录 resumed', JSON.stringify({ status: resuming.status, recovery: resuming.recovery }))
  ok(resuming.error === undefined && rpc.closeCount === 0, '续跑期间不保留旧错误、不关进程', resuming.error)
  rpc.emit('event', assistant('续跑完成', { stopReason: 'stop' }))
  rpc.emit('event', { type: 'agent_settled' })
  ok(await waitFor(() => state.finished === 1), '续跑成功后收口一次', String(state.finished))
  const done = ctrl.get(id)
  ok(done.status === 'done' && done.endReason === 'completed' && done.recovery?.resumed === true, '续跑成功收成 done 并保留续跑记录', JSON.stringify({ status: done.status, recovery: done.recovery }))
})

await withController('续跑后再失败', async ({ ctrl, id, rpc, state }) => {
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'Request timed out' }))
  rpc.emit('event', { type: 'agent_settled' })
  ok(await waitFor(() => promptCount(rpc) === 2), '第一次暂态失败续跑', rpc.commands.join(','))
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'Request timed out' }))
  rpc.emit('event', { type: 'agent_settled' })
  ok(await waitFor(() => state.finished === 1), '第二次失败直接收口', String(state.finished))
  const failed = ctrl.get(id)
  ok(promptCount(rpc) === 2, '同一子代理最多续跑一次', String(promptCount(rpc)))
  ok(failed.status === 'error' && failed.endReason === 'model-error', '续跑后仍失败为 error/model-error', JSON.stringify({ status: failed.status, endReason: failed.endReason }))
  ok(failed.latestActivity === '自动续跑 1 次后仍失败' && /超时/.test(failed.error ?? ''), '终态写明已续跑并保留错误原因', `${failed.latestActivity} | ${failed.error}`)
})

await withController('额度错误不续跑', async ({ ctrl, id, rpc, state }) => {
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: '429 Too Many Requests' }))
  rpc.emit('event', { type: 'agent_settled' })
  ok(await waitFor(() => state.finished === 1), '额度错误直接收口', String(state.finished))
  const failed = ctrl.get(id)
  ok(promptCount(rpc) === 1 && !failed.recovery, '额度错误不续跑也无恢复记录', JSON.stringify(failed.recovery))
  ok(failed.latestActivity === '模型返回错误（未自动重试）', '终态写明未自动重试', failed.latestActivity)
})

await withController('pi 重试耗尽不续跑', async ({ ctrl, id, rpc, state }) => {
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'Request timed out' }))
  rpc.emit('event', { type: 'agent_end', willRetry: true })
  for (const attempt of [1, 2, 3]) rpc.emit('event', { type: 'auto_retry_start', attempt, maxAttempts: 3 })
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'Request timed out' }))
  rpc.emit('event', { type: 'auto_retry_end', success: false, finalError: 'Request timed out' })
  rpc.emit('event', { type: 'agent_settled' })
  ok(await waitFor(() => state.finished === 1), 'pi 重试耗尽后收口', String(state.finished))
  const failed = ctrl.get(id)
  ok(promptCount(rpc) === 1, 'pi 已重试过时宿主不再续跑', String(promptCount(rpc)))
  ok(failed.recovery?.piRetries === 3 && failed.recovery?.piMaxRetries === 3, '记录 pi 重试次数', JSON.stringify(failed.recovery))
  ok(failed.latestActivity === '自动重试 3 次后仍失败', '终态写明重试次数', failed.latestActivity)
})

await withController('续跑中人工停止', async ({ ctrl, id, rpc, state }) => {
  rpc.emit('event', assistant('', { stopReason: 'error', errorMessage: 'socket hang up' }))
  rpc.emit('event', { type: 'agent_settled' })
  ok(await waitFor(() => promptCount(rpc) === 2), '续跑已发出', rpc.commands.join(','))
  await ctrl.stop(id)
  rpc.emit('event', { type: 'agent_settled' })
  const stopped = ctrl.get(id)
  ok(stopped.status === 'cancelled' && stopped.error === undefined, '续跑中停止为 cancelled', JSON.stringify({ status: stopped.status, error: stopped.error }))
  ok(await waitFor(() => state.finished === 1), '停止只收口一次', String(state.finished))
})

console.log(`subagent-native-retry: ${checks} assertions passed（注入假事件流，未启动真实 pi / 未联网）`)
