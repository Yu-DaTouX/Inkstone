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
    const ignored = await Promise.race([
      reader.read().then((result) => ({ timedOut: false, result })),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 40))
    ])
    ok(ignored.timedOut === true, 'SSE 不转发桌面专属 browser-state')

    await reader.cancel()

    const download = await new Promise((resolve) => {
      const request = http.get(`${base}/remote/v1/sessions/s-1/images/m-1/0`, { headers }, (response) => resolve({ request, response }))
      request.on('error', () => resolve({ request, response: null }))
    })
    ok(download.response?.statusCode === 200, '远程图片按文件流返回')
    download.response?.pause()
    const stopStarted = Date.now()
    await server.stop()
    ok(Date.now() - stopStarted < 3000, '有未读完的下载流时 stop() 三秒内返回')
    download.request.destroy()
  } finally {
    await server.stop()
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
