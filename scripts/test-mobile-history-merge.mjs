import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({
  stdin: {
    contents: `export { normalizeBaseUrl } from './src/api/base-url'; export { HistoryCache, mergeRecentHistory } from './src/historyCache'`,
    resolveDir: 'mobile',
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const M = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

assert.equal(M.normalizeBaseUrl('100.64.0.1'), 'http://100.64.0.1:37892')
assert.equal(M.normalizeBaseUrl(' https://inkstone.example.com/ '), 'https://inkstone.example.com:443')
assert.equal(M.normalizeBaseUrl('100.64.0.1:4000'), 'http://100.64.0.1:4000')
assert.equal(M.normalizeBaseUrl('http://[::1]:9999'), 'http://[::1]:9999')
assert.equal(M.normalizeBaseUrl('100.64.0.1:70000'), '')
assert.equal(M.normalizeBaseUrl('构造不出的地址'), '')
assert.equal(M.normalizeBaseUrl(''), '')

const previous = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
assert.deepEqual(M.mergeRecentHistory(previous, [{ id: 'b' }, { id: 'b2' }]), { messages: [{ id: 'a' }, { id: 'b' }, { id: 'b2' }], retained: true })
assert.deepEqual(M.mergeRecentHistory(previous, [{ id: 'z' }]), { messages: [{ id: 'z' }], retained: false })
assert.deepEqual(M.mergeRecentHistory(previous, [{ id: 'a' }]), { messages: [{ id: 'a' }], retained: false })
assert.deepEqual(M.mergeRecentHistory([], [{ id: 'a' }]), { messages: [{ id: 'a' }], retained: false })

const cache = new M.HistoryCache()
const page = { messages: Array.from({ length: 400 }, (_, index) => ({ id: `m${index}`, role: 'user', text: 'x'.repeat(400) })), hasMore: false, nextBefore: undefined }
cache.set('s1', page)
const clipped = cache.get('s1')
assert.ok(clipped.messages.length > 0 && clipped.messages.length < page.messages.length)
assert.equal(clipped.messages.at(-1).id, 'm399')
assert.equal(clipped.hasMore, true)
assert.equal(clipped.nextBefore, clipped.messages[0].id)
cache.set('s1', { messages: [{ id: 'm1', role: 'user', text: 'y' }], hasMore: false })
assert.equal(cache.get('s1').messages.length, 1)
assert.equal(cache.get('s1').hasMore, false)
for (let index = 0; index < 8; index++) cache.set(`s${index}`, { messages: [{ id: `x${index}`, role: 'user', text: 'y' }], hasMore: false })
assert.equal(cache.get('s1'), undefined)
assert.ok(cache.get('s7'))

console.log('mobile-history-merge: 地址归一、历史合并与缓存裁剪通过（纯函数，不连真机）')
