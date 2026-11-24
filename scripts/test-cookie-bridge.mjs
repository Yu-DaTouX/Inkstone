import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const built = await build({ stdin: { contents: "export * from './src/main/browser/cookie-bridge'; export * from './src/main/browser/firefox-cookies'; export { browserText } from './src/renderer/src/features/browser/browser-text'", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm', external: ['node:sqlite'], logLevel: 'silent' })
const { createCookieBridge, COOKIE_BRIDGE_ORIGIN, parseBridgeCookies, writeBridgeCookies, discoverFirefoxProfiles, listFirefoxProfiles, parseFirefoxOriginAttributes, readFirefoxCookies, browserText } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const extensionPath = resolve('resources/browser-cookie-bridge')
const manifest = JSON.parse(await readFile(`${extensionPath}/manifest.json`, 'utf8'))
const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(n => String.fromCharCode(97 + (n >> 4), 97 + (n & 15))).join('')
assert.equal(`chrome-extension://${extensionId}`, COOKIE_BRIDGE_ORIGIN)
assert.deepEqual(manifest.permissions, ['cookies'])
assert.equal(manifest.permissions.includes('history'), false)

const sample = { name: 'fixture', value: 'test-only', domain: 'example.test', path: '/', hostOnly: true, secure: true, httpOnly: true, session: true, sameSite: 'lax' }
assert.equal(parseBridgeCookies({ cookies: [sample] }).cookies.length, 1)
for (const invalid of [null, {}, { cookies: Array(20_001).fill(sample) }]) assert.throws(() => parseBridgeCookies(invalid))
for (const invalid of [null, { ...sample, domain: 'example.test/x' }, { ...sample, domain: 'example.test:80' }, { ...sample, domain: 'example.test@evil.test' }, { ...sample, session: false }, { ...sample, value: 'test\n' }, { ...sample, partitionKey: { topLevelSite: 'file:///etc', hasCrossSiteAncestor: true } }]) {
  const parsed = parseBridgeCookies({ cookies: [sample, invalid] })
  assert.equal(parsed.cookies.length, 1, '异常单条不拖垮合法 Cookie')
  assert.equal(parsed.skipped, 1)
}
const compatible = parseBridgeCookies({ cookies: [{ ...sample, domain: '[::1]' }, { ...sample, name: 'legacy name' }, { ...sample, domain: 'host_name.test' }] })
assert.equal(compatible.cookies.length, 3)
assert.equal(compatible.skipped, 0)
assert.match(browserText('zh-CN').importError('read_failed'), /权限/)
assert.match(browserText('en-US').importError('invalid_payload'), /parsed/)
const sent = []
const cookies = [sample, { ...sample, domain: '.example.test', hostOnly: false, session: false, expirationDate: Date.now() / 1000 + 3600, sameSite: 'strict', partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: true } }, { ...sample, session: false, expirationDate: 1 }, { ...sample, name: 'fails', sameSite: 'no_restriction' }]
const counts = await writeBridgeCookies(async (method, params) => {
  assert.equal(method, 'Network.setCookies')
  sent.push(params.cookies[0])
  if (params.cookies[0].name === 'fails') throw new Error('fixture failure')
}, cookies)
assert.deepEqual(counts, { copied: 2, failed: 1, skipped: 1 })
assert.equal(sent[0].domain, undefined)
assert.equal(sent[0].expires, undefined)
assert.equal(sent[0].httpOnly, true)
assert.equal(sent[0].sameSite, 'Lax')
assert.equal(sent[1].domain, '.example.test')
assert.equal(sent[1].sameSite, 'Strict')
assert.deepEqual(sent[1].partitionKey, cookies[1].partitionKey)
assert.equal(sent[2].sameSite, 'None')

let received = 0
let release
const pending = new Promise(r => { release = r })
const bridge = await createCookieBridge({ extensionPath, showExtension: async () => {}, receive: async list => { received++; assert.equal(list.length, 1); await pending; return { copied: 1, failed: 0, skipped: 0 } } })
const url = new URL(bridge.url)
const token = url.hash.slice(1).split('.')[1]
const headers = { Origin: COOKIE_BRIDGE_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Sync-Browser': 'chrome', 'X-Sync-Role': 'browser' }
const call = (path, extra = {}) => fetch(`${url.origin}${path}`, { headers, ...extra })
try {
  assert.equal((await fetch(`${url.origin}/v1/status`)).status, 401)
  assert.equal((await call('/v1/status', { headers: { ...headers, Origin: '' } })).status, 403)
  const withoutOrigin = { ...headers }; delete withoutOrigin.Origin
  assert.equal((await call('/v1/status', { headers: withoutOrigin })).status, 200)
  assert.equal((await call('/v1/status', { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403)
  assert.equal((await call('/v1/status', { headers: { ...headers, Authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await call('/v1/status', { headers: { ...headers, 'X-Sync-Role': 'target' } })).status, 401)
  assert.equal((await call('/v1/status', { headers: { ...headers, 'X-Sync-Browser': 'other' } })).status, 401)
  assert.equal((await call('/v1/status', { method: 'OPTIONS' })).status, 204)
  const status = await (await call('/v1/status')).json()
  assert.equal(status.sourceNeeded, true)
  assert.equal(JSON.stringify(status).includes('test-only'), false)
  assert.equal((await call('/v1/payload')).status, 404)
  assert.equal(received, 0)
  const setup = await fetch(`${url.origin}/v1/setup`, { headers: { Authorization: `Bearer ${token}`, 'Sec-Fetch-Site': 'same-origin' } })
  assert.equal(setup.status, 200)
  assert.equal((await setup.json()).extensionPath, extensionPath)
  assert.equal((await fetch(`${url.origin}/connect`)).status, 200)
  const transfer = call('/v1/source', { method: 'POST', body: JSON.stringify({ cookies: [sample, null], history: [] }) })
  for (let i = 0; i < 50 && bridge.status().phase !== 'importing'; i++) await new Promise(r => setTimeout(r, 5))
  assert.equal(bridge.status().phase, 'importing')
  bridge.cancel()
  assert.equal(bridge.status().phase, 'importing', '写入开始后不假装撤销')
  assert.equal((await call('/v1/failure', { method: 'POST', body: JSON.stringify({ reason: 'connection_failed' }) })).status, 409)
  assert.equal(bridge.status().phase, 'importing', '迟到的连接错误不覆盖进行中的写入')
  assert.equal((await call('/v1/source', { method: 'POST', body: JSON.stringify({ cookies: [sample] }) })).status, 409)
  release()
  assert.deepEqual(await (await transfer).json(), { copied: 1, failed: 0, skipped: 1 })
  assert.equal(received, 1)
  assert.equal(bridge.status().phase, 'done')
  assert.equal(JSON.stringify(bridge.status()).includes('test-only'), false)
} finally { release(); bridge.cancel() }

for (const failure of ['invalid_payload', 'read_failed', 'import_failed']) {
  const failedBridge = await createCookieBridge({ extensionPath, showExtension: async () => {}, receive: async () => { throw new Error('fixture-private-cookie-value') } })
  const target = new URL(failedBridge.url)
  const auth = `Bearer ${target.hash.slice(1).split('.')[1]}`
  const path = failure === 'read_failed' ? '/v1/failure' : '/v1/source'
  const body = failure === 'invalid_payload' ? {} : failure === 'read_failed' ? { reason: 'read_failed', message: 'fixture-private-cookie-value' } : { cookies: [sample] }
  const failureHeaders = failure === 'read_failed'
    ? { Authorization: auth, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }
    : { ...headers, Authorization: auth }
  try {
    const response = await fetch(`${target.origin}${path}`, { method: 'POST', headers: failureHeaders, body: JSON.stringify(body) })
    assert.equal(response.status, failure === 'read_failed' ? 200 : failure === 'invalid_payload' ? 400 : 500)
    assert.equal(failedBridge.status().phase, 'failed', '来源和写入失败都结束等待')
    assert.equal(failedBridge.status().error, failure)
    assert.equal(JSON.stringify(failedBridge.status()).includes('fixture-private-cookie-value'), false)
    assert.equal((await response.text()).includes('fixture-private-cookie-value'), false)
  } finally { failedBridge.cancel() }
}

const cancelled = await createCookieBridge({ extensionPath, showExtension: async () => {}, receive: async () => { throw new Error('must not read') } })
cancelled.cancel()
assert.equal(cancelled.status().phase, 'cancelled')
const expired = await createCookieBridge({ extensionPath, showExtension: async () => {}, receive: async () => { throw new Error('must not read') }, timeoutMs: 20 })
await new Promise(r => setTimeout(r, 35))
assert.equal(expired.status().phase, 'cancelled')

const source = await readFile(`${extensionPath}/import.js`, 'utf8')
let reads = 0
const requests = []
const node = { textContent: '' }
const context = {
  location: { hash: `#12345.${'a'.repeat(64)}`, pathname: '/import.html' }, history: { replaceState() {} }, navigator: { userAgent: 'Chrome fixture' },
  document: { getElementById: () => node }, AbortSignal, URL, Date, console,
  chrome: { cookies: { getAll: async () => { reads++; return [sample] } } },
  fetch: async (target, options) => { requests.push({ target, options }); return { ok: true, json: async () => target.endsWith('/v1/status') ? { sourceNeeded: true } : { copied: 1, failed: 0, skipped: 0 } } }
}
context.window = context.parent = context
runInNewContext(source, context)
await new Promise(setImmediate)
assert.equal(reads, 2)
assert.equal(requests.length, 2)
assert.equal(JSON.parse(requests[1].options.body).cookies.length, 1, '重复枚举不重复导入')
assert.equal(JSON.parse(requests[1].options.body).cookies[0].httpOnly, true)
assert.equal(node.textContent.includes('test-only'), false)
context.location.hash = ''
reads = 0
runInNewContext(source, { ...context })
await Promise.resolve()
assert.equal(reads, 0, '无一次性配对不读取 Cookie')
const failedMessages = []
const failedNode = { textContent: '' }
const failedContext = {
  ...context, location: { hash: `#12345.${'a'.repeat(64)}`, pathname: '/import.html' },
  document: { getElementById: () => failedNode },
  chrome: { cookies: { getAll: async () => { throw new Error('fixture-private-cookie-value') } } },
  parent: { postMessage: message => failedMessages.push(message) }
}
failedContext.window = failedContext
runInNewContext(source, failedContext)
await new Promise(setImmediate)
assert.equal(failedMessages.at(-1).phase, 'failed')
assert.equal(failedMessages.at(-1).reason, 'read_failed')
assert.equal(JSON.stringify(failedMessages).includes('fixture-private-cookie-value'), false)
assert.equal(failedNode.textContent.includes('fixture-private-cookie-value'), false)
assert.match(failedNode.textContent, /权限/)

const connectSource = await readFile(`${extensionPath}/connect.js`, 'utf8')
const nodes = Object.fromEntries(['bridge', 'setup', 'status', 'folder', 'retry', 'path'].map(id => [id, { hidden: true, textContent: '', contentWindow: {}, addEventListener(type, handler) { this[type] = handler } }]))
const connectRequests = []
let onMessage
let timeoutId = 0
const timers = new Map()
runInNewContext(connectSource, {
  location: { hash: `#12345.${'b'.repeat(64)}`, pathname: '/connect' },
  history: { replaceState() {} },
  document: { getElementById: id => nodes[id] },
  window: { addEventListener: (type, handler) => { if (type === 'message') onMessage = handler } },
  fetch: async (path, options) => { connectRequests.push({ path, options }); return { ok: true, json: async () => ({ extensionPath: 'fixture-extension-directory' }) } },
  setTimeout: callback => { timers.set(++timeoutId, callback); return timeoutId },
  clearTimeout: id => timers.delete(id)
})
await new Promise(setImmediate)
assert.equal(nodes.bridge.hidden, true, '探测扩展时不显示可能加载失败的 iframe')
for (const callback of timers.values()) callback()
assert.equal(nodes.setup.hidden, false, '扩展未连接时显示安装指引')
assert.equal(nodes.bridge.hidden, true, '未连接时始终隐藏灰色坏页')
assert.match(nodes.status.textContent, /尚未连接/)
onMessage({ origin: 'https://other.test', source: nodes.bridge.contentWindow, data: { type: 'inkstone-import' } })
assert.equal(nodes.bridge.hidden, true, '不信任其他来源的连接信号')
onMessage({ origin: COOKIE_BRIDGE_ORIGIN, source: {}, data: { type: 'inkstone-import' } })
assert.equal(nodes.bridge.hidden, true, '不信任其他窗口的连接信号')
onMessage({ origin: COOKIE_BRIDGE_ORIGIN, source: nodes.bridge.contentWindow, data: { type: 'inkstone-import' } })
assert.equal(nodes.bridge.hidden, false, '真实扩展握手后才显示结果区域')
assert.equal(nodes.setup.hidden, true)
assert.equal(nodes.status.textContent, '')
for (const callback of timers.values()) callback()
assert.equal(nodes.setup.hidden, true, '握手后旧定时器不会重新显示安装提示')
onMessage({ origin: COOKIE_BRIDGE_ORIGIN, source: nodes.bridge.contentWindow, data: { type: 'inkstone-import', phase: 'failed', reason: 'read_failed', message: 'fixture-private-cookie-value' } })
await new Promise(setImmediate)
assert.equal(connectRequests.at(-1).path, '/v1/failure')
assert.deepEqual(JSON.parse(connectRequests.at(-1).options.body), { reason: 'read_failed' }, '失败反馈只传安全错误码')
nodes.retry.click()
assert.equal(nodes.bridge.hidden, true, '重试仍不显示尚未连接的 iframe')

const ffRoot = await mkdtemp(join(tmpdir(), 'inkstone-ff-test-'))
try {
  const defaultDir = join(ffRoot, 'Profiles', 'abc123.default-release')
  const workDir = join(ffRoot, 'Profiles', 'def456.work')
  const emptyDir = join(ffRoot, 'Profiles', 'ghi789.empty')
  await mkdir(defaultDir, { recursive: true })
  await mkdir(workDir, { recursive: true })
  await mkdir(emptyDir, { recursive: true })
  await writeFile(join(ffRoot, 'installs.ini'), '[INST1]\nDefault=Profiles/def456.work\nLocked=1\n')
  await writeFile(join(ffRoot, 'profiles.ini'), [
    '[Profile0]',
    'Name=default-release',
    'IsRelative=1',
    'Path=Profiles/abc123.default-release',
    'Default=1',
    '',
    '[Profile1]',
    'Name=work',
    'IsRelative=1',
    'Path=Profiles/def456.work',
    '',
    '[Profile2]',
    'Name=empty',
    'IsRelative=1',
    'Path=Profiles/ghi789.empty'
  ].join('\n'))

  const makeCookiesDb = (dir, withWal) => {
    const db = new DatabaseSync(join(dir, 'cookies.sqlite'))
    if (withWal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;')
    db.exec(`CREATE TABLE moz_cookies (
      id INTEGER PRIMARY KEY,
      originAttributes TEXT NOT NULL DEFAULT '',
      name TEXT,
      value TEXT,
      host TEXT,
      path TEXT,
      expiry INTEGER,
      lastAccessed INTEGER,
      creationTime INTEGER,
      isSecure INTEGER,
      isHttpOnly INTEGER,
      sameSite INTEGER
    )`)
    const nowSec = Math.floor(Date.now() / 1000)
    const stmt = db.prepare('INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, lastAccessed, creationTime, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    stmt.run('', 'sid', 'v-host', 'example.test', '/', nowSec + 3600, 100, 100, 1, 1, 1)
    stmt.run('', 'dom_ms', 'v-ms', '.example.test', '/app', (nowSec + 7200) * 1000, 200, 200, 1, 0, 0)
    stmt.run('', 'none_insecure', 'v-none', 'example.test', '/', 0, 300, 300, 0, 0, 0)
    stmt.run('^partitionKey=(https,top.test)', 'part', 'v-part', 'embed.test', '/', nowSec + 3600, 400, 400, 1, 1, 2)
    stmt.run('^userContextId=2', 'container_tok', 'v-skip', 'example.test', '/', nowSec + 3600, 500, 500, 1, 1, 1)
    stmt.run('^privateBrowsingId=1', 'priv_tok', 'v-priv', 'example.test', '/', nowSec + 3600, 600, 600, 1, 1, 1)
    stmt.run('', 'expired_tok', 'v-old', 'example.test', '/', 1000, 50, 50, 1, 1, 1)
    return db
  }

  const dbDefault = makeCookiesDb(defaultDir, false)
  dbDefault.close()
  const dbWork = makeCookiesDb(workDir, true)
  try {
    const discovered = discoverFirefoxProfiles({ env: { YAN_FIREFOX_PROFILES_DIR: ffRoot } })
    assert.equal(discovered.length, 2, '只列出含 cookies.sqlite 的 Firefox 档案')
    assert.equal(discovered[0].name, 'work', 'installs.ini 的默认档案优先排第一')
    assert.equal(discovered[0].isDefault, true)
    assert.equal(discovered[1].isDefault, false)
    assert.equal(listFirefoxProfiles({ env: { YAN_FIREFOX_PROFILES_DIR: ffRoot } }).every((p) => !('dir' in p) && p.id.startsWith('ff-')), true, '对外档案列表不泄露本地绝对路径')

    const parsedAttrs = parseFirefoxOriginAttributes('^partitionKey=(https,top.test,8443)', 'sub.top.test')
    assert.deepEqual(parsedAttrs, { skip: false, partitionKey: { topLevelSite: 'https://top.test:8443', hasCrossSiteAncestor: false } })
    assert.equal(parseFirefoxOriginAttributes('^userContextId=1', 'example.test').skip, true)

    const extracted = await readFirefoxCookies(workDir)
    assert.equal(extracted.cookies.length, 4, 'WAL 未 checkpoint 时仍完整读出 4 条有效 Cookie')
    assert.equal(extracted.skipped, 3, '跳过容器、隐私和过期共 3 条 Cookie')
    const byName = Object.fromEntries(extracted.cookies.map((c) => [c.name, c]))
    assert.equal(byName.sid.hostOnly, true)
    assert.equal(byName.sid.sameSite, 'lax')
    assert.equal(byName.dom_ms.hostOnly, false)
    assert.equal(byName.dom_ms.sameSite, 'no_restriction')
    assert.ok(byName.dom_ms.expirationDate < 1e11, 'Firefox 106+ 毫秒级 expiry 自动转换为秒')
    assert.equal(byName.none_insecure.session, true)
    assert.equal(byName.none_insecure.sameSite, 'unspecified', '非 Secure 的 SameSite=None 回退 unspecified 避免 Chromium 拒收')
    assert.deepEqual(byName.part.partitionKey, { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true })
    assert.equal(byName.part.sameSite, 'strict')
  } finally {
    dbWork.close()
  }

  let ffCalledWith = null
  const ffBridge = await createCookieBridge({
    extensionPath,
    showExtension: async () => {},
    receive: async () => ({ copied: 0, failed: 0, skipped: 0 }),
    firefoxProfiles: () => listFirefoxProfiles({ env: { YAN_FIREFOX_PROFILES_DIR: ffRoot } }),
    importFirefox: async (profileId) => { ffCalledWith = profileId; return { copied: 4, failed: 0, skipped: 3 } }
  })
  try {
    const ffUrl = new URL(ffBridge.url)
    const ffToken = ffUrl.hash.slice(1).split('.')[1]
    const setupRes = await fetch(`${ffUrl.origin}/v1/setup`, { headers: { Authorization: `Bearer ${ffToken}`, 'Sec-Fetch-Site': 'same-origin' } })
    const setupJson = await setupRes.json()
    assert.equal(setupJson.firefoxProfiles.length, 2, '/v1/setup 返回 Firefox 档案列表')
    const evilRes = await fetch(`${ffUrl.origin}/v1/import-firefox`, { method: 'POST', headers: { Origin: 'https://evil.test', Authorization: `Bearer ${ffToken}`, 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(evilRes.status, 403, '跨站 Origin 不能触发 Firefox 导入')
    const okRes = await fetch(`${ffUrl.origin}/v1/import-firefox`, { method: 'POST', headers: { Origin: ffUrl.origin, Authorization: `Bearer ${ffToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: setupJson.firefoxProfiles[0].id }) })
    assert.equal(okRes.status, 200)
    assert.deepEqual(await okRes.json(), { copied: 4, failed: 0, skipped: 3 })
    assert.equal(ffCalledWith, setupJson.firefoxProfiles[0].id)
    assert.equal(ffBridge.status().phase, 'done')
  } finally { ffBridge.cancel() }

  const ffNodes = Object.fromEntries(['bridge', 'setup', 'status', 'folder', 'retry', 'path', 'firefox', 'ff-profile', 'ff-import'].map(id => [id, {
    hidden: true, disabled: false, value: '', textContent: '', options: [],
    appendChild(child) { this.options.push(child); if (!this.value) this.value = child.value },
    addEventListener(type, handler) { this[type] = handler }
  }]))
  const ffConnectReqs = []
  runInNewContext(connectSource, {
    location: { hash: `#12345.${'c'.repeat(64)}`, pathname: '/connect' },
    history: { replaceState() {} },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0' },
    document: {
      getElementById: id => ffNodes[id],
      createElement: () => ({ value: '', textContent: '' })
    },
    window: { addEventListener() {} },
    fetch: async (path, options) => {
      ffConnectReqs.push({ path, options })
      if (path === '/v1/setup') return { ok: true, json: async () => ({ extensionPath: 'ext', firefoxProfiles: [{ id: 'ff-1', name: 'default-release', isDefault: true }] }) }
      return { ok: true, json: async () => ({ copied: 4, failed: 0, skipped: 1 }) }
    },
    setTimeout: () => 1,
    clearTimeout: () => {}
  })
  await new Promise(setImmediate)
  assert.equal(ffNodes.firefox.hidden, false, 'Firefox 打开 /connect 时直接展示 Firefox 直导区块')
  assert.equal(ffNodes.setup.hidden, true, 'Firefox 打开 /connect 时不误展示 Chrome 扩展指引')
  assert.equal(ffNodes['ff-profile'].options.length, 1)
  await ffNodes['ff-import'].click()
  await new Promise(setImmediate)
  assert.equal(ffConnectReqs.at(-1).path, '/v1/import-firefox')
  assert.match(ffNodes.status.textContent, /已导入 4 条 Cookie/)
} finally {
  await rm(ffRoot, { recursive: true, force: true })
}

console.log('test-cookie-bridge: 认证、字段映射、一次性导入、取消、过期、扩展触发、首次连接提示与 Firefox 直导全部通过')
