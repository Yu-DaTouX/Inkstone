import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { VERSION_HEADERS, callPath } from './lib/remote-call.mjs'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-remote-sec-'))
let server
try {
  const bundle = async (entry, name) => {
    const outfile = join(dir, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(outfile).href)
  }
  const { RemoteServer, scrubRemoteError } = await bundle('src/main/remote-server.ts', 'server')
  const { RemoteDeviceStore } = await bundle('src/main/remote-devices.ts', 'devices')

  assert.equal(scrubRemoteError('工作目录不存在或不可访问：C:\\Users\\张 三\\secret proj'), '工作目录不存在或不可访问：…')
  assert.equal(scrubRemoteError('ENOENT open "/home/yu/.pi/agent/x.jsonl"'), 'ENOENT open "…"')
  assert.equal(scrubRemoteError('\\\\nas\\share\\a.txt 失败'), '…')
  assert.equal(scrubRemoteError('找不到这个本地分支'), '找不到这个本地分支')
  assert.equal(scrubRemoteError('分支 feature/x 已存在'), '分支 feature/x 已存在')

  const calls = []
  const logs = []
  const store = new RemoteDeviceStore(dir)
  await store.list()
  const pairDevice = async (name) => {
    const pairing = store.startPairing()
    const result = await store.pair(pairing.code, name)
    assert.ok(result.ok)
    return result
  }
  const phone = await pairDevice('手机甲')
  const phone2 = await pairDevice('手机乙')

  let gate
  const legacy = { token: 'legacy-static-token-0001' }
  server = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    token: legacy.token,
    devices: store,
    onLog: (text) => logs.push(text),
    handlers: {
      async snapshot() { return { sessions: [] } },
      async history(sessionId) { calls.push(['history', sessionId]); return { ok: true, data: {} } },
      async insight(id) { calls.push(['insight', id]); return { ok: true, data: {} } },
      async stopSubagent(id, run) { calls.push(['stop', id, run]); return { ok: true, data: {} } },
      async sessionFlags(id, flags) { calls.push(['flags', id, flags]); return { ok: true, data: {} } },
      async deleteSession(id) { calls.push(['delete', id]); return { ok: true, data: {} } },
      async compact(id) { calls.push(['compact', id]); await gate; return { ok: true, data: {} } },
      async branches(id) { calls.push(['branches', id]); return { ok: true, data: {} } },
      async switchBranch(id, branch) {
        calls.push(['branch', id, branch])
        if (branch === 'boom') throw new Error('ENOENT: no such file C:\\Users\\yu\\repo\\.git\\HEAD')
        return { ok: true, data: {} }
      },
      async search(q) { calls.push(['search', q]); return { ok: true, data: { hits: [] } } },
      models: async () => ({ ok: true, data: {} }),
      async questions() { calls.push(['questions']); return [] },
      async answer(id, answer) { calls.push(['answer', id, answer]); return { ok: true, data: {} } },
      async humanApproval(id, answer) { calls.push(['approval', id, answer]); return { ok: true, data: {} } },
      async transcribe(wav) { calls.push(['transcribe', wav.length]); return { ok: true, data: { text: '' } } },
      async command(command) {
        calls.push(['command', command.action])
        return command.action === 'abort' ? { ok: false, status: 409, error: '目录 C:\\work\\private 不可用' } : { ok: true, data: {} }
      }
    }
  })
  const info = await server.start()
  const base = `http://127.0.0.1:${info.port}`
  const auth = (device) => ({ authorization: `Bearer ${device.token}`, ...VERSION_HEADERS })
  const call = async (method, path, device, body, headers = {}) => {
    return callOnce(method, path, device, body, headers)
  }
  const callOnce = async (method, path, device, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { connection: 'close', ...VERSION_HEADERS, ...(device ? auth(device) : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { }
    return { status: response.status, body: parsed, text }
  }

  const act = (action, device, body = {}, headers = {}) => call('POST', callPath(action), device, body, headers)
  const approvalBody = { sessionId: 's', runId: 'r1', digest: 'a'.repeat(64), confirmed: true }
  const routes = [
    ['POST', callPath('info')], ['POST', callPath('status')], ['POST', callPath('sessions')], ['POST', callPath('search'), { q: 'a' }],
    ['POST', callPath('session.insight'), { sessionId: 's' }], ['POST', callPath('session.branches'), { sessionId: 's' }], ['GET', '/remote/v1/sessions/s/images/m/0'],
    ['GET', '/remote/v1/sessions/s/artifacts/a'], ['GET', '/remote/v1/events'],
    ['POST', callPath('session.delete'), { sessionId: 's', confirm: true }], ['POST', callPath('session.compact'), { sessionId: 's' }],
    ['POST', callPath('session.branch'), { sessionId: 's', branch: 'main' }], ['POST', callPath('session.flags'), { sessionId: 's', pinned: true }],
    ['POST', callPath('subagent.stop'), { sessionId: 's', runId: 'sub-1' }], ['POST', callPath('session.model'), { sessionId: 's', provider: 'a', modelId: 'b' }],
    ['POST', callPath('questions')], ['POST', callPath('question.answer'), { questionId: 'q', answer: { value: 'x' } }],
    ['POST', callPath('question.approval'), { questionId: 'q', ...approvalBody }], ['POST', callPath('voice.transcribe'), { wav: 'AAAA' }],
    ['POST', callPath('device.rename'), { name: '改名' }], ['POST', callPath('device.revoke')]
  ]
  for (const [method, path, body] of routes) {
    assert.equal((await call(method, path, null, body)).status, 401, `匿名 ${method} ${path}`)
    assert.equal((await call(method, path, { token: 'x'.repeat(43) }, body)).status, 401, `伪造令牌 ${method} ${path}`)
  }
  assert.equal(calls.length, 0, '未授权请求没有到达任何处理器')

  for (const [action, body] of [['question.approval', { questionId: 'q', ...approvalBody }], ['voice.transcribe', { wav: 'AAAA' }], ['session.delete', { sessionId: 's', confirm: true }], ['device.rename', { name: '改名' }], ['device.revoke', {}]]) {
    const result = await act(action, legacy, body)
    assert.deepEqual([result.status, result.body?.code], [403, 'paired_user_required'], `未配对的静态令牌 ${action}`)
  }
  assert.equal(calls.length, 0, '静态令牌没有到达人工批准、语音或删除处理器')

  for (const [index, changed] of [{ digest: 'short' }, { digest: 'G'.repeat(64) }, { runId: 'r1;x' }, { runId: 'approval:not-a-uuid' }, { sessionId: 'a\nb' }, { confirmed: 'true' }, { scope: 'session', confirmed: false }, { scope: 'forever' }].entries()) {
    const result = await act('question.approval', phone, { questionId: 'q', ...approvalBody, ...changed }, { 'idempotency-key': `key-approval-bad-${index}` })
    assert.deepEqual([result.status, result.body?.code], [400, undefined], `人工批准校验 ${JSON.stringify(changed)}`)
  }
  assert.equal((await act('question.approval', phone, { questionId: 'q'.repeat(300), ...approvalBody }, { 'idempotency-key': 'key-approval-long-id' })).status, 400, '人工批准问题 id 校验')
  assert.equal(calls.length, 0, '不合格的人工批准没有到达处理器')
  const approved = await act('question.approval', phone, { questionId: 'q', ...approvalBody }, { 'idempotency-key': 'key-approval-ok-01' })
  assert.equal(approved.status, 200, '配对手机可以提交人工批准')
  assert.deepEqual(calls.splice(0), [['approval', 'q', { sessionId: 's', runId: 'r1', digest: approvalBody.digest, confirmed: true }]], '人工批准原样带着会话、运行与摘要交给处理器')

  assert.equal((await act('session.delete', phone, { sessionId: 's' })).status, 400, '删除缺少 confirm')
  assert.equal((await act('session.delete', phone, { sessionId: 's', confirm: 'true' })).status, 400, '删除 confirm 必须是布尔 true')
  assert.equal(calls.length, 0)

  for (const branch of ['', '   ', 'a'.repeat(251)]) {
    assert.equal((await act('session.branch', phone, { sessionId: 's', branch })).status, 400, `分支名 ${branch.length}`)
  }
  assert.equal((await act('session.branch', phone, { sessionId: 's', branch: ['main'] })).status, 400)
  assert.equal((await act('session.branch', phone, { sessionId: 's', branch: 5 })).status, 400)
  assert.equal(calls.length, 0, '非法分支名没有到达处理器')

  for (const run of ['sub-../../x', 'sub-', 'sub-' + 'a'.repeat(121), 'r1', 'sub-a b', 'sub-a;b', 5]) {
    assert.equal((await act('subagent.stop', phone, { sessionId: 's', runId: run })).status, 400, `子代理 ${run}`)
  }
  assert.equal(calls.length, 0)

  for (const id of ['a\nb', '\r', 'x'.repeat(201), '', 5, null]) {
    for (const action of ['session.insight', 'session.branches', 'session.models']) {
      const result = await act(action, phone, { sessionId: id })
      assert.equal(result.status, 400, `会话 id ${String(id).slice(0, 10)} ${action}`)
    }
  }
  assert.equal(calls.length, 0, '非法会话 id 没有到达处理器')
  const badEscape = await call('GET', '/remote/v1/sessions/%E0%A4%A/images/m/0', phone)
  assert.ok(badEscape.status >= 400 && !/URI|decode|C:\\/.test(badEscape.text), `畸形百分号编码：${badEscape.text}`)

  const huge = await act('search', phone, { q: 'a'.repeat(5000) })
  assert.equal(huge.status, 200)
  assert.equal(calls.at(-1)[1].length, 200, '搜索词被截断到 200 字符')

  const big = await act('session.branch', phone, JSON.stringify({ sessionId: 's', branch: 'x', pad: 'p'.repeat(70_000) }))
  assert.equal(big.status, 413, '分支请求体超过 64KB 被拒绝')
  const bigCompact = await act('session.compact', phone, JSON.stringify({ sessionId: 's', pad: 'p'.repeat(70_000) }))
  assert.equal(bigCompact.status, 413)
  const bigMessage = await fetch(base + callPath('session.send'), { method: 'POST', headers: { ...auth(phone), 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's', text: 'hi', pad: 'p'.repeat(13 * 1024 * 1024) }) }).then((response) => response.status, () => 'reset')
  assert.ok(bigMessage === 413 || bigMessage === 'reset', '消息体超过 12MB 被拒绝')
  assert.equal((await act('session.send', phone, '{bad json')).status, 400, '坏 JSON 被拒绝')
  assert.equal((await act('session.branch', phone, '[]')).status, 400, '数组体被拒绝')

  const leaked = await act('session.branch', phone, { sessionId: 's', branch: 'boom' }, { 'idempotency-key': 'key-boom-0001' })
  assert.equal(leaked.status, 500)
  assert.ok(!/C:\\|Users|\.git/.test(leaked.text), `500 错误不泄露路径：${leaked.text}`)
  assert.ok(logs.some((line) => line.includes('ENOENT')), '真实原因写进了日志')
  const aborted = await act('run.abort', phone, { runId: 'r1' })
  assert.ok(!/C:\\|private/.test(aborted.text), `错误里的路径被抹掉：${aborted.text}`)

  const first = await act('session.model', phone, { sessionId: 's', provider: 'p', modelId: 'm1' }, { 'idempotency-key': 'key-model-0001' })
  assert.equal(first.status, 200)
  const swapped = await act('session.model', phone, { sessionId: 's', provider: 'p', modelId: 'm2' }, { 'idempotency-key': 'key-model-0001' })
  assert.equal(swapped.status, 409, '同一幂等键换了模型不能静默重放旧结果')
  const sameKeyOtherDevice = await act('session.model', phone2, { sessionId: 's', provider: 'p', modelId: 'm2' }, { 'idempotency-key': 'key-model-0001' })
  assert.equal(sameKeyOtherDevice.status, 200, '幂等键按设备隔离')
  const msgA = await act('session.send', phone, { sessionId: 's', text: 'A' }, { 'idempotency-key': 'key-msg-00001' })
  const msgB = await act('session.send', phone, { sessionId: 's', text: 'B' }, { 'idempotency-key': 'key-msg-00001' })
  assert.equal(msgA.status, 200)
  assert.equal(msgB.status, 409, '同一幂等键换了消息正文被拒绝')
  const msgAgain = await act('session.send', phone, { sessionId: 's', text: 'A' }, { 'idempotency-key': 'key-msg-00001' })
  assert.equal(msgAgain.body.replayed, true)
  assert.equal(calls.filter((entry) => entry[0] === 'command' && entry[1] === 'send').length, 1, '重放不重复发送')

  let release
  gate = new Promise((resolve) => { release = resolve })
  const before = calls.filter((entry) => entry[0] === 'compact').length
  const parallel = Promise.all(Array.from({ length: 5 }, () => act('session.compact', phone, { sessionId: 's' }, { 'idempotency-key': 'key-compact-01' })))
  await new Promise((resolve) => setTimeout(resolve, 150))
  release()
  const results = await parallel
  assert.ok(results.every((item) => item.status === 200))
  assert.equal(calls.filter((entry) => entry[0] === 'compact').length - before, 1, '并发同键只执行一次')

  assert.equal((await act('session.compact', phone, { sessionId: 's' }, { 'idempotency-key': 'short' })).status, 400, '幂等键格式')
  assert.equal((await act('session.compact', phone, { sessionId: 's' }, { 'idempotency-key': 'a b-c-12345' })).status, 400)

  const evil = await fetch(base + callPath('status'), { method: 'POST', headers: { ...auth(phone), origin: 'http://evil.example' } })
  assert.equal(evil.status, 403, '网页来源被拒绝')

  const flood = []
  for (let i = 0; i < 40; i += 1) flood.push(await fetch(base + '/remote/v1/events', { headers: auth(phone) }))
  assert.ok(flood.every((response) => response.status === 200), '同一设备反复重连不会被拒')
  const other = await fetch(base + '/remote/v1/events', { headers: auth(phone2) })
  assert.equal(other.status, 200, '一台设备的连接风暴不会占满其他设备的事件流名额')
  await other.body.cancel()
  await Promise.all(flood.map((response) => response.body.cancel().catch(() => undefined)))

  const stream = await fetch(base + '/remote/v1/events', { headers: auth(phone2) })
  assert.equal(stream.status, 200)
  const reader = stream.body.getReader()
  await reader.read()
  const revoked = await act('device.revoke', phone2)
  assert.equal(revoked.status, 200)
  const closed = await Promise.race([
    (async () => { for (;;) { const { done } = await reader.read(); if (done) return true } })().catch(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000))
  ])
  assert.equal(closed, true, '撤销后事件流立即关闭')
  for (const [method, path, body] of routes) {
    assert.equal((await call(method, path, phone2, body)).status, 401, `撤销后 ${method} ${path}`)
  }
  assert.equal((await act('status', phone)).status, 200, '撤销一台不影响另一台')
  await store.revoke(phone.device.id)
  assert.equal((await act('status', phone)).status, 401, '桌面端撤销后令牌失效')

  const pairRequest = (code) => callOnce('POST', '/remote/v1/pair', null, { code, deviceName: '暴力枚举' })
  const pairing = store.startPairing()
  const wrong = pairing.code === '000000' ? '111111' : '000000'
  const outcomes = []
  for (let i = 0; i < 10; i += 1) outcomes.push(await pairRequest(wrong))
  assert.deepEqual(outcomes.slice(0, 4).map((r) => [r.status, r.body?.code ?? r.body?.error]), Array(4).fill([403, 'invalid_code']), '前四次输错报 invalid_code')
  assert.deepEqual([outcomes[4].status, outcomes[4].body?.code ?? outcomes[4].body?.error], [403, 'too_many_attempts'], '第五次输错作废配对码')
  assert.ok(outcomes.slice(5).every((r) => r.status === 403 && (r.body?.code ?? r.body?.error) === 'no_pairing'), '作废后继续猜只得到 no_pairing')
  assert.equal(store.currentPairing(), null, '配对码已作废')
  const limited = await pairRequest(wrong)
  assert.equal(limited.status, 429, '同一来源一分钟内超过 10 次配对请求得到 429')
  assert.equal(limited.body?.code ?? limited.body?.error, 'rate_limited', '限流错误码为 rate_limited')

  const fresh = store.startPairing()
  for (let i = 0; i < 3; i += 1) {
    const blocked = await pairRequest(wrong)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body?.code ?? blocked.body?.error, 'rate_limited')
  }
  assert.equal(store.currentPairing()?.code, fresh.code, '被限流的请求不消耗配对码的错误次数，码仍有效')
  const correctAfterLimit = await store.pair(fresh.code, '限流后的正确码')
  assert.ok(correctAfterLimit.ok, '被限流的错误请求不会让随后的正确配对提前作废')

  console.log('remote security attacks ok')
} finally {
  await server?.stop().catch(() => undefined)
  await rm(dir, { recursive: true, force: true })
}
