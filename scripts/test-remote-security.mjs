import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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
  const pairDevice = async (name, kind) => {
    const pairing = store.startPairing()
    const result = await store.pair(pairing.code, name, kind)
    assert.ok(result.ok)
    return result
  }
  const phone = await pairDevice('手机甲')
  const phone2 = await pairDevice('手机乙')
  const peer = await pairDevice('另一台砚', 'peer')
  const agent = await pairDevice('礁石', 'agent')

  let gate
  server = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
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
      async command(command) {
        calls.push(['command', command.action])
        return command.action === 'abort' ? { ok: false, status: 409, error: '目录 C:\\work\\private 不可用' } : { ok: true, data: {} }
      }
    }
  })
  const info = await server.start()
  const base = `http://127.0.0.1:${info.port}`
  const auth = (device) => ({ authorization: `Bearer ${device.token}` })
  const call = async (method, path, device, body, headers = {}) => {
    return callOnce(method, path, device, body, headers)
  }
  const callOnce = async (method, path, device, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { connection: 'close', ...(device ? auth(device) : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { }
    return { status: response.status, body: parsed, text }
  }

  const routes = [
    ['GET', '/remote/v1/status'], ['GET', '/remote/v1/sessions'], ['GET', '/remote/v1/search?q=a'],
    ['GET', '/remote/v1/sessions/s/insight'], ['GET', '/remote/v1/sessions/s/branches'], ['GET', '/remote/v1/sessions/s/images/m/0'],
    ['POST', '/remote/v1/sessions/s/delete', { confirm: true }], ['POST', '/remote/v1/sessions/s/compact', {}],
    ['POST', '/remote/v1/sessions/s/branch', { branch: 'main' }], ['POST', '/remote/v1/sessions/s/flags', { pinned: true }],
    ['POST', '/remote/v1/sessions/s/subagents/sub-1/stop', {}], ['POST', '/remote/v1/sessions/s/model', { provider: 'a', modelId: 'b' }]
  ]
  for (const [method, path, body] of routes) {
    assert.equal((await call(method, path, null, body)).status, 401, `匿名 ${method} ${path}`)
    assert.equal((await call(method, path, { token: 'x'.repeat(43) }, body)).status, 401, `伪造令牌 ${method} ${path}`)
    assert.equal((await call(method, path, agent, body)).status, 403, `agent ${method} ${path}`)
    assert.equal((await call(method, path, peer, body)).status, 403, `peer ${method} ${path}`)
  }
  assert.equal(calls.length, 0, '未授权请求没有到达任何处理器')

  assert.equal((await call('POST', '/remote/v1/sessions/s/delete', phone, {})).status, 400, '删除缺少 confirm')
  assert.equal((await call('POST', '/remote/v1/sessions/s/delete', phone, { confirm: 'true' })).status, 400, '删除 confirm 必须是布尔 true')
  assert.equal(calls.length, 0)

  for (const branch of ['', '   ', 'a'.repeat(251)]) {
    assert.equal((await call('POST', '/remote/v1/sessions/s/branch', phone, { branch })).status, 400, `分支名 ${branch.length}`)
  }
  assert.equal((await call('POST', '/remote/v1/sessions/s/branch', phone, { branch: ['main'] })).status, 400)
  assert.equal((await call('POST', '/remote/v1/sessions/s/branch', phone, { branch: 5 })).status, 400)
  assert.equal(calls.length, 0, '非法分支名没有到达处理器')

  for (const run of ['sub-../../x', 'sub-', 'sub-' + 'a'.repeat(121), 'r1', 'sub-a%20b', 'sub-a;b']) {
    assert.equal((await call('POST', `/remote/v1/sessions/s/subagents/${encodeURIComponent(run)}/stop`, phone, {})).status, 400, `子代理 ${run}`)
  }
  assert.equal(calls.length, 0)

  for (const id of ['a%0Ab', '%0D', 'x'.repeat(201)]) {
    for (const suffix of ['insight', 'branches', 'models']) {
      const result = await call('GET', `/remote/v1/sessions/${id}/${suffix}`, phone)
      assert.equal(result.status, 400, `会话 id ${id.slice(0, 10)} ${suffix}`)
    }
  }
  assert.equal(calls.length, 0, '非法会话 id 没有到达处理器')
  const badEscape = await call('GET', '/remote/v1/sessions/%E0%A4%A/insight', phone)
  assert.ok(badEscape.status >= 400 && !/URI|decode|C:\\/.test(badEscape.text), `畸形百分号编码：${badEscape.text}`)

  const huge = await call('GET', '/remote/v1/search?q=' + 'a'.repeat(5000), phone)
  assert.equal(huge.status, 200)
  assert.equal(calls.at(-1)[1].length, 200, '搜索词被截断到 200 字符')

  const big = await call('POST', '/remote/v1/sessions/s/branch', phone, JSON.stringify({ branch: 'x', pad: 'p'.repeat(70_000) }))
  assert.equal(big.status, 413, '分支请求体超过 64KB 被拒绝')
  const bigCompact = await call('POST', '/remote/v1/sessions/s/compact', phone, JSON.stringify({ pad: 'p'.repeat(70_000) }))
  assert.equal(bigCompact.status, 413)
  const bigMessage = await fetch(base + '/remote/v1/sessions/s/messages', { method: 'POST', headers: { ...auth(phone), 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', pad: 'p'.repeat(13 * 1024 * 1024) }) }).then((response) => response.status, () => 'reset')
  assert.ok(bigMessage === 413 || bigMessage === 'reset', '消息体超过 12MB 被拒绝')
  assert.equal((await call('POST', '/remote/v1/sessions/s/messages', phone, '{bad json')).status, 413)
  assert.equal((await call('POST', '/remote/v1/sessions/s/branch', phone, '[]')).status, 413, '数组体被拒绝')

  const leaked = await call('POST', '/remote/v1/sessions/s/branch', phone, { branch: 'boom' }, { 'idempotency-key': 'key-boom-0001' })
  assert.equal(leaked.status, 500)
  assert.ok(!/C:\\|Users|\.git/.test(leaked.text), `500 错误不泄露路径：${leaked.text}`)
  assert.ok(logs.some((line) => line.includes('ENOENT')), '真实原因写进了日志')
  const aborted = await call('POST', '/remote/v1/runs/abort', phone, { runId: 'r1' })
  assert.ok(!/C:\\|private/.test(aborted.text), `错误里的路径被抹掉：${aborted.text}`)

  const first = await call('POST', '/remote/v1/sessions/s/model', phone, { provider: 'p', modelId: 'm1' }, { 'idempotency-key': 'key-model-0001' })
  assert.equal(first.status, 200)
  const swapped = await call('POST', '/remote/v1/sessions/s/model', phone, { provider: 'p', modelId: 'm2' }, { 'idempotency-key': 'key-model-0001' })
  assert.equal(swapped.status, 409, '同一幂等键换了模型不能静默重放旧结果')
  const sameKeyOtherDevice = await call('POST', '/remote/v1/sessions/s/model', phone2, { provider: 'p', modelId: 'm2' }, { 'idempotency-key': 'key-model-0001' })
  assert.equal(sameKeyOtherDevice.status, 200, '幂等键按设备隔离')
  const msgA = await call('POST', '/remote/v1/sessions/s/messages', phone, { text: 'A' }, { 'idempotency-key': 'key-msg-00001' })
  const msgB = await call('POST', '/remote/v1/sessions/s/messages', phone, { text: 'B' }, { 'idempotency-key': 'key-msg-00001' })
  assert.equal(msgA.status, 200)
  assert.equal(msgB.status, 409, '同一幂等键换了消息正文被拒绝')
  const msgAgain = await call('POST', '/remote/v1/sessions/s/messages', phone, { text: 'A' }, { 'idempotency-key': 'key-msg-00001' })
  assert.equal(msgAgain.body.replayed, true)
  assert.equal(calls.filter((entry) => entry[0] === 'command' && entry[1] === 'send').length, 1, '重放不重复发送')

  let release
  gate = new Promise((resolve) => { release = resolve })
  const before = calls.filter((entry) => entry[0] === 'compact').length
  const parallel = Promise.all(Array.from({ length: 5 }, () => call('POST', '/remote/v1/sessions/s/compact', phone, {}, { 'idempotency-key': 'key-compact-01' })))
  await new Promise((resolve) => setTimeout(resolve, 150))
  release()
  const results = await parallel
  assert.ok(results.every((item) => item.status === 200))
  assert.equal(calls.filter((entry) => entry[0] === 'compact').length - before, 1, '并发同键只执行一次')

  assert.equal((await call('POST', '/remote/v1/sessions/s/compact', phone, {}, { 'idempotency-key': 'short' })).status, 400, '幂等键格式')
  assert.equal((await call('POST', '/remote/v1/sessions/s/compact', phone, {}, { 'idempotency-key': 'a b-c-12345' })).status, 400)

  const evil = await fetch(base + '/remote/v1/status', { headers: { ...auth(phone), origin: 'http://evil.example' } })
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
  const revoked = await call('POST', '/remote/v1/devices/self/revoke', phone2, {})
  assert.equal(revoked.status, 200)
  const closed = await Promise.race([
    (async () => { for (;;) { const { done } = await reader.read(); if (done) return true } })().catch(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000))
  ])
  assert.equal(closed, true, '撤销后事件流立即关闭')
  for (const [method, path, body] of routes) {
    assert.equal((await call(method, path, phone2, body)).status, 401, `撤销后 ${method} ${path}`)
  }
  assert.equal((await call('GET', '/remote/v1/status', phone)).status, 200, '撤销一台不影响另一台')
  await store.revoke(phone.device.id)
  assert.equal((await call('GET', '/remote/v1/status', phone)).status, 401, '桌面端撤销后令牌失效')

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
