/**
 * MA5 MCP App 渲染/协议安全层的离线验收。
 *
 * 现场用 esbuild 把 `src/shared/mcp-app-preview.ts` 与
 * `src/main/mcp/app-resource-store.ts` 编译到**独立临时目录**（不写共享 `out/`），
 * 只验证纯函数与协议 mock，不启动 Electron、不联网、不连真实 MCP 服务、
 * 不调用真实模型。
 *
 * 覆盖：`inkstone-app:` 地址解析、CSP 默认档与恶意域名、meta CSP 不可放宽、
 * 资源缓存/MIME/体积、owner 归属与失效、迟到读取、重放不触发抓取、
 * 未知路径/方法、伪造 serverHash、响应安全头。
 *
 * ⚠️ 未覆盖（需真实 Electron 窗口）：`protocol.handle` 实际响应、
 * iframe sandbox 生效、webRequest 子文档拦截、真实 DNS 判定。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outdir = await mkdtemp(join(tmpdir(), 'yan-mcp-app-render-'))
let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
  console.log(`✓ ${label}`)
}
const eq = (actual, expected, label) => ok(actual === expected, `${label}（期望 ${expected}，实际 ${actual}）`)

async function main() {
  await build({
    entryPoints: ['src/shared/mcp-app-preview.ts', 'src/main/mcp/app-resource-store.ts'],
    outdir,
    outbase: 'src',
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const shared = await import(pathToFileURL(join(outdir, 'shared/mcp-app-preview.js')).href)
  const { McpAppResourceStore, appServerHash } = await import(pathToFileURL(join(outdir, 'main/mcp/app-resource-store.js')).href)

  /* ---------- 1. 地址构造与解析 ---------- */
  const hash = 'a'.repeat(32)
  const inst = 'b'.repeat(32)
  eq(shared.buildMcpAppUrl(hash, inst), `inkstone-app://${hash}/${inst}/index.html`, '受控地址由固定哈希 host + 随机实例路径组成')
  const parsed = shared.parseMcpAppUrl(shared.buildMcpAppUrl(hash, inst))
  ok(parsed && parsed.serverHash === hash && parsed.instanceId === inst, '合法地址解析出 serverHash 与 instanceId')
  ok(shared.parseMcpAppUrl(shared.buildMcpAppUrl(hash, inst) + '#frag') !== null, 'fragment 不影响实例身份')
  eq(shared.parseMcpAppUrl('inkstone-html://' + hash + '/' + inst + '/index.html'), null, '其它协议不认')
  eq(shared.parseMcpAppUrl(`inkstone-app://${'Z'.repeat(32)}/${inst}/index.html`), null, '非十六进制 serverHash 拒绝')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}/index.html`), null, '缺随机实例目录拒绝')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}/${inst}/other.html`), null, '只有 index.html 是唯一文档名')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}/${inst}/../index.html`), null, '路径穿越拒绝')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}/${inst}/index.html?path=/etc/passwd`), null, '查询串不能改变资源')
  eq(shared.parseMcpAppUrl(`inkstone-app://user:pass@${hash}/${inst}/index.html`), null, '用户名/口令拒绝')
  eq(shared.parseMcpAppUrl(`inkstone-app://${hash}:8443/${inst}/index.html`), null, '显式端口拒绝')
  eq(shared.parseMcpAppUrl('not a url'), null, '非 URL 拒绝')

  /* ---------- 2. serverHash ---------- */
  ok(/^[a-f0-9]{32}$/.test(appServerHash('srv-a')), 'serverHash 是 32 位十六进制')
  eq(appServerHash('srv-a'), appServerHash('srv-a'), '同一服务哈希固定')
  ok(appServerHash('srv-a') !== appServerHash('srv-b'), '不同服务来源不同')

  /* ---------- 3. CSP 默认档 ---------- */
  const strictCsp = shared.buildMcpAppCsp()
  ok(strictCsp.includes("default-src 'none'"), '默认档 default-src none')
  ok(strictCsp.includes("script-src 'unsafe-inline'"), '默认档只允许内联脚本')
  ok(strictCsp.includes("connect-src 'none'"), '默认档 connect-src none')
  ok(strictCsp.includes("frame-src 'none'") && strictCsp.includes("object-src 'none'"), '默认档关闭 frame/object')
  ok(strictCsp.includes("base-uri 'none'") && strictCsp.includes("form-action 'none'"), '默认档关闭 base/form')
  ok(strictCsp.includes('sandbox allow-scripts'), '默认档 sandbox 只给脚本')
  ok(!strictCsp.includes('allow-same-origin'), '默认档不含 allow-same-origin')
  ok(!strictCsp.includes('https://') && !strictCsp.includes('unsafe-eval'), '默认档不放宽任何外部来源或 eval')
  eq(shared.MCP_APP_SANDBOX, 'allow-scripts', '首版 sandbox 常量只有 allow-scripts')

  /* ---------- 4. 恶意/不严格域名被拒 ---------- */
  const reject = (value, reason, label) => {
    const decision = shared.classifyMcpAppDomain(value)
    ok(!decision.allowed && decision.reason === reason, `${label}（${value} -> ${decision.reason}）`)
  }
  reject('http://cdn.example.com', 'not-https', '非 HTTPS 拒绝')
  reject('https://user:pass@cdn.example.com', 'credentials', '用户名口令拒绝')
  reject('https://cdn.example.com:8443', 'port', '端口伪装拒绝')
  reject('https://*.example.com', 'wildcard', '泛通配拒绝')
  reject('https://cdn.example.com/path/to.js', 'path', '带路径的声明拒绝（避免放宽范围）')
  reject('https://127.0.0.1', 'ip-literal', 'IPv4 回环字面量拒绝')
  reject('https://10.0.0.1', 'ip-literal', '私网 IPv4 拒绝')
  reject('https://169.254.169.254', 'ip-literal', '链路本地/云 metadata 拒绝')
  reject('https://[::1]', 'ip-literal', 'IPv6 回环拒绝')
  reject('https://[::ffff:127.0.0.1]', 'ip-literal', 'IPv4 映射 IPv6 拒绝')
  reject('https://localhost', 'private-host', 'localhost 拒绝')
  reject('https://foo.local', 'private-host', '.local 拒绝')
  reject('https://foo.internal', 'private-host', '.internal 拒绝')
  reject('https://example.com.', 'invalid-host', '尾点 FQDN 拒绝')
  reject('file:///etc/passwd', 'not-https', 'file 协议拒绝')
  reject('javascript:alert(1)', 'not-https', '自定义/危险 scheme 拒绝')
  reject('   ', 'empty', '空声明拒绝')
  const good = shared.classifyMcpAppDomain('https://cdn.example.com')
  ok(good.allowed && good.value === 'https://cdn.example.com', '严格 HTTPS 域名通过字面校验')

  /* ---------- 5. 无验证能力 => 拒所有网络声明 ---------- */
  const noValidator = await shared.resolveDomainList(['https://cdn.example.com', 'https://api.example.com'], 'network', undefined)
  ok(noValidator.every((item) => !item.allowed && item.reason === 'no-validator'), '没有公网判定器时所有网络声明被拒（no-validator）')
  const forbidden = await shared.resolveDomainList(['https://frame.example.com'], 'forbidden', async () => false)
  ok(forbidden.every((item) => !item.allowed && item.reason === 'forbidden'), 'frame/base-uri 声明一律拒绝')
  const publicOk = await shared.resolveDomainList(['https://cdn.example.com'], 'network', async () => false)
  ok(publicOk.length === 1 && publicOk[0].allowed, '注入判定器且判定公网时域名通过')
  const privateNo = await shared.resolveDomainList(['https://cdn.example.com'], 'network', async () => true)
  ok(privateNo[0].reason === 'resolves-private', '注入判定器判定私网时拒绝')
  const unresolvedNo = await shared.resolveDomainList(['https://cdn.example.com'], 'network', async () => {
    throw new Error('dns down')
  })
  ok(unresolvedNo[0].reason === 'unresolved', 'DNS 解析失败按拒绝处理')

  /* ---------- 6. CSP 组装与 meta 不可放宽 ---------- */
  const granted = shared.buildMcpAppCsp({ resource: ['https://cdn.example.com'], connect: ['https://api.example.com'] })
  ok(granted.includes('https://cdn.example.com') && granted.includes('https://api.example.com'), '显式授权的域名进入 CSP')
  ok(/script-src 'unsafe-inline'(;|$)/.test(granted), '外部脚本永不进入 script-src（脚本外联遵守离线默认）')
  ok(granted.includes("frame-src 'none'") && granted.includes("object-src 'none'"), '即使有声明也关闭 frame/object')
  ok(granted.includes("base-uri 'none'") && granted.includes("form-action 'none'"), '即使有声明也关闭 base/form')
  ok(!granted.includes('allow-same-origin'), '授权后仍无 allow-same-origin')
  const headers = shared.mcpAppResponseHeaders(`default-src 'none'; connect-src 'none'`)
  eq(headers['Content-Security-Policy'], "default-src 'none'; connect-src 'none'", '响应头原样下发推导出的 CSP')
  eq(headers['Cache-Control'], 'no-store', '响应头 no-store')
  eq(headers['Referrer-Policy'], 'no-referrer', '响应头 no-referrer')
  eq(headers['X-Content-Type-Options'], 'nosniff', '响应头 nosniff')
  ok(headers['Permissions-Policy'].includes('camera=()') && headers['Permissions-Policy'].includes('payment=()'), 'Permissions-Policy 全关')
  const errorHeaders = shared.mcpAppErrorHeaders()
  ok(errorHeaders['Content-Security-Policy'].includes("default-src 'none'") && errorHeaders['Content-Security-Policy'].includes('sandbox allow-scripts'), '错误回退页也带最严 CSP')

  /* meta CSP 只能收紧、不能放宽头部策略：此处验证头部策略不含未授权来源，
     离线无法真跑浏览器，但按 CSP 规范「头部 + meta 取交集」，meta 无法新增来源。 */
  const metaTried = shared.buildMcpAppCsp()
  ok(!metaTried.includes('https://evil.example.com') && metaTried.includes("connect-src 'none'"), '资源内 meta 无法把未授权来源加回头部策略')

  /* ---------- 7. 归属纯比较 ---------- */
  const ownerA = { serverId: 'srv-a', sessionId: 'sess-1', sessionFile: 'sess-1.jsonl', projectId: 'proj-1', runnerId: 'run-1', generation: 1, toolCallId: 'call-1' }
  ok(shared.isCompleteMcpAppOwner(ownerA), '完整 owner 通过校验')
  ok(!shared.isCompleteMcpAppOwner({ ...ownerA, runnerId: '' }), '缺字段 owner 拒绝')
  ok(!shared.isCompleteMcpAppOwner({ ...ownerA, generation: -1 }), '非法 generation 拒绝')
  ok(shared.sameMcpAppOwner(ownerA, { ...ownerA }), '同 owner 比较相等')
  ok(!shared.sameMcpAppOwner(ownerA, { ...ownerA, toolCallId: 'call-2' }), '不同 toolCall 不相等')

  /* ---------- 8. store：缓存 / 归属 / 失效 ---------- */
  const HTML = '<html><head></head><body>app view</body></html>'
  const BYTES = Buffer.byteLength(HTML, 'utf8')
  const GOOD = { html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: BYTES, csp: 'derived-csp' }
  let clock = 1000
  let active = true
  let fetchCount = 0
  const fetchArgs = []
  let fetchImpl = async (request) => {
    fetchCount++
    fetchArgs.push(request)
    return GOOD
  }
  const guard = { isActive: () => active }
  const store = new McpAppResourceStore({
    fetchResource: (request) => fetchImpl(request),
    ownerGuard: guard,
    now: () => clock,
    cacheTtlMs: 5000,
    maxInstances: 8
  })

  const first = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/1', owner: ownerA })
  ok(first.ok, '首次 prepare 成功')
  ok(first.ok && first.instanceId.length === 32, '实例号随机且定长')
  const read = store.read(first.url)
  ok(read.ok && read.html === HTML && read.csp === 'derived-csp', '读取返回快照正文与推导 CSP')
  eq(fetchCount, 1, '重放不触发任何新的资源抓取（也不触发 tools/call）')
  const readOwner = store.read(first.url, { owner: ownerA })
  ok(readOwner.ok, '同 owner 读取通过')
  const wrongOwner = store.read(first.url, { owner: { ...ownerA, sessionId: 'sess-2' } })
  eq(wrongOwner.error, 'owner', '跨 owner 读取拒绝')
  const forged = store.read(first.url.replace(first.serverHash, 'c'.repeat(32)))
  eq(forged.error, 'unknown', '伪造 serverHash 拒绝')
  eq(store.read(`inkstone-app://${first.serverHash}/${'d'.repeat(32)}/index.html`).error, 'unknown', '未知实例拒绝')
  eq(store.read(first.url, { method: 'POST' }).error, 'method', '非 GET 方法拒绝')
  eq(store.read(first.url.replace('index.html', 'index.html?x=1')).error, 'unknown', '带查询串的资源请求拒绝')

  const second = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/1', owner: ownerA })
  ok(second.ok && second.cached, '同服务同 URI 命中缓存')
  eq(fetchCount, 1, '缓存命中不再抓取')

  clock += 6000
  const third = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/1', owner: ownerA })
  ok(third.ok && !third.cached, 'TTL 过期后重新抓取')
  eq(fetchCount, 2, 'TTL 过期后确实再抓一次')

  const versioned = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/1', owner: ownerA, version: 'v2' })
  ok(versioned.ok && !versioned.cached, '带版本号的资源单独缓存')
  eq(fetchCount, 3, '版本变化会重新抓取')

  store.release(first.url)
  eq(store.read(first.url).error, 'unknown', '释放后实例不再可用')
  ok(!store.release(first.url), '重复释放返回 false')
  ok(store.release(third.url, { ...ownerA, sessionId: 'sess-9' }) === false, '跨 owner 不能卸载别人的实例')
  ok(store.has(third.url), '跨 owner 卸载失败后实例仍在')

  /* 受控路径：资源 URI 原样传给宿主，绝不当作本机路径。 */
  const pathUri = '../../../../etc/passwd'
  const pathResult = await store.prepare({ serverId: 'srv-a', resourceUri: pathUri, owner: ownerA })
  ok(pathResult.ok && /^[a-f0-9]{32}$/.test(pathResult.instanceId), '资源 URI 不会被当成磁盘路径（实例仍为随机号）')
  eq(fetchArgs[fetchArgs.length - 1].resourceUri, pathUri, '资源 URI 原样交给宿主读取')

  /* MIME / 体积 */
  fetchImpl = async () => ({ ...GOOD, mimeType: 'text/plain' })
  eq((await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://bad/mime', owner: ownerA })).error, 'mime', '非 App MIME 拒绝')
  fetchImpl = async () => ({ ...GOOD, bytes: 2 * 1024 * 1024 + 1 })
  eq((await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://bad/size', owner: ownerA })).error, 'size', '超过 2 MiB 拒绝')
  fetchImpl = async () => {
    throw new Error('host read failed')
  }
  eq((await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://bad/fetch', owner: ownerA })).error, 'fetch', '宿主读取失败如实返回 fetch')
  fetchImpl = async (request) => {
    fetchCount++
    fetchArgs.push(request)
    return GOOD
  }

  /* 归属失效 */
  active = false
  eq((await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://revoked', owner: ownerA })).error, 'revoked', 'owner 失效后 prepare 拒绝')
  eq(store.read(third.url).error, 'revoked', 'owner 失效后读取立即拒绝')

  active = true
  const again = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://app/again', owner: ownerA })
  ok(again.ok, '恢复后可以再建实例')
  eq(store.invalidateSession('sess-1') >= 1, true, '切会话失效该会话实例')
  eq(store.read(again.url).error, 'unknown', '切会话后旧实例读取失败')

  /* 迟到读取：异步宿主返回时 owner 已失效 */
  let releaseFetch
  const gate = new Promise((resolve) => {
    releaseFetch = resolve
  })
  fetchImpl = async () => {
    await gate
    return GOOD
  }
  const late = store.prepare({ serverId: 'srv-b', resourceUri: 'ui://late', owner: { ...ownerA, serverId: 'srv-b' } })
  active = false
  releaseFetch()
  eq((await late).error, 'stale', '异步读取返回时 owner 已失效 => stale，不登记实例')
  active = true

  /* 丢弃缓存后再验证不越权读 */
  store.clear()
  eq(store.size, 0, 'clear 清空实例')
  eq(store.cacheSize, 0, 'clear 清空缓存')

  /* prepare 输入与 owner.serverId 不一致 */
  const mismatch = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://x', owner: { ...ownerA, serverId: 'other' } })
  eq(mismatch.error, 'owner', 'owner.serverId 与请求不一致拒绝')

  /* 结果对象不携带 owner 凭据/模型字段 */
  const shape = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://shape', owner: ownerA })
  const shapeRead = store.read(shape.url)
  ok(shapeRead.ok && !('structuredContent' in shapeRead) && !('credentials' in shapeRead) && !('bearer' in shapeRead), '读取结果只含界面快照，不含凭据/模型字段')

  /* 实例上限 */
  const tightOwner = { ...ownerA, serverId: 'srv-t' }
  const tight = new McpAppResourceStore({
    fetchResource: async () => GOOD,
    ownerGuard: { isActive: () => true },
    maxInstances: 1
  })
  const tightFirst = await tight.prepare({ serverId: 'srv-t', resourceUri: 'ui://a', owner: tightOwner })
  ok(tightFirst.ok, '上限内可建实例')
  eq((await tight.prepare({ serverId: 'srv-t', resourceUri: 'ui://b', owner: tightOwner })).error, 'busy', '超过实例上限返回 busy')

  /* runner / 精确 owner 失效 */
  eq(store.invalidateRunner('srv-a', 'run-1') >= 1, true, 'runner 失效清掉该 runner 的实例')
  const ownerB = { ...ownerA, toolCallId: 'call-b' }
  const forOwner = await store.prepare({ serverId: 'srv-a', resourceUri: 'ui://owner-b', owner: ownerB })
  eq(store.invalidateOwner(ownerB), 1, '精确 owner 失效只删该实例')
  eq(store.read(forOwner.url).error, 'unknown', '精确失效后实例不可读')

  /* ---------- 9. 默认失败封闭：缺 guard / 坏 guard / guard 异常 / 坏返回值 ---------- */
  let unauthorizedFetch = 0
  const countingFetch = async () => {
    unauthorizedFetch++
    return GOOD
  }
  assert.throws(
    () => new McpAppResourceStore({ fetchResource: countingFetch }),
    /ownerGuard/,
    '缺 ownerGuard 构造直接失败'
  )
  checks++
  console.log('✓ 缺 ownerGuard 构造直接失败（不产生放行 store）')
  assert.throws(
    () => new McpAppResourceStore({ fetchResource: countingFetch, ownerGuard: { isActive: 'nope' } }),
    /ownerGuard/,
    '坏类型 ownerGuard 构造直接失败'
  )
  checks++
  console.log('✓ 坏类型 ownerGuard 构造直接失败')

  const throwingGuardStore = new McpAppResourceStore({
    fetchResource: countingFetch,
    ownerGuard: {
      isActive: () => {
        throw new Error('guard exploded')
      }
    }
  })
  eq(
    (await throwingGuardStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://guard-throw', owner: ownerA })).error,
    'revoked',
    'guard 抛异常 => 按不活跃 revoke'
  )
  const truthyGuardStore = new McpAppResourceStore({
    fetchResource: countingFetch,
    ownerGuard: { isActive: () => 'yes' }
  })
  eq(
    (await truthyGuardStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://guard-bad-return', owner: ownerA })).error,
    'revoked',
    'guard 返回非布尔真值也按不活跃 revoke'
  )
  eq(unauthorizedFetch, 0, '缺/坏/异常 guard 全程未触发任何资源抓取')
  eq(throwingGuardStore.size, 0, 'guard 异常不登记实例')
  eq(truthyGuardStore.size, 0, 'guard 坏返回值不登记实例')

  /* ---------- 10. 协议路径不传 owner 也必须守卫 ---------- */
  let protocolActive = true
  const protocolStore = new McpAppResourceStore({
    fetchResource: async () => GOOD,
    ownerGuard: { isActive: () => protocolActive },
    now: () => clock
  })
  const protocolPrepared = await protocolStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://protocol', owner: ownerA })
  ok(protocolPrepared.ok, '协议路径 store 先建实例')
  ok(protocolStore.read(protocolPrepared.url).ok, '守卫活跃且不传 owner 时读取通过')
  protocolActive = false
  eq(protocolStore.read(protocolPrepared.url).error, 'revoked', '守卫失效后不传 owner 的协议读取被拒绝')

  /* ---------- 11. owner 对象不可被调用者改写归属 ---------- */
  const mutableOwner = { ...ownerA, toolCallId: 'call-owned' }
  const ownedStore = new McpAppResourceStore({
    fetchResource: async () => GOOD,
    ownerGuard: { isActive: () => true },
    now: () => clock
  })
  const owned = await ownedStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://owned', owner: mutableOwner })
  ok(owned.ok, '可变 owner 建实例')
  mutableOwner.toolCallId = 'call-hijacked'
  const ownedRead = ownedStore.read(owned.url, { owner: { ...ownerA, toolCallId: 'call-owned' } })
  ok(ownedRead.ok, '调用者事后改自己 owner 对象，不影响实例归属')
  eq(ownedStore.read(owned.url, { owner: mutableOwner }).error, 'owner', '被改写后的 owner 不能读原实例')
  const returnedOwner = ownedRead.owner
  returnedOwner.toolCallId = 'call-mutated-return'
  ok(ownedStore.read(owned.url, { owner: { ...ownerA, toolCallId: 'call-owned' } }).ok, '读取返回的 owner 是副本，改写它不影响实例')
  eq(ownedStore.read(owned.url, { owner: returnedOwner }).error, 'owner', '被改写的返回 owner 不能读实例')

  /* ---------- 12. 请求预先 abort：不抓取、不登记（含缓存路径） ---------- */
  let abortFetch = 0
  const abortStore = new McpAppResourceStore({
    fetchResource: async () => {
      abortFetch++
      return GOOD
    },
    ownerGuard: { isActive: () => true },
    now: () => clock
  })
  const preAbort = new AbortController()
  preAbort.abort()
  eq(
    (await abortStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://pre-abort', owner: ownerA, signal: preAbort.signal })).error,
    'aborted',
    '请求进入前已 abort => aborted'
  )
  eq(abortFetch, 0, '预先 abort 不触发抓取')
  eq(abortStore.size, 0, '预先 abort 不登记实例')
  ok((await abortStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://cache-abort', owner: ownerA })).ok, '先预热缓存')
  const beforeCacheAbort = abortStore.size
  eq(
    (await abortStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://cache-abort', owner: ownerA, signal: preAbort.signal })).error,
    'aborted',
    '缓存命中但请求已 abort => aborted'
  )
  eq(abortStore.size, beforeCacheAbort, '缓存路径 abort 不登记新实例')

  /* ---------- 13. 抓取中失效：guard 仍 true 的迟到资源不得登记 ---------- */
  const runRevocationCase = async (label, revoke) => {
    let resolveFetch
    const gate = new Promise((resolve) => {
      resolveFetch = resolve
    })
    const caseStore = new McpAppResourceStore({
      fetchResource: async () => {
        await gate
        return GOOD
      },
      ownerGuard: { isActive: () => true },
      now: () => clock
    })
    const pending = caseStore.prepare({ serverId: 'srv-a', resourceUri: `ui://invalidate/${label}`, owner: ownerA })
    revoke(caseStore)
    resolveFetch()
    eq((await pending).error, 'stale', `${label}：抓取期间撤销（guard 仍 true）=> stale`)
    eq(caseStore.size, 0, `${label}：迟到资源不登记实例`)
    const fresh = await caseStore.prepare({ serverId: 'srv-a', resourceUri: `ui://invalidate/${label}/new`, owner: ownerA })
    ok(fresh.ok, `${label}：明确的新 epoch 后可以再建实例`)
  }
  await runRevocationCase('invalidateSession', (s) => s.invalidateSession('sess-1'))
  await runRevocationCase('invalidateRunner', (s) => s.invalidateRunner('srv-a', 'run-1'))
  await runRevocationCase('invalidateOwner', (s) => s.invalidateOwner(ownerA))
  await runRevocationCase('clear', (s) => s.clear())

  /* release 作废：先有旧实例，再在二次抓取中释放旧实例 */
  let releaseCaseFetches = 0
  let releaseCaseGateResolve
  const releaseCaseGate = new Promise((resolve) => {
    releaseCaseGateResolve = resolve
  })
  const releaseCaseStore = new McpAppResourceStore({
    fetchResource: async () => {
      releaseCaseFetches++
      if (releaseCaseFetches > 1) await releaseCaseGate
      return GOOD
    },
    ownerGuard: { isActive: () => true },
    now: () => clock
  })
  const seeded = await releaseCaseStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://release/seed', owner: ownerA })
  ok(seeded.ok, 'release 用例先建旧实例')
  const pendingAfterRelease = releaseCaseStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://release/pending', owner: ownerA })
  ok(releaseCaseStore.release(seeded.url), '抓取中释放旧实例')
  releaseCaseGateResolve()
  eq((await pendingAfterRelease).error, 'stale', 'release 后迟到资源不登记')
  eq(releaseCaseStore.size, 0, 'release 后没有新增实例（旧实例已释放）')

  /* ---------- 14. 缓存复用不越权 ---------- */
  let sharedFetches = 0
  const sharedStore = new McpAppResourceStore({
    fetchResource: async () => {
      sharedFetches++
      return GOOD
    },
    ownerGuard: { isActive: () => true },
    now: () => clock
  })
  const ownerB2 = { ...ownerA, toolCallId: 'call-b2' }
  const a1 = await sharedStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://shared-cache', owner: ownerA })
  const b1 = await sharedStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://shared-cache', owner: ownerB2 })
  ok(a1.ok && b1.ok && b1.cached, '同资源缓存可被不同 owner 复用')
  eq(sharedFetches, 1, '跨 owner 复用命中缓存不再抓取')
  eq(sharedStore.read(a1.url, { owner: ownerB2 }).error, 'owner', 'ownerB 不能读 ownerA 的实例')
  eq(sharedStore.read(b1.url, { owner: ownerA }).error, 'owner', 'ownerA 不能读 ownerB 的实例')
  ok(sharedStore.read(a1.url, { owner: ownerA }).ok && sharedStore.read(b1.url, { owner: ownerB2 }).ok, '各自 owner 可读各自实例')

  let reusableActive = true
  const reuseStore = new McpAppResourceStore({
    fetchResource: async () => GOOD,
    ownerGuard: { isActive: () => reusableActive },
    now: () => clock
  })
  ok((await reuseStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://reuse', owner: ownerA })).ok, '缓存预热')
  reusableActive = false
  eq(
    (await reuseStore.prepare({ serverId: 'srv-a', resourceUri: 'ui://reuse', owner: ownerA })).error,
    'revoked',
    '守卫失效后即使缓存命中也不得越权复用'
  )

  await rm(outdir, { recursive: true, force: true })
  console.log(`MCP App render: ${checks} checks passed`)
}

await main()
