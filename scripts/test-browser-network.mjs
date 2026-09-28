export async function runBrowserNetworkTests(ok, mod) {
  const listeners = new Map()
  const cdp = {
    on(method, cb) {
      let set = listeners.get(method)
      if (!set) listeners.set(method, (set = new Set()))
      set.add(cb)
      return () => set.delete(cb)
    },
    async send() {
      return {}
    }
  }
  const emit = (method, params, sessionId) => {
    for (const cb of listeners.get(method) ?? []) cb(params, sessionId)
  }
  const tracker = new mod.NetworkTracker(cdp)
  await tracker.start()
  emit('Network.requestWillBeSent', {
    requestId: 'r1',
    type: 'Document',
    request: { url: 'https://user:secret@example.com/path?token=secret#private', method: 'get' }
  })
  emit('Network.responseReceived', { requestId: 'r1', type: 'Document', response: { status: 200, headers: { cookie: 'must never be copied' } } })
  emit('Network.loadingFinished', { requestId: 'r1' })
  emit('Network.requestWillBeSent', {
    requestId: 'r1',
    type: 'Fetch',
    request: { url: 'https://frame.example/private?id=secret', method: 'POST' }
  }, 'iframe-session')
  const current = tracker.snapshot()
  ok(current.entries.length === 2, '同一请求 id 在不同 CDP frame session 中隔离')
  ok(current.entries[0].url === 'https://example.com/path', 'URL 去掉用户名、密码、查询参数与片段')
  ok(current.entries[0].status === 200 && current.entries[0].state === 'finished', '响应状态与完成状态汇总')
  ok(current.entries[1].url === 'https://frame.example/private' && current.entries[1].state === 'pending', '跨 frame 请求保留安全 URL 与 pending 状态')
  ok(!JSON.stringify(current).includes('secret') && !JSON.stringify(current).includes('cookie'), '快照不含 query secret 或 Cookie 值')

  for (let i = 0; i < 100; i++) {
    emit('Network.requestWillBeSent', {
      requestId: `bounded-${i}`,
      type: 'Other',
      request: { url: `https://example.com/${i}`, method: 'GET' }
    })
  }
  const bounded = tracker.snapshot()
  ok(bounded.entries.length === bounded.limit && bounded.limit === 80, '网络账本超限时只保留最近 80 条')
  ok(bounded.entries.at(-1)?.url.endsWith('/99'), '有界账本保留最新请求')

  emit('Network.requestWillBeSent', {
    requestId: 'long-url',
    type: 'Document',
    request: { url: `https://example.com/${'x'.repeat(20_000)}?secret=hidden`, method: 'GET' }
  })
  const longUrl = tracker.snapshot().entries.at(-1)?.url ?? ''
  ok(longUrl.length <= 2_048 && longUrl.endsWith('…'), '超长 URL 路径截断，网络快照大小有上限')
}
