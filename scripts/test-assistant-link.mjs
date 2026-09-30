import http from 'node:http'

/** 等一个条件成立；测试用短轮询，避免依赖具体时序。 */
async function waitFor(condition, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function emit(res, id, event, payload) {
  res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

/**
 * 主进程助手客户端（src/main/assistant-link.ts）的离线测试。
 * 起一个本地 stub 助手服务，不连真实助手、不启动 Electron、不花 token。
 */
export async function runAssistantLinkTests(ok) {
  const { build } = await import('esbuild')
  await build({
    entryPoints: ['src/main/assistant-link.ts'],
    outfile: 'out/test/assistant-link.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const { AssistantLink, AssistantError } = await import('../out/test/assistant-link.mjs')

  const token = 'test-token'
  const seen = { idempotency: [], acks: [], lastEventId: null }
  let clients = []
  let eventId = 1

  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: '令牌错误' } }))
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, version: 'test', timezone: 'Australia/Sydney', now: '', now_ms: 0, model: null }))
      return
    }
    if (url.pathname === '/v1/turns' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        seen.idempotency.push(req.headers['idempotency-key'] ?? null)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ turn_id: 1, reply: '收到', tool_calls: 0, body: JSON.parse(body) }))
      })
      return
    }
    if (url.pathname === '/v1/events') {
      seen.lastEventId = req.headers['last-event-id'] ?? null
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      clients.push(res)
      req.on('close', () => {
        clients = clients.filter((client) => client !== res)
      })
      return
    }
    const ack = /^\/v1\/deliveries\/(\d+)\/ack$/.exec(url.pathname)
    if (ack) {
      seen.acks.push(Number(ack[1]))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, delivery_id: Number(ack[1]) }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const reminders = []
  const link = new AssistantLink({ baseUrl, token, onReminder: (reminder) => reminders.push(reminder) })
  try {
    ok((await link.health()).ok === true, '健康检查返回 ok')

    await link.sendTurn('你好', 'key-1')
    ok(seen.idempotency[0] === 'key-1', '发送回合时带 Idempotency-Key')

    const bad = new AssistantLink({ baseUrl, token: 'wrong' })
    let unauthorized = false
    try {
      await bad.health()
    } catch (err) {
      unauthorized = err instanceof AssistantError && err.code === 'unauthorized'
    }
    ok(unauthorized && bad.status === 'unauthorized', '令牌错误映射为 unauthorized')

    const offline = new AssistantLink({ baseUrl: 'http://127.0.0.1:9', token })
    let unreachable = false
    try {
      await offline.health()
    } catch (err) {
      unreachable = err instanceof AssistantError && err.code === 'unreachable'
    }
    ok(unreachable && offline.status === 'stopped', '服务未启动映射为 unreachable/stopped')

    link.startEvents()
    await waitFor(() => clients.length === 1)
    emit(clients[0], eventId++, 'reminder', {
      delivery_id: 7,
      item_id: 3,
      title: '交房租',
      notes: null,
      text: '交房租',
      fire_at: '',
      fire_at_ms: 0
    })
    await waitFor(() => reminders.length === 1)
    ok(reminders[0].delivery_id === 7, '收到 reminder 事件并回调')

    for (const client of clients) client.end()
    await waitFor(() => seen.lastEventId === '1', 8000)
    ok(true, '断线重连时携带 Last-Event-ID')

    await link.ackDelivery(7)
    ok(seen.acks.includes(7), '确认提醒送达')
  } finally {
    link.stop()
    await new Promise((resolve) => server.close(resolve))
  }
}
