import { runSuite } from './lib/test-suite.mjs'
import { VERSION_HEADERS, callPath, remoteCall } from './lib/remote-call.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  await runRemoteServerTests(ok, await compile('src/main/remote-server.ts'))
})

export async function runRemoteServerTests(ok, { RemoteServer }) {
  const calls = []
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const http = await import('node:http')
  const scratch = await mkdtemp(join(tmpdir(), 'yan-remote-server-test-'))
  const bigFile = join(scratch, 'big.bin')
  let holdSend
  await writeFile(bigFile, Buffer.alloc(8 * 1024 * 1024, 7))
  const server = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-remote-token-1234567890',
    handlers: {
      async snapshot() {
        return { sessions: [{ id: 's-1', title: '测试会话' }], marker: 'snapshot' }
      },
      async history(sessionId, limit) {
        calls.push({ action: 'history', sessionId, limit })
        if (sessionId === 'missing') return { ok: false, status: 404, error: 'not found' }
        return { ok: true, data: { sessionId, limit, messages: [{ role: 'user', text: 'hello' }] } }
      },
      async insight(sessionId) {
        calls.push({ action: 'insight', sessionId })
        return { ok: true, data: { stats: { tokens: 3, cost: 0, toolCalls: 1, messages: 2 }, changes: null } }
      },
      async stopSubagent(sessionId, runId) {
        calls.push({ action: 'stop-subagent', sessionId, runId })
        return { ok: true, data: { id: runId } }
      },
      async sessionFlags(sessionId, flags) { calls.push({ action: 'flags', sessionId, flags }); return { ok: true, data: flags } },
      async deleteSession(sessionId) { calls.push({ action: 'delete', sessionId }); return { ok: true, data: { sessionId } } },
      async compact(sessionId) { calls.push({ action: 'compact', sessionId }); return { ok: true, data: { sessionId } } },
      async branches(sessionId) { calls.push({ action: 'branches', sessionId }); return { ok: true, data: { branches: [{ name: 'main', current: true }] } } },
      async switchBranch(sessionId, branch) { calls.push({ action: 'switch-branch', sessionId, branch }); return { ok: true, data: { branch } } },
      async search(query) { calls.push({ action: 'search', query }); return { ok: true, data: { hits: [{ sessionId: 's-1', snippet: query, matches: 1 }] } } },
      async image() {
        return { path: bigFile, mediaType: 'application/octet-stream', bytes: 8 * 1024 * 1024, filename: 'big.bin' }
      },
      async command(command) {
        calls.push(command)
        if (holdSend && command.action === 'send' && command.text === '丢失发送回执') {
          holdSend.accepted()
          await holdSend.result
        }
        return { ok: true, data: command }
      }
    }
  })

  const info = await server.start()
  const base = `http://127.0.0.1:${info.port}`
  const headers = { authorization: `Bearer ${info.token}`, ...VERSION_HEADERS }

  const json = async (path, init = {}) => {
    const response = await fetch(base + path, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) }
    })
    return { response, body: await response.json() }
  }
  const act = (action, body = {}, extra = {}) => json(callPath(action), { method: 'POST', ...extra, headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) }, body: JSON.stringify(body) })

  const openSlowBody = (url, authHeaders) =>
    new Promise((resolve) => {
      const request = http.request(url, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json', 'content-length': '4000' }
      })
      request.on('error', () => resolve(null))
      request.on('response', (response) => response.resume())
      request.write('{"text":"')
      setTimeout(() => resolve(request), 60)
    })

  try {
    const health = await json('/remote/v1/health')
    ok(health.response.status === 200 && health.body.ok === true, '远程 health 不需要 token')

    const unauthorized = await remoteCall(base, 'status')
    ok(unauthorized.status === 401, '远程状态接口拒绝无 token 请求')
    const oldPhone = await fetch(base + callPath('status'), { method: 'POST', headers: { authorization: headers.authorization } })
    ok(oldPhone.status === 426 && (await oldPhone.json()).code === 'version_mismatch', '不带协议版本的旧客户端收到 426 并提示升级')
    const newerPhone = await fetch(base + callPath('status'), { method: 'POST', headers: { authorization: headers.authorization, 'x-yan-remote-version': '999' } })
    ok(newerPhone.status === 426 && /电脑/.test((await newerPhone.json()).error), '客户端比电脑新时提示更新电脑')

    const infoResponse = await act('info')
    ok(
      infoResponse.response.status === 200 &&
        infoResponse.body.data.apiVersion === headers['x-yan-remote-version'] * 1 &&
        !JSON.stringify(infoResponse.body).includes(info.token),
      '远程 info 返回协议版本但不回显 token'
    )

    const insight = await act('session.insight', { sessionId: 's-1' })
    ok(insight.response.status === 200 && insight.body.data.stats.tokens === 3 && calls.at(-1).action === 'insight', '远程 insight 返回统计与更改')
    const badInsight = await act('session.insight', { sessionId: 'a\nb' })
    ok(badInsight.response.status === 400, '远程 insight 拒绝无效会话 id')

    const stopSub = await act('subagent.stop', { sessionId: 's-1', runId: 'sub-ab12' })
    ok(stopSub.response.status === 200 && calls.at(-1).action === 'stop-subagent' && calls.at(-1).runId === 'sub-ab12', '远程子代理停止路由')
    const badStop = await act('subagent.stop', { sessionId: 's-1', runId: 'not-a-sub' })
    ok(badStop.response.status === 400, '远程子代理停止拒绝无效标识')

    const unknown = await act('session.nope', {})
    ok(unknown.response.status === 404 && unknown.body.code === 'unknown_action', '未知动作返回 404')
    const pin = await act('session.flags', { sessionId: 's-1', pinned: true })
    ok(pin.response.status === 200 && calls.at(-1).flags.pinned === true, '远程置顶')
    ok((await act('session.flags', { sessionId: 's-1' })).response.status === 400, '远程 flags 需要字段')
    const del = await act('session.delete', { sessionId: 's-1', confirm: true })
    ok(del.response.status === 403, '删除只允许配对的手机')
    ok(!calls.some((call) => call.action === 'delete'), '未确认的删除不会到达主进程')
    ok((await act('session.compact', { sessionId: 's-1' })).response.status === 200 && calls.at(-1).action === 'compact', '远程压缩')
    ok((await act('session.branches', { sessionId: 's-1' })).body.data.branches[0].name === 'main', '远程分支列表')
    const sw = await act('session.branch', { sessionId: 's-1', branch: 'feature/x' })
    ok(sw.response.status === 200 && calls.at(-1).branch === 'feature/x', '远程切换分支')
    ok((await act('session.branch', { sessionId: 's-1' })).response.status === 400, '切换分支需要分支名')
    const found = await act('search', { q: '关键词' })
    ok(found.response.status === 200 && found.body.data.hits[0].snippet === '关键词', '远程内容搜索')

    const status = await act('status')
    ok(status.response.status === 200 && status.body.data.marker === 'snapshot', '远程 status 返回主进程快照')

    const sessions = await act('sessions')
    ok(sessions.response.status === 200 && sessions.body.data.sessions[0].id === 's-1', '远程 sessions 返回会话摘要')

    const history = await act('session.history', { sessionId: 's-1', limit: 3 })
    ok(
      history.response.status === 200 &&
        history.body.data.sessionId === 's-1' &&
        calls.at(-1).limit === 3,
      '远程 history 按稳定 sessionId 和有界 limit 读取'
    )

    const selected = await act('session.select', { sessionId: 's-1' })
    ok(selected.response.status === 200 && calls.at(-1).action === 'select', '远程 select 只传递显式会话操作')

    const message = await act('session.send', { sessionId: 's-1', text: '远程消息' })
    ok(
      message.response.status === 200 &&
        calls.at(-1).action === 'send' &&
        calls.at(-1).sessionId === 's-1' &&
        calls.at(-1).text === '远程消息',
      '远程 messages 将稳定 sessionId 与文本一起传递，不要求切换桌面视图'
    )

    {
      let accepted, release
      const admitted = new Promise(resolve => { accepted = resolve })
      holdSend = { accepted, result: new Promise(resolve => { release = resolve }) }
      const controller = new AbortController()
      const send = (signal) => act('session.send', { sessionId: 's-1', text: '丢失发送回执' }, { signal, headers: { 'idempotency-key': 'send-lost-ack-0001' } })
      try {
        const first = send(controller.signal).catch(error => error.name)
        await admitted
        controller.abort()
        ok(await first === 'AbortError', '宿主接到发送后，手机在回执前掉线')
        const retry = send()
        release()
        const result = await retry
        ok(result.response.status === 200 && result.body.data.text === '丢失发送回执' && calls.filter(c => c.action === 'send' && c.text === '丢失发送回执').length === 1, '同幂等键重试返回原结果，宿主只接收一次')
      } finally {
        release()
        holdSend = undefined
      }
    }

    const renamed = await act('session.rename', { sessionId: 's-1', name: '新名称' })
    ok(renamed.response.status === 200 && calls.at(-1).action === 'rename', '远程 rename 走独立操作')

    const created = await act('session.new')
    const newIn = (projectId) => act('session.new', { projectId }, { headers: { 'idempotency-key': 'new-session-retry-0001' } })
    const firstNew = await newIn('project-a')
    const callsAfterFirst = calls.length
    const replayNew = await newIn('project-a')
    ok(firstNew.response.status === 200 && replayNew.response.status === 200 && calls.length === callsAfterFirst && replayNew.body.data.projectId === 'project-a', '同项目用同一幂等键重试，回放原结果不重复新建')
    const otherProject = await newIn('project-b')
    ok(otherProject.response.status === 409 && otherProject.body.code === 'idempotency_key_reused' && calls.length === callsAfterFirst, '同一幂等键换了项目不会拿到另一个项目的新会话')
    ok(created.response.status === 200 && calls.at(-1).action === 'new', '远程 new 创建新会话')

    const noRunId = await act('run.abort', {})
    ok(noRunId.response.status === 400, '远程 abort 缺少目标 runId 时在协议层拒绝')
    const badRunId = await act('run.abort', { runId: 'active' })
    ok(badRunId.response.status === 400, '远程 abort 拒绝不属于 RunnerRegistry 的 runId 形状')
    const aborted = await act('run.abort', { runId: 'r2' })
    ok(
      aborted.response.status === 200 && calls.at(-1).action === 'abort' && calls.at(-1).runId === 'r2',
      '远程 abort 只把指定 runId 交给任务控制器'
    )

    const events = await fetch(base + '/remote/v1/events', { headers })
    const reader = events.body.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    ok(events.status === 200 && first.includes('event: ready'), 'SSE 连接先发送协议 ready 事件')

    server.publish({ ch: 'state', payload: { sessionId: 's-1', isAgentRunning: true } })
    const pushed = new TextDecoder().decode((await reader.read()).value)
    ok(pushed.includes('event: state') && pushed.includes('"sessionId":"s-1"'), 'SSE 转发受限主进程状态事件')

    server.publish({ ch: 'browser-state', payload: { url: 'https://example.invalid' } })
    const pendingRead = reader.read()
    const ignored = await Promise.race([
      pendingRead.then((result) => ({ timedOut: false, result })),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 40))
    ])
    ok(ignored.timedOut === true, 'SSE 不转发桌面专属 browser-state')

    server.publish({ ch: 'turn-settled', payload: { sessionId: 's-1', outcome: 'failed', runtime: 'desktop-only' } })
    const settledFrame = new TextDecoder().decode((await pendingRead).value)
    ok(
      settledFrame.includes('event: turn-settled') && settledFrame.includes('"outcome":"failed"') && settledFrame.includes('"sessionId":"s-1"'),
      'SSE 把回合失败终态推给远程客户端'
    )

    server.publish({ ch: 'agent-error', payload: { message: '服务商拒绝了模型或请求配置', text: '400: invalid_request_error', source: 'stop-reason' } })
    const errorFrame = new TextDecoder().decode((await reader.read()).value)
    ok(
      errorFrame.includes('event: agent-error') && errorFrame.includes('invalid_request_error'),
      'SSE 把模型错误原文推给远程客户端'
    )

    await reader.cancel()

    const slowBody = await openSlowBody(`${base}${callPath('session.send')}`, headers)
    ok(slowBody !== null, '远程服务接受未发完的请求体（慢连接已建立）')

    const download = await new Promise((resolve) => {
      const request = http.get(`${base}/remote/v1/sessions/s-1/images/m-1/0`, { headers }, (response) => resolve({ request, response }))
      request.on('error', () => resolve({ request, response: null }))
    })
    ok(download.response?.statusCode === 200, '远程图片按文件流返回')
    download.response?.pause()
    const stopStarted = Date.now()
    await server.stop()
    ok(Date.now() - stopStarted < 3000, '有未读完的下载流与未发完的请求体时 stop() 三秒内返回')
    download.request.destroy()
    slowBody?.destroy()
  } finally {
    await server.stop()
  }

  const phoneCalls = []
  const kinds = { 'phone-token': 'phone' }
  const phoneServer = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    devices: {
      async authenticate(token) { return kinds[token] ? { id: `dev-${kinds[token]}`, name: kinds[token], kind: kinds[token] } : null },
      async revoke() { return true },
      async renameDevice() { return null }
    },
    handlers: {
      async snapshot() { return { sessions: [] } },
      async history() { return { ok: true, data: { messages: [] } } },
      async deleteSession(sessionId) { phoneCalls.push({ action: 'delete', sessionId }); return { ok: true, data: { sessionId } } },
      async sessionFlags(sessionId, flags) { phoneCalls.push({ action: 'flags', sessionId, flags }); return { ok: true, data: flags } },
      async compact(sessionId) { phoneCalls.push({ action: 'compact', sessionId }); return { ok: true, data: {} } },
      async branches() { return { ok: true, data: { branches: [] } } },
      async switchBranch(sessionId, branch) { phoneCalls.push({ action: 'branch', sessionId, branch }); return { ok: true, data: { branch } } },
      async search(query, limit) { phoneCalls.push({ action: 'search', query, limit }); return { ok: true, data: { hits: [] } } },
      async command() { return { ok: true, data: {} } }
    }
  })
  const phoneInfo = await phoneServer.start()
  try {
    const phone = (action, body) => remoteCall(`http://127.0.0.1:${phoneInfo.port}`, action, body, { token: 'phone-token', key: `k-${Math.random()}` })
    const legacy = (action, body) => remoteCall(`http://127.0.0.1:${phoneInfo.port}`, action, body, { token: phoneInfo.token, key: `k-${Math.random()}` })
    const before = phoneCalls.length
    const unconfirmed = await phone('session.delete', { sessionId: 's-1' })
    ok(unconfirmed.status === 400 && phoneCalls.length === before, '手机删除：缺少 confirm 返回 400，不触达主进程', unconfirmed.status)
    const loose = await phone('session.delete', { sessionId: 's-1', confirm: 'true' })
    ok(loose.status === 400 && phoneCalls.length === before, '手机删除：confirm 必须是布尔 true，字符串不算', loose.status)
    const deleted = await phone('session.delete', { sessionId: 's-1', confirm: true })
    ok(deleted.status === 200 && phoneCalls.at(-1)?.action === 'delete' && phoneCalls.at(-1).sessionId === 's-1', '手机删除：明确确认后到达主进程')
    const legacyDelete = await legacy('session.delete', { sessionId: 's-1', confirm: true })
    ok((legacyDelete.status === 401 || legacyDelete.status === 403) && phoneCalls.filter((call) => call.action === 'delete').length === 1, '未配对的单令牌不能删除会话', legacyDelete.status)
    const badId = await phone('session.delete', { sessionId: 'a\nb', confirm: true })
    ok(badId.status === 400 && phoneCalls.filter((call) => call.action === 'delete').length === 1, '删除拒绝无效会话 id')
    const info = await phone('info')
    ok(info.body.data.device?.id === 'dev-phone', '手机 info 返回自己的设备')

    const emptyFlags = await phone('session.flags', { sessionId: 's-1', pinned: 'yes' })
    ok(emptyFlags.status === 400 && !phoneCalls.some((call) => call.action === 'flags'), 'flags：非布尔值不当作有效字段')
    const archived = await phone('session.flags', { sessionId: 's-1', archived: false, pinned: true })
    ok(archived.status === 200 && JSON.stringify(phoneCalls.at(-1).flags) === JSON.stringify({ pinned: true, archived: false }), 'flags：false 也如实传递')
    const compacted = await phone('session.compact', { sessionId: 's-1' })
    ok(compacted.status === 200 && phoneCalls.at(-1).action === 'compact' && phoneCalls.at(-1).sessionId === 's-1', '手机压缩上下文到达主进程')
    const longBranch = await phone('session.branch', { sessionId: 's-1', branch: 'b'.repeat(251) })
    ok(longBranch.status === 400 && !phoneCalls.some((call) => call.action === 'branch'), '切换分支：分支名过长被拒')
    const emptyBranch = await phone('session.branch', { sessionId: 's-1', branch: '' })
    ok(emptyBranch.status === 400 && !phoneCalls.some((call) => call.action === 'branch'), '切换分支：空分支名被拒')
    const switched = await phone('session.branch', { sessionId: 's-1', branch: 'feature/x' })
    ok(switched.status === 200 && phoneCalls.at(-1).branch === 'feature/x', '切换分支：合法分支名到达主进程')
    await phone('search', { q: '字'.repeat(500) })
    const searched = phoneCalls.filter((call) => call.action === 'search').at(-1)
    ok(searched?.query.length === 200 && searched.limit === 30, '搜索：关键词截到 200 字，结果上限 30', `${searched?.query.length}/${searched?.limit}`)
  } finally {
    await phoneServer.stop()
  }

  const relayServer = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    relayToken: 'test-relay-token-1234567890',
    handlers: {
      async snapshot() {
        return { sessions: [] }
      },
      async history() {
        return { ok: true, data: { messages: [] } }
      },
      async command() {
        return { ok: true, data: {} }
      }
    }
  })
  const relayInfo = await relayServer.start()
  const relayBase = `http://127.0.0.1:${relayInfo.port}`
  try {
    const withoutRelay = await remoteCall(relayBase, 'status', {}, { token: relayInfo.token })
    const wrongRelay = await remoteCall(relayBase, 'status', {}, { token: relayInfo.token, headers: { 'x-yan-relay': 'wrong-token-0000000000' } })
    const withRelay = await remoteCall(relayBase, 'status', {}, { token: relayInfo.token, headers: { 'x-yan-relay': 'test-relay-token-1234567890' } })
    ok(withoutRelay.status === 403, '中继服务拒绝没经过隧道的请求')
    ok(wrongRelay.status === 403, '中继服务拒绝中继令牌不对的请求')
    ok(withRelay.status === 200, '中继服务接受隧道带上的中继令牌')
  } finally {
    await relayServer.stop()
    await rm(scratch, { recursive: true, force: true })
  }
}
