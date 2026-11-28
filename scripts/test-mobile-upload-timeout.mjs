import './lib/test-isolate.mjs'
import { build } from 'esbuild'
import { runSuite } from './lib/test-suite.mjs'

const nobleStub = { name: 'noble-stub', setup(b) {
  b.onResolve({ filter: /^@noble\/(curves|ciphers)\// }, (args) => ({ path: args.path, namespace: 'noble-stub' }))
  b.onLoad({ filter: /.*/, namespace: 'noble-stub' }, () => ({ contents: 'export const p256 = {}; export const gcm = () => ({})', loader: 'js' }))
} }

await runSuite(import.meta.url, async (ok) => {
  const built = await build({ stdin: { contents: `export { RemoteClient } from './mobile/src/api/client'; export { RelayTunnel, RelayError } from './mobile/src/api/relay'`, resolveDir: '.', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', plugins: [nobleStub] })
  const { RemoteClient, RelayTunnel, RelayError } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

  const realSetTimeout = globalThis.setTimeout
  const delays = []
  globalThis.setTimeout = (fn, ms, ...args) => { delays.push(ms); return realSetTimeout(fn, 0, ...args) }

  const attempt = async (run) => {
    delays.length = 0
    try { await run(); return { delay: delays[0], error: null } }
    catch (error) { return { delay: delays[0], error } }
  }

  try {
    const wav = 'A'.repeat(5_100_000)
    const originalFor = RelayTunnel.for
    let relayTimeout
    RelayTunnel.for = () => ({
      request: async (_method, _path, init) => {
        relayTimeout = init.timeoutMs
        const timedOut = new RelayError('连接超时：请确认电脑上的砚在运行', false, true)
        throw timedOut
      }
    })
    try {
      const relayed = new RemoteClient({ baseUrl: 'relay://pc', relay: { join: 'wss://relay', hostKey: 'h', clientKey: 'c' }, token: 't', deviceId: 'd' })
      relayTimeout = undefined
      const relayText = await attempt(() => relayed.send('s-1', '你好'))
      ok(relayTimeout === undefined || relayTimeout === 20_000, '中继纯文字消息仍用默认超时', String(relayTimeout))
      ok(/连接超时/.test(relayText.error?.message ?? ''), '中继纯文字超时文案不变', relayText.error?.message)
      relayTimeout = undefined
      const relayVoice = await attempt(() => relayed.transcribe(wav))
      ok(relayTimeout >= 150_000 && relayTimeout <= 180_000, '中继转写按体积放宽超时并有上限', String(relayTimeout))
      ok(/上传/.test(relayVoice.error?.message ?? ''), '中继转写超时提示上传慢', relayVoice.error?.message)
      const image = 'A'.repeat(700_000)
      relayTimeout = undefined
      const photos = await attempt(() => relayed.send('s-1', '看图', undefined, [1, 2, 3, 4].map(() => ({ mimeType: 'image/jpeg', data: image }))))
      ok(relayTimeout >= 60_000, '带 4 张图的消息按体积放宽超时', String(relayTimeout))
      ok(/上传/.test(photos.error?.message ?? ''), '带图超时提示上传慢', photos.error?.message)
    } finally {
      RelayTunnel.for = originalFor
    }
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})
