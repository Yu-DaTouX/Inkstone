import './lib/test-isolate.mjs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { runSuite } from './lib/test-suite.mjs'

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)))

function deadPort() {
  return new Promise((done) => {
    const server = createNetServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

function viaProxy(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = httpRequest({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: target.host } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { PinnedProxy, PROXY_ERROR_HEADER, proxyErrorReason } = await compile('src/main/net/pinned-proxy.ts')
  const { proxyLoadFailure } = await compile('src/shared/browser-navigation.ts')

  const proxy = new PinnedProxy({ resolver: { resolve: async () => { throw new Error('no dns in test') } } })
  const { port } = await proxy.start()
  const spoof = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', [PROXY_ERROR_HEADER]: 'forged connect-failed' })
    res.end('page from site')
  })
  const spoofPort = await listen(spoof)
  try {
    const dead = await deadPort()
    const failed = await viaProxy(port, `http://127.0.0.1:${dead}/`)
    ok(failed.status === 502, '连接失败仍回 502', String(failed.status))
    ok(failed.body === 'pinned network proxy: connect-failed', '响应正文不变', failed.body)
    ok(typeof failed.headers[PROXY_ERROR_HEADER] === 'string', '失败响应带标记头')
    ok(proxyErrorReason(failed.headers) === 'connect-failed', '主进程能从标记头读出失败原因')

    ok(proxyErrorReason({ [PROXY_ERROR_HEADER]: 'forged connect-failed' }) === null, '令牌不对的标记头不被认')
    ok(proxyErrorReason({ 'content-type': 'text/plain' }) === null, '没有标记头时返回空')
    ok(proxyErrorReason(null) === null, '没有响应头时返回空')

    const passed = await viaProxy(port, `http://127.0.0.1:${spoofPort}/`)
    ok(passed.status === 200 && passed.body === 'page from site', '正常网页照常透传')
    ok(!(PROXY_ERROR_HEADER in passed.headers), '网站自己发的同名头在代理里被去掉')
    ok(proxyErrorReason(passed.headers) === null, '网站伪造不出代理失败')

    const refused = proxyLoadFailure('connect-failed', `http://127.0.0.1:${dead}/`)
    ok(refused.code === -102 && refused.description === 'ERR_CONNECTION_REFUSED' && refused.proxyReason === 'connect-failed', '连接失败映射成连接被拒')
    ok(proxyLoadFailure('connect-timeout', 'http://a.test/').code === -118, '连接超时映射成超时')
    const other = proxyLoadFailure('pin-rejected', 'http://a.test/')
    ok(other.code === -2 && other.proxyReason === 'pin-rejected', '其他原因保留原因并用通用失败码')
  } finally {
    spoof.close()
    await proxy.close()
  }
})
