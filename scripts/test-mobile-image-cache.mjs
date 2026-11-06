import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ stdin: { contents: `export { ImageCache } from './src/imageCache'`, resolveDir: 'mobile', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false })
const { ImageCache } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const cache = new ImageCache()
let fetches = 0
const fetcher = (uri) => () => { fetches++; return new Promise((resolve) => setTimeout(() => resolve({ uri }), 5)) }
const [a, b] = await Promise.all([cache.load('k1', fetcher('data:1')), cache.load('k1', fetcher('data:1'))])
assert.equal(a, b)
assert.equal(fetches, 1, '同一张图并发请求只下载一次')
await cache.load('k1', fetcher('data:1'))
assert.equal(fetches, 1, '再次出现（列表滚回来）命中缓存')
assert.equal(cache.peek('k1').uri, 'data:1')

for (let i = 0; i < 60; i++) await cache.load(`n${i}`, fetcher(`data:${i}`))
assert.equal(cache.peek('k1'), undefined, '超过条数上限淘汰最旧的')
assert.ok(cache.peek('n59'))

const big = new ImageCache()
await big.load('huge', async () => ({ uri: 'x'.repeat(17_000_000) }))
assert.equal(big.peek('huge'), undefined, '单张超过总上限不缓存')
const failing = new ImageCache()
await assert.rejects(failing.load('bad', async () => { throw new Error('boom') }))
await failing.load('bad', async () => ({ uri: 'ok' }))
assert.equal(failing.peek('bad').uri, 'ok', '失败不留缓存，可重试')
console.log('mobile-image-cache: 图片缓存通过')
