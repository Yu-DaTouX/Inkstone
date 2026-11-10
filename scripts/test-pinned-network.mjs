import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createHash } from 'node:crypto'
import { createServer as createNetServer, connect as netConnect, isIP, Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const delayedSocket = (port, delay) => {
  const socket = new Socket()
  setTimeout(() => socket.connect({ host: '127.0.0.1', port }), delay)
  return socket
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...args) => resolve(args))
    emitter.once('error', reject)
  })
}

function readUntil(socket, marker) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => reject(new Error('timeout')), 4000)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf(marker)
      if (end < 0) return
      clearTimeout(timer)
      socket.off('data', onData)
      resolve(buffer)
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

export async function runPinnedResolverTests(ok, mod) {
  const { PublicPinResolver, isPublicAddress, isLoopbackAddress, normalizePinnedHost } = mod

  ok(isPublicAddress('93.184.216.34'), '公网 IPv4 可 pin')
  ok(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946'), '公网 IPv6 可 pin')
  ok(!isPublicAddress('127.0.0.1'), '回环不可 pin')
  ok(!isPublicAddress('10.0.0.8'), 'RFC1918 不可 pin')
  ok(!isPublicAddress('100.64.0.1'), 'CGNAT 不可 pin')
  ok(!isPublicAddress('169.254.169.254'), 'metadata 不可 pin')
  ok(!isPublicAddress('fd00:ec2::254'), 'IPv6 metadata 不可 pin')
  ok(isLoopbackAddress('127.1.2.3') && isLoopbackAddress('::1'), '回环字面量识别')

  ok(normalizePinnedHost('[2606:2800:220:1::1].') === '2606:2800:220:1::1', 'IPv6 主机规范化')
  ok(normalizePinnedHost('[64:ff9b::808:808]') === '64:ff9b::808:808', 'NAT64 主机保留原字面量，不折成 IPv4')
  ok(normalizePinnedHost('[::ffff:8.8.8.8]') === '::ffff:8.8.8.8', 'IPv4-mapped 主机保留原字面量')
  ok(normalizePinnedHost('Example.COM.') === 'example.com', '域名小写去尾点')
  ok(normalizePinnedHost('bad host') === undefined, '含空格主机非法')
  ok(normalizePinnedHost('a..b') === undefined, '空标签非法')

  const answers = {
    'ok.test': [{ address: '93.184.216.34', family: 4 }],
    'mixed.test': [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.5', family: 4 }],
    'private.test': [{ address: '10.0.0.8', family: 4 }],
    'six.test': [{ address: '2606:2800:220:1::1', family: 6 }]
  }
  let lookups = 0
  let failNext = false
  let clock = 1000
  const resolver = new PublicPinResolver({
    resolve: async (host) => {
      lookups += 1
      if (failNext) {
        failNext = false
        throw new Error('dns down')
      }
      return answers[host] ?? []
    },
    ttlMs: 30_000,
    now: () => clock
  })

  const pin = await resolver.resolve('ok.test')
  ok(pin.addresses.length === 1 && pin.addresses[0].address === '93.184.216.34', '公网答案生成 pin')
  ok(lookups === 1, '首次解析走注入解析器')
  const again = await resolver.resolve('ok.test')
  ok(again === pin && lookups === 1, 'TTL 内命中缓存')
  clock += 29_999
  await resolver.resolve('ok.test')
  ok(lookups === 1, 'TTL 边界内仍复用')
  clock += 2
  const refreshed = await resolver.resolve('ok.test')
  ok(refreshed !== pin && lookups === 2, 'TTL 到期重新解析')

  let rejection = null
  try {
    await resolver.resolve('mixed.test')
  } catch (error) {
    rejection = error
  }
  ok(rejection?.reason === 'not-public', '公私混合答案整体拒绝，不挑 public')

  rejection = null
  try {
    await resolver.resolve('private.test')
  } catch (error) {
    rejection = error
  }
  ok(rejection?.reason === 'not-public', '私网答案拒绝')

  rejection = null
  try {
    await resolver.resolve('localhost')
  } catch (error) {
    rejection = error
  }
  ok(rejection?.reason === 'local-host', 'localhost 不走 pin')
  rejection = null
  try {
    await resolver.resolve('app.localhost')
  } catch (error) {
    rejection = error
  }
  ok(rejection?.reason === 'local-host', '*.localhost 不走 pin')

  rejection = null
  try {
    await resolver.resolve('0.0.0.0')
  } catch (error) {
    rejection = error
  }
  ok(rejection?.reason === 'not-public', '未指定地址拒绝')

  const nat64 = await resolver.resolve('64:ff9b::808:808')
  ok(isPublicAddress('64:ff9b::808:808'), 'NAT64 公网分类允许')
  ok(nat64.addresses[0].address === '64:ff9b::808:808' && nat64.addresses[0].family === 6, 'NAT64 pin 保留 IPv6 拨号地址')
  const mapped = await resolver.resolve('::ffff:8.8.8.8')
  ok(mapped.addresses[0].address === '::ffff:8.8.8.8' && mapped.addresses[0].family === 6, 'IPv4-mapped pin 保留 IPv6 拨号地址')
  rejection = null
  try {
    await resolver.resolve('64:ff9b::a9fe:a9fe')
  } catch (error) {
    rejection = error
  }
  ok(rejection?.reason === 'not-public', 'NAT64 内嵌 metadata 仍拒绝')
  rejection = null
  try {
    await resolver.resolve('::ffff:169.254.169.254')
  } catch (error) {
    rejection = error
  }
  ok(rejection?.reason === 'not-public', 'IPv4-mapped metadata 仍拒绝')

  const literal = await resolver.resolve('93.184.216.34')
  ok(literal.addresses[0].address === '93.184.216.34', '公网 IP 字面量可 pin')
  rejection = null
  try {
    await resolver.resolve('169.254.169.254')
  } catch (error) {
    rejection = error
  }
  ok(rejection?.reason === 'not-public', 'metadata 字面量拒绝')

  lookups = 0
  failNext = true
  rejection = null
  try {
    await resolver.resolve('fail.test')
  } catch (error) {
    rejection = error
  }
  ok(rejection?.reason === 'lookup-failed', '解析失败拒绝')
  const retry = await (resolver.resolve('fail.test').catch((error) => error))
  ok(retry?.reason === 'empty-answer', '失败不缓存，第二次重新查询而拒绝')
  ok(lookups === 2, '失败后再次查询而不是复用空结果')

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let deduped = 0
  const dedupeResolver = new PublicPinResolver({
    resolve: async () => {
      deduped += 1
      await gate
      return [{ address: '93.184.216.34', family: 4 }]
    }
  })
  const first = dedupeResolver.resolve('dup.test')
  const second = dedupeResolver.resolve('dup.test')
  release()
  const [a, b] = await Promise.all([first, second])
  ok(a === b && deduped === 1, '并发请求复用同一次解析')

  let counter = 0
  const bounded = new PublicPinResolver({
    resolve: async () => [{ address: `93.184.216.${++counter}`, family: 4 }],
    limit: 2
  })
  await bounded.resolve('one.test')
  await bounded.resolve('two.test')
  await bounded.resolve('three.test')
  let evicted = false
  await bounded.resolve('one.test').catch(() => { evicted = true })
  ok(!evicted && counter === 4, '有界缓存按最旧淘汰并重新解析')

  let hungLookups = 0
  let releaseHang
  const hangGate = new Promise((resolve) => { releaseHang = resolve })
  const hanging = new PublicPinResolver({
    resolve: async () => {
      hungLookups += 1
      await hangGate
      return [{ address: '93.184.216.34', family: 4 }]
    },
    timeoutMs: 40,
    maxPending: 1
  })
  const hangFirst = hanging.resolve('hang.test').catch((error) => error)
  const hangSecond = hanging.resolve('hang.test').catch((error) => error)
  ok(hungLookups === 1, '等待中的同 host 请求复用同一次解析')
  const busy = await hanging.resolve('other.test').catch((error) => error)
  ok(busy?.reason === 'busy' && hungLookups === 1, '未完成解析达到硬上限时立即拒绝，不再派发 getaddrinfo')
  ok((await hangFirst)?.reason === 'timeout' && (await hangSecond)?.reason === 'timeout', '消费者等待约 5 秒超时拒绝')
  releaseHang()
  await sleep(10)
  const lateCached = await hanging.resolve('hang.test')
  ok(lateCached.addresses[0].address === '93.184.216.34' && hungLookups === 1, '晚到结果仍完成原任务并写入缓存，未重复派发')

  let clearLookups = 0
  let releaseClear
  const clearGate = new Promise((resolve) => { releaseClear = resolve })
  const cleared = new PublicPinResolver({
    resolve: async () => {
      clearLookups += 1
      await clearGate
      return [{ address: '93.184.216.34', family: 4 }]
    },
    timeoutMs: 30
  })
  const timedOut = await cleared.resolve('late.test').catch((error) => error)
  ok(timedOut?.reason === 'timeout', '悬挂解析按超时拒绝')
  cleared.clear()
  releaseClear()
  await sleep(10)
  await cleared.resolve('late.test')
  ok(clearLookups === 2, 'clear 之后晚到结果不重新填回已清空的 guard')

  let closeLookups = 0
  let releaseClose
  const closeGate = new Promise((resolve) => { releaseClose = resolve })
  const closedGuard = new PublicPinResolver({
    resolve: async () => {
      closeLookups += 1
      await closeGate
      return [{ address: '93.184.216.34', family: 4 }]
    },
    timeoutMs: 30
  })
  await closedGuard.resolve('close.test').catch(() => null)
  closedGuard.close()
  releaseClose()
  await sleep(10)
  const afterClose = await closedGuard.resolve('close.test').catch((error) => error)
  ok(afterClose?.reason === 'closed', '关闭后的解析直接拒绝')
  ok(closeLookups === 1, '关闭后晚到结果不再触发新查询')
}

export async function runPinnedProxyTests(ok, mod) {
  const { PinnedProxy } = mod

  const pins = new Map()
  let lookups = 0
  const resolver = {
    async resolve(host) {
      lookups += 1
      const entry = pins.get(host)
      if (!entry) {
        const error = new Error('pin-rejected')
        error.name = 'PinRejectedError'
        error.reason = 'not-public'
        throw error
      }
      return { host, addresses: entry.addresses, expiresAt: Date.now() + 30_000 }
    }
  }
  const connectCalls = []
  const proxy = new PinnedProxy({
    resolver,
    connect: (target) => {
      connectCalls.push(target)
      return netConnect({ host: '127.0.0.1', port: target.port })
    }
  })

  const echo = createNetServer((socket) => socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('echo:'), chunk]))))
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const echoPort = echo.address().port
  let targetHits = 0
  const http = createHttpServer((req, res) => {
    targetHits += 1
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`host=${req.headers.host};path=${req.url};ua=${req.headers['user-agent'] ?? ''}`)
  })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const httpPort = http.address().port

  pins.set('example.test', { addresses: [{ address: '203.0.113.10', family: 4 }] })
  pins.set('multi.test', { addresses: [{ address: '203.0.113.20', family: 4 }, { address: '203.0.113.21', family: 4 }] })
  pins.set('nat64.test', { addresses: [{ address: '64:ff9b::808:808', family: 6 }] })

  const address = await proxy.start()
  ok(address.host === '127.0.0.1' && address.port > 0, '代理只监听回环随机端口')

  const requestThroughProxy = (options, body) =>
    new Promise((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request({ ...options, host: '127.0.0.1', port: address.port }, (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('error', reject)
        req.end(body)
      })
    })

  const plain = await requestThroughProxy({
    method: 'GET',
    path: `http://example.test:${httpPort}/hello`,
    headers: { host: `example.test:${httpPort}`, 'user-agent': 'pin-test' }
  })
  ok(plain.status === 200 && plain.body.includes(`host=example.test:${httpPort}`), '明文 HTTP 按 pin 连接并保留 Host')
  ok(plain.body.includes('path=/hello') && plain.body.includes('ua=pin-test'), '请求路径与头部透传')
  ok(connectCalls.at(-1)?.host === '203.0.113.10', '只连接 pin 内的 IP')

  const privateAttempt = await requestThroughProxy({
    method: 'GET',
    path: `http://192.168.1.5:${httpPort}/`,
    headers: { host: '192.168.1.5' }
  })
  ok(privateAttempt.status === 200, '私网 IP 字面量交给原来源 guard 判断，代理不新增全局拒绝')
  ok(connectCalls.at(-1)?.host === '192.168.1.5', '私网字面量不经 DNS')

  const beforeMetadata = connectCalls.length
  const metadataAttempt = await requestThroughProxy({
    method: 'GET',
    path: `http://169.254.169.254:${httpPort}/`,
    headers: { host: '169.254.169.254' }
  })
  ok(metadataAttempt.status === 403, 'metadata 字面量永拒')
  ok(connectCalls.length === beforeMetadata, 'metadata 拒绝时没有发起连接')

  pins.set('metadata.test', { addresses: [{ address: '169.254.169.254', family: 4 }] })
  let rejected = await requestThroughProxy({
    method: 'GET',
    path: `http://metadata.test:${httpPort}/`,
    headers: { host: 'metadata.test' }
  })
  ok(rejected.status === 403, '解析到 metadata 的 pin 被拒')
  pins.delete('metadata.test')

  const routeCalls = []
  let routeDials = 0
  const routedProxy = new PinnedProxy({
    resolver: { resolve: async (host) => ({ host, addresses: [{ address: '203.0.113.60', family: 4 }], expiresAt: Date.now() + 30_000 }) },
    routeCheck: async (request) => {
      routeCalls.push(request)
      return request.host === 'proxied.test' ? { mode: 'unsupported', reason: `${request.kind} PAC SOCKS5` } : { mode: 'direct' }
    },
    connect: (target) => { routeDials += 1; return netConnect({ host: '127.0.0.1', port: target.port }) }
  })
  const routedAddress = await routedProxy.start()
  const routedOk = await new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: routedAddress.port, method: 'GET', path: `http://allowed.test:${httpPort}/`, headers: { host: 'allowed.test' } }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', (error) => resolve({ error: String(error.message) }))
    req.end()
  })
  const routedBlocked = await new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: routedAddress.port, method: 'GET', path: `http://proxied.test:${httpPort}/`, headers: { host: 'proxied.test' } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', (error) => resolve({ error: String(error.message) }))
    req.end()
  })
  ok(routedOk.status === 200, '系统路由 DIRECT 的目标正常转发')
  ok(routedBlocked.status === 403 && routedBlocked.body.includes('system-proxy-unsupported'), '非 DIRECT 的特定目标 fail closed 并返回可见原因')
  ok(routeDials === 1, '被系统代理路由阻止的目标不发起 dial，其他目标不受影响')
  ok(routeCalls.some((call) => call.kind === 'http' && call.url === `http://allowed.test:${httpPort}/`), 'HTTP 按原始 URL 核对系统路由')

  const routedTunnel = netConnect({ host: '127.0.0.1', port: routedAddress.port })
  routedTunnel.write(`CONNECT proxied.test:${echoPort} HTTP/1.1\r\nHost: proxied.test:${echoPort}\r\n\r\n`)
  const routedTunnelResponse = await readUntil(routedTunnel, Buffer.from('\r\n\r\n'))
  ok(routedTunnelResponse.toString('latin1').startsWith('HTTP/1.1 403'), 'CONNECT 在看不到原路径时也按 https/wss 原点核对路由')
  routedTunnel.destroy()
  ok(routeCalls.some((call) => call.kind === 'connect' && call.host === 'proxied.test'), 'CONNECT 路由核对带上目标 host')
  await routedProxy.close()

  let upstreamSeen = null
  const upstreamHttp = createHttpServer((req, res) => {
    upstreamSeen = { url: req.url, host: req.headers.host }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('via-upstream')
  })
  await new Promise((resolve) => upstreamHttp.listen(0, '127.0.0.1', resolve))
  const upstreamHttpPort = upstreamHttp.address().port
  const upstreamProxy = new PinnedProxy({
    resolver: { resolve: async () => { throw new Error('resolver must not be used for upstream routes') } },
    routeCheck: async () => ({ mode: 'upstream', protocol: 'http', host: '127.0.0.1', port: upstreamHttpPort })
  })
  const upstreamAddress = await upstreamProxy.start()
  const upstreamResponse = await new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: upstreamAddress.port, method: 'GET', path: `http://orig.test:${httpPort}/via-upstream`, headers: { host: `orig.test:${httpPort}` } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', (error) => resolve({ error: String(error.message) }))
    req.end()
  })
  ok(upstreamResponse.status === 200 && upstreamResponse.body === 'via-upstream', 'HTTP 目标经系统上游代理转发')
  ok(upstreamSeen?.url === `http://orig.test:${httpPort}/via-upstream` && upstreamSeen?.host === `orig.test:${httpPort}`, '上游收到原域名绝对 URL 和原 Host，而不是已审 IP')
  ok(upstreamProxy.stats().routing.upstream === 1 && upstreamProxy.stats().lastUpstream === `http://127.0.0.1:${upstreamHttpPort}`, '状态记录经系统代理且标记未做 DNS 固定')

  let connectSeen = ''
  const upstreamEchoSockets = new Set()
  const upstreamEcho = createNetServer((socket) => {
    upstreamEchoSockets.add(socket)
    socket.on('close', () => upstreamEchoSockets.delete(socket))
    let buffer = Buffer.alloc(0)
    let connected = false
    socket.on('data', (chunk) => {
      if (connected) {
        socket.write(chunk)
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf(Buffer.from('\r\n\r\n'))
      if (end < 0) return
      connectSeen = /^CONNECT (\S+) HTTP/.exec(buffer.toString('latin1'))?.[1] ?? ''
      connected = true
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const rest = buffer.subarray(end + 4)
      if (rest.length) socket.write(rest)
    })
  })
  await new Promise((resolve) => upstreamEcho.listen(0, '127.0.0.1', resolve))
  const upstreamEchoPort = upstreamEcho.address().port
  const connectUpstreamProxy = new PinnedProxy({
    resolver: { resolve: async () => { throw new Error('resolver must not be used for upstream routes') } },
    routeCheck: async () => ({ mode: 'upstream', protocol: 'http', host: '127.0.0.1', port: upstreamEchoPort })
  })
  const connectUpstreamAddress = await connectUpstreamProxy.start()
  const upstreamTunnel = netConnect({ host: '127.0.0.1', port: connectUpstreamAddress.port })
  upstreamTunnel.write(`CONNECT secure.test:${echoPort} HTTP/1.1\r\nHost: secure.test:${echoPort}\r\n\r\n`)
  const upstreamTunnelHead = await readUntil(upstreamTunnel, Buffer.from('\r\n\r\n'))
  ok(upstreamTunnelHead.toString('latin1').startsWith('HTTP/1.1 200'), 'CONNECT 经上游代理建立隧道')
  upstreamTunnel.write('through-upstream')
  const upstreamEchoed = await new Promise((resolve) => upstreamTunnel.once('data', (chunk) => resolve(chunk.toString('utf8'))))
  ok(upstreamEchoed.includes('through-upstream'), 'CONNECT 隧道经上游原样转发')
  ok(connectSeen === `secure.test:${echoPort}`, '上游 CONNECT 收到原域名而不是已审 IP')
  upstreamTunnel.destroy()

  const conflict = createHttpServer((_req, res) => {
    res.writeHead(407, { 'content-type': 'text/plain' })
    res.end('proxy auth required')
  })
  await new Promise((resolve) => conflict.listen(0, '127.0.0.1', resolve))
  const conflictPort = conflict.address().port
  const conflictProxy = new PinnedProxy({
    routeCheck: async () => ({ mode: 'upstream', protocol: 'http', host: '127.0.0.1', port: conflictPort })
  })
  const conflictAddress = await conflictProxy.start()
  const conflictResponse = await new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: conflictAddress.port, method: 'GET', path: `http://orig2.test:${httpPort}/`, headers: { host: `orig2.test:${httpPort}` } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', (error) => resolve({ error: String(error.message) }))
    req.end()
  })
  ok(conflictResponse.status === 407 && conflictResponse.body === 'proxy auth required', '上游 407 原样回给 Chromium，不读凭据')

  const dead = createNetServer((socket) => socket.destroy())
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  const failedProxy = new PinnedProxy({
    routeCheck: async () => ({ mode: 'upstream', protocol: 'http', host: '127.0.0.1', port: deadPort })
  })
  const failedAddress = await failedProxy.start()
  const beforeFailedTarget = targetHits
  const failedResponse = await new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: failedAddress.port, method: 'GET', path: `http://fallback.test:${httpPort}/`, headers: { host: `fallback.test:${httpPort}` } }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', (error) => resolve({ error: String(error.message) }))
    req.end()
  })
  ok(failedResponse.status === 502 && targetHits === beforeFailedTarget, '上游连接失败返回 502 且不回落直连')
  await failedProxy.close()
  await new Promise((resolve) => dead.close(resolve))
  await conflictProxy.close()
  await connectUpstreamProxy.close()
  await upstreamProxy.close()
  await new Promise((resolve) => upstreamHttp.close(resolve))
  for (const socket of upstreamEchoSockets) socket.destroy()
  await new Promise((resolve) => upstreamEcho.close(resolve))
  await new Promise((resolve) => conflict.close(resolve))

  const nat64 = await requestThroughProxy({
    method: 'GET',
    path: `http://nat64.test:${httpPort}/nat64`,
    headers: { host: 'nat64.test' }
  })
  ok(nat64.status === 200 && isIP(connectCalls.at(-1)?.host) === 6 && connectCalls.at(-1)?.host === '64:ff9b::808:808', 'NAT64 pin 用原 IPv6 地址拨号而不是折成 IPv4')

  const multi = await requestThroughProxy({
    method: 'GET',
    path: `http://multi.test:${httpPort}/multi`,
    headers: { host: 'multi.test' }
  })
  ok(multi.status === 200 && multi.body.includes('/multi'), '多地址 pin 依次尝试并成功')
  ok(connectCalls.filter((call) => call.host.startsWith('203.0.113.2')).length >= 1, '多地址只用 pin 内地址')

  const tunnel = netConnect({ host: '127.0.0.1', port: address.port })
  tunnel.write(`CONNECT example.test:${echoPort} HTTP/1.1\r\nHost: example.test:${echoPort}\r\n\r\n`)
  const response = await readUntil(tunnel, Buffer.from('\r\n\r\n'))
  ok(response.toString('latin1').startsWith('HTTP/1.1 200'), 'CONNECT 隧道建立')
  tunnel.write('ping')
  const echoed = await new Promise((resolve) => tunnel.once('data', (chunk) => resolve(chunk.toString('utf8'))))
  ok(echoed === 'echo:ping', 'CONNECT 隧道原样转发（TLS 由客户端握手，SNI 不变）')
  tunnel.destroy()

  const loopTunnel = netConnect({ host: '127.0.0.1', port: address.port })
  loopTunnel.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`)
  const loopResponse = await readUntil(loopTunnel, Buffer.from('\r\n\r\n'))
  ok(loopResponse.toString('latin1').startsWith('HTTP/1.1 200'), '回环字面量隧道允许（本地预览）')
  loopTunnel.destroy()

  const localhostTunnel = netConnect({ host: '127.0.0.1', port: address.port })
  localhostTunnel.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\nHost: localhost:${echoPort}\r\n\r\n`)
  const localhostResponse = await readUntil(localhostTunnel, Buffer.from('\r\n\r\n'))
  ok(localhostResponse.toString('latin1').startsWith('HTTP/1.1 200'), 'localhost 固定回环')
  localhostTunnel.destroy()

  const v6Only = createNetServer((socket) => socket.end('v6'))
  const v6Ready = await new Promise((resolve) => {
    v6Only.once('error', () => resolve(false))
    v6Only.listen(0, '::1', () => resolve(true))
  })
  if (v6Ready) {
    const v6Proxy = new mod.PinnedProxy({ resolver: { async resolve() { throw new Error('no dns for localhost') } } })
    const v6Address = await v6Proxy.start()
    const v6Tunnel = netConnect({ host: '127.0.0.1', port: v6Address.port })
    v6Tunnel.write(`CONNECT localhost:${v6Only.address().port} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
    const v6Response = await readUntil(v6Tunnel, Buffer.from('v6')).catch(() => Buffer.alloc(0))
    ok(v6Response.toString('latin1').startsWith('HTTP/1.1 200') && v6Response.includes(Buffer.from('v6')), 'localhost 只监听 ::1 时回落 IPv6 回环')
    v6Tunnel.destroy()
    await v6Proxy.close()
  }
  await new Promise((resolve) => v6Only.close(() => resolve()))

  const blockedHost = await requestThroughProxy({
    method: 'GET',
    path: `http://unknown.test:${httpPort}/`,
    headers: { host: 'unknown.test' }
  })
  ok(blockedHost.status === 403, '无 pin 的域名拒绝，不自行 DNS')

  const beforeHttps = connectCalls.length
  const httpsAbsolute = await requestThroughProxy({
    method: 'GET',
    path: `https://example.test:${httpPort}/`,
    headers: { host: 'example.test' }
  })
  ok(httpsAbsolute.status === 400 && httpsAbsolute.body.includes('https-requires-connect'), 'https 走 CONNECT，不接受绝对 URI')
  ok(connectCalls.length === beforeHttps, '拒绝 https 绝对 URI 时不连接')

  const badPort = await requestThroughProxy({
    method: 'GET',
    path: 'http://example.test:0/',
    headers: { host: 'example.test' }
  })
  ok(badPort.status === 400, '非法端口拒绝')

  let retryCalls = 0
  const refused = createNetServer()
  await new Promise((resolve) => refused.listen(0, '127.0.0.1', resolve))
  const refusedPort = refused.address().port
  await new Promise((resolve) => refused.close(resolve))
  const retryProxy = new PinnedProxy({
    resolver: { resolve: async (host) => ({ host, addresses: [{ address: '203.0.113.31', family: 4 }, { address: '203.0.113.32', family: 4 }], expiresAt: Date.now() + 30_000 }) },
    connect: (target) => {
      retryCalls += 1
      if (target.host === '203.0.113.31') return netConnect({ host: '127.0.0.1', port: refusedPort })
      return netConnect({ host: '127.0.0.1', port: target.port })
    }
  })
  const retryAddress = await retryProxy.start()
  const retried = await new Promise((resolve, reject) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port: retryAddress.port, path: `http://retry.test:${httpPort}/`, headers: { host: 'retry.test' } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
  })
  ok(retried === 200 && retryCalls >= 2, 'pin 内首个地址连接失败后尝试下一个')
  await retryProxy.close()

  const bigBody = Buffer.alloc(96 * 1024)
  for (let index = 0; index < bigBody.length; index += 1) bigBody[index] = index % 251
  const bigServer = createHttpServer((req, res) => {
    const hash = createHash('sha256')
    let length = 0
    req.on('data', (chunk) => {
      length += chunk.length
      hash.update(chunk)
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ length, hash: hash.digest('hex') }))
    })
  })
  await new Promise((resolve) => bigServer.listen(0, '127.0.0.1', resolve))
  const bigPort = bigServer.address().port

  const slowProxy = new PinnedProxy({
    resolver: {
      async resolve(host) {
        await sleep(100)
        return { host, addresses: [{ address: '203.0.113.40', family: 4 }], expiresAt: Date.now() + 30_000 }
      }
    },
    connect: (target) => delayedSocket(target.port === bigPort ? bigPort : target.port, 100),
    connectTimeoutMs: 2_000
  })
  const slowAddress = await slowProxy.start()

  const posted = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: slowAddress.port, method: 'POST', path: `http://slow.test:${bigPort}/upload`, headers: { host: `slow.test:${bigPort}`, 'content-type': 'application/octet-stream' } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    req.on('error', reject)
    let offset = 0
    const writeChunk = () => {
      if (offset >= bigBody.length) {
        req.end()
        return
      }
      req.write(bigBody.subarray(offset, offset + 8192))
      offset += 8192
      setTimeout(writeChunk, 1)
    }
    writeChunk()
  })
  ok(posted.length === bigBody.length && posted.hash === createHash('sha256').update(bigBody).digest('hex'), '分片发送 >64KB POST 在等待解析/连接期间不丢失，服务端逐字节相同')
  ok(slowProxy.stats().outbound === 0, 'HTTP 转发结束后不残留 outbound socket')

  const rawEcho = createNetServer((socket) => socket.on('data', (chunk) => socket.write(chunk)))
  await new Promise((resolve) => rawEcho.listen(0, '127.0.0.1', resolve))
  const rawEchoPort = rawEcho.address().port

  const slowConnectProxy = new PinnedProxy({
    resolver: { resolve: async (host) => { await sleep(100); return { host, addresses: [{ address: '203.0.113.41', family: 4 }], expiresAt: Date.now() + 30_000 } } },
    connect: () => delayedSocket(rawEchoPort, 100),
    connectTimeoutMs: 2_000
  })
  const slowConnectAddress = await slowConnectProxy.start()
  const tunnelClient = netConnect({ host: '127.0.0.1', port: slowConnectAddress.port })
  tunnelClient.write(`CONNECT slow.test:${rawEchoPort} HTTP/1.1\r\nHost: slow.test:${rawEchoPort}\r\n\r\n`)
  await sleep(30)
  tunnelClient.write('chunk-a')
  await sleep(10)
  tunnelClient.write('chunk-b')
  const tunnelData = await new Promise((resolve) => {
    let buffer = ''
    tunnelClient.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('chunk-a') && buffer.includes('chunk-b')) resolve(buffer)
    })
    setTimeout(() => resolve(buffer), 2500)
  })
  ok(tunnelData.includes('200 Connection Established') && tunnelData.includes('chunk-a') && tunnelData.includes('chunk-b'), 'CONNECT 等待上游期间分片字节不丢失')
  tunnelClient.destroy()
  await sleep(20)
  ok(slowConnectProxy.stats().outbound === 0, '隧道客户端断开后不残留 outbound socket')
  await slowConnectProxy.close()

  const upgradeServer = createNetServer((socket) => {
    let buffer = Buffer.alloc(0)
    let upgraded = false
    socket.on('data', (chunk) => {
      if (!upgraded) {
        buffer = Buffer.concat([buffer, chunk])
        const end = buffer.indexOf(Buffer.from('\r\n\r\n'))
        if (end < 0) return
        upgraded = true
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fixture\r\n\r\n')
        const rest = buffer.subarray(end + 4)
        if (rest.length) socket.write(rest)
        return
      }
      socket.write(chunk)
    })
  })
  await new Promise((resolve) => upgradeServer.listen(0, '127.0.0.1', resolve))
  const upgradePort = upgradeServer.address().port
  const upgradeProxy = new PinnedProxy({
    resolver: { resolve: async (host) => { await sleep(100); return { host, addresses: [{ address: '203.0.113.42', family: 4 }], expiresAt: Date.now() + 30_000 } } },
    connect: () => delayedSocket(upgradePort, 100),
    connectTimeoutMs: 2_000
  })
  const upgradeAddress = await upgradeProxy.start()
  const wsClient = netConnect({ host: '127.0.0.1', port: upgradeAddress.port })
  wsClient.write(`GET http://ws.test:${upgradePort}/chat HTTP/1.1\r\nHost: ws.test:${upgradePort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: fixture\r\nSec-WebSocket-Version: 13\r\n\r\n`)
  await sleep(30)
  wsClient.write('frame-1')
  await sleep(10)
  wsClient.write('frame-2')
  const wsData = await new Promise((resolve) => {
    let buffer = ''
    wsClient.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.includes('101 Switching Protocols') && buffer.includes('frame-1') && buffer.includes('frame-2')) resolve(buffer)
    })
    setTimeout(() => resolve(buffer), 2500)
  })
  ok(wsData.includes('101 Switching Protocols') && wsData.includes('frame-1') && wsData.includes('frame-2'), 'WS 升级等待上游期间分片字节不丢失')
  wsClient.destroy()
  await sleep(20)
  ok(upgradeProxy.stats().outbound === 0, 'WS 客户端断开后不残留 outbound socket')
  await upgradeProxy.close()

  const abortProxy = new PinnedProxy({
    resolver: { resolve: async (host) => { await sleep(300); return { host, addresses: [{ address: '203.0.113.43', family: 4 }], expiresAt: Date.now() + 30_000 } } },
    connect: () => delayedSocket(rawEchoPort, 300),
    connectTimeoutMs: 2_000
  })
  const abortAddress = await abortProxy.start()
  const abortClient = netConnect({ host: '127.0.0.1', port: abortAddress.port })
  abortClient.write(`CONNECT abort.test:${rawEchoPort} HTTP/1.1\r\nHost: abort.test:${rawEchoPort}\r\n\r\n`)
  await sleep(20)
  abortClient.destroy()
  await sleep(700)
  ok(abortProxy.stats().outbound === 0 && abortProxy.stats().clients === 0, '半途中止的拨号与连接没有残留 socket')
  await abortProxy.close()

  const closingProxy = new PinnedProxy({
    resolver: { resolve: async (host) => { await sleep(1_000); return { host, addresses: [{ address: '203.0.113.44', family: 4 }], expiresAt: Date.now() + 30_000 } } },
    connect: () => delayedSocket(rawEchoPort, 1_000),
    connectTimeoutMs: 3_000
  })
  const closingAddress = await closingProxy.start()
  const closingRequest = new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: closingAddress.port, method: 'GET', path: `http://close.test:${rawEchoPort}/`, headers: { host: `close.test:${rawEchoPort}` } }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', (error) => resolve({ error: String(error.message) }))
    req.end()
  })
  await sleep(50)
  await closingProxy.close()
  const closingResult = await closingRequest
  ok((closingResult.error || closingResult.status >= 500) && closingProxy.stats().outbound === 0, 'close() 取消挂起拨号并清理 socket')

  const slowDownload = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('first-chunk')
    setTimeout(() => {
      if (!res.destroyed) res.end('last-chunk')
    }, 2_000)
  })
  await new Promise((resolve) => slowDownload.listen(0, '127.0.0.1', resolve))
  const downloadPort = slowDownload.address().port
  const downloadProxy = new PinnedProxy({
    resolver: { resolve: async (host) => ({ host, addresses: [{ address: '203.0.113.50', family: 4 }], expiresAt: Date.now() + 30_000 }) },
    connect: () => delayedSocket(downloadPort, 0)
  })
  const downloadAddress = await downloadProxy.start()
  await new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: downloadAddress.port, method: 'GET', path: `http://download.test:${downloadPort}/big`, headers: { host: `download.test:${downloadPort}` } }, (res) => {
      res.once('data', () => {
        req.destroy()
        resolve()
      })
      res.on('error', () => resolve())
    })
    req.on('error', () => resolve())
    req.end()
  })
  await sleep(150)
  ok(downloadProxy.stats().outbound === 0 && downloadProxy.stats().clients === 0, 'HTTP 下载中途断开后下游结束并清理上游 socket')
  await downloadProxy.close()

  let cancelDials = 0
  const cancelProxy = new PinnedProxy({
    resolver: { resolve: async (host) => { await sleep(300); return { host, addresses: [{ address: '203.0.113.51', family: 4 }], expiresAt: Date.now() + 30_000 } } },
    connect: () => { cancelDials += 1; return delayedSocket(rawEchoPort, 0) },
    connectTimeoutMs: 2_000
  })
  const cancelAddress = await cancelProxy.start()
  const cancelRequest = httpRequest({ host: '127.0.0.1', port: cancelAddress.port, method: 'GET', path: `http://cancel.test:${rawEchoPort}/`, headers: { host: `cancel.test:${rawEchoPort}` } })
  cancelRequest.on('error', () => undefined)
  cancelRequest.end()
  await sleep(20)
  cancelRequest.destroy()
  await sleep(500)
  ok(cancelDials === 0 && cancelProxy.stats().outbound === 0, '客户端在等待解析/拨号时取消，不再尝试后续 IP 且无残留 socket')
  await cancelProxy.close()

  let closingDials = 0
  const closePendingProxy = new PinnedProxy({
    resolver: { resolve: async (host) => { await sleep(800); return { host, addresses: [{ address: '203.0.113.52', family: 4 }], expiresAt: Date.now() + 30_000 } } },
    connect: () => { closingDials += 1; return delayedSocket(rawEchoPort, 0) },
    connectTimeoutMs: 2_000
  })
  const closePendingAddress = await closePendingProxy.start()
  const pendingRequest = httpRequest({ host: '127.0.0.1', port: closePendingAddress.port, method: 'GET', path: `http://close-pending.test:${rawEchoPort}/`, headers: { host: `close-pending.test:${rawEchoPort}` } })
  pendingRequest.on('error', () => undefined)
  pendingRequest.end()
  await sleep(50)
  await closePendingProxy.close()
  await sleep(900)
  ok(closingDials === 0 && closePendingProxy.stats().outbound === 0, 'guard 关闭时取消挂起解析/拨号，不再建立 socket')

  await slowProxy.close()
  await new Promise((resolve) => slowDownload.close(resolve))
  await proxy.close()
  await new Promise((resolve) => http.close(resolve))
  await new Promise((resolve) => echo.close(resolve))
  await new Promise((resolve) => bigServer.close(resolve))
  await new Promise((resolve) => rawEcho.close(resolve))
  await new Promise((resolve) => upgradeServer.close(resolve))
  ok(lookups >= 4, '代理解析只走共享解析器，不自行查询 DNS')
}


async function main() {
  const { build } = await import('esbuild')
  const bundle = async (entry) => {
    const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
    return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
  }
  const resolverModule = await bundle('src/main/net/pinned-resolver.ts')
  const proxyModule = await bundle('src/main/net/pinned-proxy.ts')
  let checks = 0
  let failures = 0
  const ok = (value, label) => {
    checks += 1
    if (!value) {
      failures += 1
      console.log('✗ ' + label)
    }
  }
  await runPinnedResolverTests(ok, resolverModule)
  await runPinnedProxyTests(ok, proxyModule)
  console.log(`pinned-network: ${checks - failures}/${checks} 通过`)
  if (failures) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('pinned-network: ' + (error?.stack ?? error))
    process.exitCode = 1
  })
}
