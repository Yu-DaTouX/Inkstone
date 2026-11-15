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
  const realFetch = globalThis.fetch
  const delays = []
  globalThis.setTimeout = (fn, ms, ...args) => { delays.push(ms); return realSetTimeout(fn, 0, ...args) }
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
  })

  const attempt = async (run) => {
    delays.length = 0
    try { await run(); return { delay: delays[0], error: null } }
    catch (error) { return { delay: delays[0], error } }
  }

  try {
    const direct = new RemoteClient({ baseUrl: 'http://127.0.0.1:1', token: 't', deviceId: 'd' })
    const text = await attempt(() => direct.send('s-1', '你好'))
    ok(text.delay === 15_000, '纯文字消息仍用 15 秒默认超时', String(text.delay))
    ok(/连接超时/.test(text.error?.message ?? ''), '纯文字超时仍提示电脑可能没运行', text.error?.message)

    const image = 'A'.repeat(700_000)
    const photos = await attempt(() => direct.send('s-1', '看图', undefined, [1, 2, 3, 4].map(() => ({ mimeType: 'image/jpeg', data: image }))))
    ok(photos.delay >= 60_000, '带 4 张图的消息按体积放宽超时', String(photos.delay))
    ok(/上传/.test(photos.error?.message ?? '') && !/确认电脑上的砚在运行/.test(photos.error?.message ?? ''), '带图超时提示上传慢，不再指向电脑没运行', photos.error?.message)

    const wav = 'A'.repeat(5_100_000)
    const voice = await attempt(() => direct.transcribe(wav))
    ok(voice.delay >= 150_000 && voice.delay <= 180_000, '120 秒录音转写按体积放宽超时并有上限', String(voice.delay))
    ok(/上传/.test(voice.error?.message ?? ''), '转写超时提示上传慢', voice.error?.message)

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
      ok(relayTimeout >= 150_000, '中继转写按体积放宽超时', String(relayTimeout))
      ok(/上传/.test(relayVoice.error?.message ?? ''), '中继转写超时提示上传慢', relayVoice.error?.message)
    } finally {
      RelayTunnel.for = originalFor
    }
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.fetch = realFetch
  }
})
