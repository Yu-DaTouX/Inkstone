export async function runRemoteServerTests(ok, { RemoteServer }) {
  const calls = []
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const http = await import('node:http')
  const scratch = await mkdtemp(join(tmpdir(), 'yan-remote-server-test-'))
  const bigFile = join(scratch, 'big.bin')
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
        return { ok: true, data: command }
      }
    }
  })

  const info = await server.start()
  const base = `http://127.0.0.1:${info.port}`
  const headers = { authorization: `Bearer ${info.token}` }

  const json = async (path, init = {}) => {
    const response = await fetch(base + path, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) }
    })
    return { response, body: await response.json() }
  }

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

    const unauthorized = await fetch(base + '/remote/v1/status')
    ok(unauthorized.status === 401, '远程状态接口拒绝无 token 请求')

    const infoResponse = await json('/remote/v1/info')
    ok(
      infoResponse.response.status === 200 &&
        infoResponse.body.data === undefined &&
        infoResponse.body.capabilities.includes('send'),
      '远程 info 返回协议能力但不回显 token'
    )

    ok(infoResponse.body.capabilities.includes('insight'), '远程 info 声明 insight 能力')
    const insight = await json('/remote/v1/sessions/s-1/insight')
    ok(insight.response.status === 200 && insight.body.data.stats.tokens === 3 && calls.at(-1).action === 'insight', '远程 insight 返回统计与更改')
    const badInsight = await json('/remote/v1/sessions/a%0Ab/insight')
    ok(badInsight.response.status === 400, '远程 insight 拒绝无效会话 id')

    const stopSub = await json('/remote/v1/sessions/s-1/subagents/sub-ab12/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ok(stopSub.response.status === 200 && calls.at(-1).action === 'stop-subagent' && calls.at(-1).runId === 'sub-ab12', '远程子代理停止路由')
    const badStop = await json('/remote/v1/sessions/s-1/subagents/not-a-sub/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ok(badStop.response.status === 400, '远程子代理停止拒绝无效标识')

    const postJson = (path, body) => json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    ok(infoResponse.body.capabilities.includes('session-flags') && infoResponse.body.capabilities.includes('compact') && infoResponse.body.capabilities.includes('search') && infoResponse.body.capabilities.includes('branches'), '远程 info 声明会话管理能力')
    const pin = await postJson('/remote/v1/sessions/s-1/flags', { pinned: true })
    ok(pin.response.status === 200 && calls.at(-1).flags.pinned === true, '远程置顶')
    ok((await postJson('/remote/v1/sessions/s-1/flags', {})).response.status === 400, '远程 flags 需要字段')
    const del = await postJson('/remote/v1/sessions/s-1/delete', { confirm: true })
    ok(del.response.status === 403, '删除只允许配对的手机')
    ok(!calls.some((call) => call.action === 'delete'), '未确认的删除不会到达主进程')
    ok((await postJson('/remote/v1/sessions/s-1/compact', {})).response.status === 200 && calls.at(-1).action === 'compact', '远程压缩')
    ok((await json('/remote/v1/sessions/s-1/branches')).body.data.branches[0].name === 'main', '远程分支列表')
    const sw = await postJson('/remote/v1/sessions/s-1/branch', { branch: 'feature/x' })
    ok(sw.response.status === 200 && calls.at(-1).branch === 'feature/x', '远程切换分支')
    ok((await postJson('/remote/v1/sessions/s-1/branch', {})).response.status === 400, '切换分支需要分支名')
    const found = await json('/remote/v1/search?q=' + encodeURIComponent('关键词'))
    ok(found.response.status === 200 && found.body.data.hits[0].snippet === '关键词', '远程内容搜索')

    const status = await json('/remote/v1/status')
    ok(status.response.status === 200 && status.body.data.marker === 'snapshot', '远程 status 返回主进程快照')

    const sessions = await json('/remote/v1/sessions')
    ok(sessions.response.status === 200 && sessions.body.data.sessions[0].id === 's-1', '远程 sessions 返回会话摘要')

    const history = await json('/remote/v1/sessions/s-1?limit=3')
    ok(
      history.response.status === 200 &&
        history.body.data.sessionId === 's-1' &&
        calls.at(-1).limit === 3,
      '远程 history 按稳定 sessionId 和有界 limit 读取'
    )

    const selected = await json('/remote/v1/sessions/s-1/select', { method: 'POST' })
    ok(selected.response.status === 200 && calls.at(-1).action === 'select', '远程 select 只传递显式会话操作')

    const message = await json('/remote/v1/sessions/s-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '远程消息' })
    })
    ok(
      message.response.status === 200 &&
        calls.at(-1).action === 'send' &&
        calls.at(-1).sessionId === 's-1' &&
        calls.at(-1).text === '远程消息',
      '远程 messages 将稳定 sessionId 与文本一起传递，不要求切换桌面视图'
    )

    const renamed = await json('/remote/v1/sessions/s-1/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '新名称' })
    })
    ok(renamed.response.status === 200 && calls.at(-1).action === 'rename', '远程 rename 走独立操作')

    const created = await json('/remote/v1/sessions/new', { method: 'POST' })
    const newIn = (projectId) => json('/remote/v1/sessions/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'new-session-retry-0001' },
      body: JSON.stringify({ projectId })
    })
    const firstNew = await newIn('project-a')
    const callsAfterFirst = calls.length
    const replayNew = await newIn('project-a')
    ok(firstNew.response.status === 200 && replayNew.response.status === 200 && calls.length === callsAfterFirst && replayNew.body.data.projectId === 'project-a', '同项目用同一幂等键重试，回放原结果不重复新建')
    const otherProject = await newIn('project-b')
    ok(otherProject.response.status === 409 && otherProject.body.code === 'idempotency_key_reused' && calls.length === callsAfterFirst, '同一幂等键换了项目不会拿到另一个项目的新会话')
    ok(created.response.status === 200 && calls.at(-1).action === 'new', '远程 new 创建新会话')

    const noRunId = await json('/remote/v1/runs/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    ok(noRunId.response.status === 400, '远程 abort 缺少目标 runId 时在协议层拒绝')
    const badRunId = await json('/remote/v1/runs/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'active' })
    })
    ok(badRunId.response.status === 400, '远程 abort 拒绝不属于 RunnerRegistry 的 runId 形状')
    const aborted = await json('/remote/v1/runs/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r2' })
    })
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

    const slowBody = await openSlowBody(`${base}/remote/v1/sessions/s-1/messages`, headers)
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
  const kinds = { 'phone-token': 'phone', 'agent-token': 'agent' }
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
    const as = (token) => async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${phoneInfo.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': `k-${Math.random()}` }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    }
    const phone = as('phone-token')
    const agent = as('agent-token')
    const before = phoneCalls.length
    const unconfirmed = await phone('/remote/v1/sessions/s-1/delete', {})
    ok(unconfirmed.status === 400 && phoneCalls.length === before, '手机删除：缺少 confirm 返回 400，不触达主进程', unconfirmed.status)
    const loose = await phone('/remote/v1/sessions/s-1/delete', { confirm: 'true' })
    ok(loose.status === 400 && phoneCalls.length === before, '手机删除：confirm 必须是布尔 true，字符串不算', loose.status)
    const deleted = await phone('/remote/v1/sessions/s-1/delete', { confirm: true })
    ok(deleted.status === 200 && phoneCalls.at(-1)?.action === 'delete' && phoneCalls.at(-1).sessionId === 's-1', '手机删除：明确确认后到达主进程')
    const agentDelete = await agent('/remote/v1/sessions/s-1/delete', { confirm: true })
    ok(agentDelete.status !== 200 && phoneCalls.filter((call) => call.action === 'delete').length === 1, '非手机设备（agent）不能删除会话', agentDelete.status)
    const badId = await phone('/remote/v1/sessions/a%0Ab/delete', { confirm: true })
    ok(badId.status === 400 && phoneCalls.filter((call) => call.action === 'delete').length === 1, '删除拒绝无效会话 id')
    const info = await phone('/remote/v1/info')
    ok(info.body.capabilities.includes('session-delete') && info.body.capabilities.includes('session-flags') && info.body.capabilities.includes('compact') && info.body.capabilities.includes('branches') && info.body.capabilities.includes('search'), '手机设备看到新增能力声明')

    const emptyFlags = await phone('/remote/v1/sessions/s-1/flags', { pinned: 'yes' })
    ok(emptyFlags.status === 400 && !phoneCalls.some((call) => call.action === 'flags'), 'flags：非布尔值不当作有效字段')
    const archived = await phone('/remote/v1/sessions/s-1/flags', { archived: false, pinned: true })
    ok(archived.status === 200 && JSON.stringify(phoneCalls.at(-1).flags) === JSON.stringify({ pinned: true, archived: false }), 'flags：false 也如实传递')
    const compacted = await phone('/remote/v1/sessions/s-1/compact', {})
    ok(compacted.status === 200 && phoneCalls.at(-1).action === 'compact' && phoneCalls.at(-1).sessionId === 's-1', '手机压缩上下文到达主进程')
    const longBranch = await phone('/remote/v1/sessions/s-1/branch', { branch: 'b'.repeat(251) })
    ok(longBranch.status === 400 && !phoneCalls.some((call) => call.action === 'branch'), '切换分支：分支名过长被拒')
    const emptyBranch = await phone('/remote/v1/sessions/s-1/branch', { branch: '' })
    ok(emptyBranch.status === 400 && !phoneCalls.some((call) => call.action === 'branch'), '切换分支：空分支名被拒')
    const switched = await phone('/remote/v1/sessions/s-1/branch', { branch: 'feature/x' })
    ok(switched.status === 200 && phoneCalls.at(-1).branch === 'feature/x', '切换分支：合法分支名到达主进程')
    await phone('/remote/v1/search?q=' + encodeURIComponent('字'.repeat(500)))
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
    const auth = { authorization: `Bearer ${relayInfo.token}` }
    const withoutRelay = await fetch(`${relayBase}/remote/v1/status`, { headers: auth })
    const wrongRelay = await fetch(`${relayBase}/remote/v1/status`, { headers: { ...auth, 'x-yan-relay': 'wrong-token-0000000000' } })
    const withRelay = await fetch(`${relayBase}/remote/v1/status`, { headers: { ...auth, 'x-yan-relay': 'test-relay-token-1234567890' } })
    ok(withoutRelay.status === 403, '中继服务拒绝没经过隧道的请求')
    ok(wrongRelay.status === 403, '中继服务拒绝中继令牌不对的请求')
    ok(withRelay.status === 200, '中继服务接受隧道带上的中继令牌')
  } finally {
    await relayServer.stop()
    await rm(scratch, { recursive: true, force: true })
  }
}
