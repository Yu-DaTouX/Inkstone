/**
 * Cookie transfer 的纯单元测试。
 *
 * 现场编译模块并用假的 CDP 通道喂合成 cookie，不读取或写入真实浏览器数据。
 * 用法：node scripts/test-cookie-transfer.mjs
 */
import assert from 'node:assert/strict'
import { build } from '../node_modules/esbuild/lib/main.js'

await build({
  entryPoints: ['src/main/browser/cookie-transfer.ts'],
  outfile: 'out/test/cookie-transfer.mjs',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent'
})

const { transferCookies } = await import('../out/test/cookie-transfer.mjs')

class FakeCdpChannel {
  constructor(cookies = [], failingNames = []) {
    this.cookies = cookies
    this.failingNames = new Set(failingNames)
    this.calls = []
  }

  async attach() {}
  async screenshot() { return Buffer.alloc(0) }
  async detach() {}

  async send(method, params) {
    if (method === 'Network.getAllCookies') return { cookies: this.cookies }
    assert.equal(method, 'Network.setCookies')
    const cookie = params.cookies[0]
    this.calls.push(cookie)
    if (this.failingNames.has(cookie.name)) throw new Error(`synthetic failure: ${cookie.name}`)
    return {}
  }
}

const source = new FakeCdpChannel([
  {
    name: 'host-only', value: 'h', domain: 'app.example.test', path: '/login',
    secure: true, httpOnly: true, session: true, expires: 0, sameSite: 'Lax'
  },
  {
    name: 'domain-scoped', value: 'd', domain: '.example.test', path: '/',
    secure: false, httpOnly: false, session: false, expires: 1893456000, sameSite: 'Strict',
    partitionKey: { topLevelSite: 'https://embed.test' }
  },
  {
    name: 'opaque-partition', value: 'o', domain: 'example.test', path: '/',
    secure: true, httpOnly: false, session: false, expires: 1893456000,
    partitionKeyOpaque: true
  },
  {
    name: 'after-opaque', value: 'a', domain: 'example.test', path: '/next',
    secure: true, httpOnly: true, session: false, expires: 1893456001
  }
])
const target = new FakeCdpChannel([], ['after-opaque'])

const result = await transferCookies(source, target)
assert.deepEqual(result, { copied: 2, failed: 2 })
assert.equal(source.calls.length, 0)
assert.equal(target.calls.length, 3, 'opaque partition is skipped before CDP setCookies')

const hostOnly = target.calls[0]
assert.equal(hostOnly.url, 'https://app.example.test/login')
assert.equal(hostOnly.domain, undefined, 'host-only cookie must omit domain')
assert.equal(hostOnly.secure, true)
assert.equal(hostOnly.httpOnly, true)
assert.equal(hostOnly.sameSite, 'Lax')
assert.equal(hostOnly.expires, undefined, 'session cookie must omit expiry')

const domainScoped = target.calls[1]
assert.equal(domainScoped.url, 'http://example.test/')
assert.equal(domainScoped.domain, '.example.test')
assert.equal(domainScoped.expires, 1893456000)
assert.equal(domainScoped.sameSite, 'Strict')
assert.deepEqual(domainScoped.partitionKey, { topLevelSite: 'https://embed.test' })

assert.equal(target.calls[2].name, 'after-opaque', 'one failed setCookies call must not abort later cookies')
console.log('✓ cookie transfer scope, lifetime, flags, partition and per-cookie failures')
console.log('1/1 通过')
