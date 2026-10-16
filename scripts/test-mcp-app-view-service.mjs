/**
 * A6 宿主视图桥（`McpAppViewService`）+ 持久审计的离线合成验收。
 *
 * 覆盖（全部用 fake host / fake proxy / 真实临时 JSONL，不启 Electron、不联网）：
 *   1. 同 owner 的 prepare / initialize / tools-call / audit 真实落盘、可读为步骤；
 *   2. 资源 fetch 用 owner.projectId（宿主事实），不从 server.projectScope 猜；
 *   3. 只读无 grant 要问（allow / deny / null 三路）；破坏 / 未知逐次问由审批层保证；
 *   4. visibility 拒绝也落审计；all 档不拦截但真实写审计；
 *   5. schema 不符 / 未知工具拒绝；跨 owner / 跨 server / 重放 id 拒绝；
 *   6. 切会话时等待审批 → 作废；调用迟到 → 丢弃且不落“完成”；
 *   7. release 一个实例不伤另一个会话的实例；close 取消全部只清自己的 store；
 *   8. 审计写入失败 → 不执行工具（fail-closed，all 档同样）；
 *   9. 没有本机结果（历史恢复）→ 只文本回退，绝不重跑 tools/call；
 *  10. structuredContent / `_meta` 只回给 iframe，审计与模型侧都不含原文。
 *
 * ⚠️ 这是**离线 PoC**：不验证真实 Electron 协议、真实 iframe sandbox、真实第三方 App，
 * 也不代表 MCP Apps 规范字段已与稳定版核对（字段仍集中在 app-spec，标注待核对）。
 *
 * 运行：node scripts/test-mcp-app-view-service.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

let checks = 0
const failures = []
const ok = (condition, message, detail) => {
  checks += 1
  if (!condition) {
    failures.push(message)
    console.log(`✗ ${message}${detail !== undefined ? `（${detail}）` : ''}`)
  } else {
    console.log(`✓ ${message}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-app-view-service-'))
process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_PI_DIR = join(root, 'pi-agent')

let mod
try {
  const bundled = await build({
    stdin: {
      contents:
        "export * from './src/main/mcp/app-view-service';" +
        "export * from './src/main/mcp/app-view-audit';" +
        "export * from './src/main/mcp/app-resource-store';" +
        "export * from './src/main/mcp/app-view-trust';" +
        "export * from './src/shared/mcp-app-preview';",
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  mod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
} catch (error) {
  console.error(`无法加载被测模块：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const {
  McpAppViewService,
  McpAppViewAuditStore,
  parseMcpAppUrl,
  mcpServerIdentityFingerprint
} = mod
ok(typeof McpAppViewService === 'function', '加载 McpAppViewService')
ok(typeof McpAppViewAuditStore === 'function', '加载 McpAppViewAuditStore')

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/* ------------------------------------------------------------------ 固定夹具 */

const HTML = '<!doctype html><html><body>app</body></html>'
const SERVER = 'srv'
const SERVER_CONFIG = {
  id: SERVER,
  transport: 'stdio',
  command: 'node',
  args: ['fixture.mjs'],
  enabled: true,
  ownedBy: 'inkstone'
}
const FINGERPRINT = mcpServerIdentityFingerprint(SERVER_CONFIG)

const appTool = (overrides = {}) => ({
  name: 'read',
  annotations: { readOnlyHint: true },
  meta: { ui: { visibility: ['app', 'model'] } },
  visibility: ['app', 'model'],
  modelVisible: true,
  appVisible: true,
  resourceUri: null,
  ...overrides
})
const writeTool = () => ({
  name: 'write',
  annotations: { destructiveHint: true },
  meta: { ui: { visibility: ['app'] } },
  visibility: ['app'],
  modelVisible: false,
  appVisible: true,
  resourceUri: null,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
})

function makeRecord(overrides = {}) {
  return {
    callId: 'call-1',
    owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 3 },
    serverId: SERVER,
    toolName: 'read',
    text: 'MODEL-ONLY-TEXT',
    resourceUri: 'ui://srv/app.html',
    ...overrides
  }
}

/**
 * 组装一个可观测的 service。所有依赖都可覆盖；返回 service 与观测器。
 */
function makeHarness(options = {}) {
  const state = {
    activeSessions: new Set(options.activeSessions ?? ['s1', 's2']),
    mode: options.mode ?? 'danger',
    grants: options.grants ?? [],
    tools: options.tools ?? [appTool()],
    fetchLog: [],
    callLog: [],
    askLog: [],
    refreshLog: [],
    callImpl:
      options.callImpl ??
      (async () => ({
        result: {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: { chart: 1 },
          _meta: { ui: { resourceUri: null } }
        },
        meta: { ui: {} },
        structuredContent: { chart: 1 },
        resourceUri: null,
        uiCsp: null,
        isError: false,
        text: 'ok'
      }))
  }
  const callFacts = options.callFacts ?? new Map([['call-1', factsFor('s1', 'r1', 3)]])
  const ownerGuard = {
    isActive(owner) {
      return state.activeSessions.has(owner.sessionId)
    }
  }
  const proxy = {
    getCallResult(callId) {
      return (options.records ?? new Map([['call-1', makeRecord()]])).get(callId) ?? null
    },
    snapshotStatus: () => options.snapshotStatus?.() ?? { present: true, stale: false, needsRefresh: false },
    registrableTools: options.registrableTools ?? (() => [{ serverId: SERVER }]),
    refreshLog: state.refreshLog,
    refresh: async (refreshOptions) => {
      state.refreshLog.push(refreshOptions ?? {})
      if (options.refreshThrows) throw new Error(options.refreshThrows)
      return { ok: true, toolCount: options.refreshToolCount ?? 1 }
    }
  }
  const host = {
    async listToolsWithMeta() {
      return state.tools
    },
    async callToolWithMeta(serverId, toolName, args) {
      state.callLog.push({ serverId, toolName, args })
      return state.callImpl(serverId, toolName, args)
    },
    async readResource(serverId, uri) {
      return { uri, mimeType: 'text/html;profile=mcp-app', text: HTML, bytes: HTML.length, meta: null, uiCsp: null }
    }
  }
  const audit =
    options.audit ??
    new McpAppViewAuditStore({ dir: join(root, `audit-${options.name ?? 'default'}`) })
  const serviceOptions = {
    proxy,
    host,
    ownerGuard,
    runtime: {
      resolve: options.resolve ?? (async ({ callId }) => callFacts.get(callId) ?? null),
      currentProject: options.currentProject ?? (async () => 'p1')
    },
    ask: options.ask ?? ((request) => {
      state.askLog.push(request)
      return Promise.resolve('once')
    }),
    audit,
    serverConfigOf: options.serverConfigOf ?? ((serverId) => (serverId === SERVER ? SERVER_CONFIG : null)),
    permissionMode: () => state.mode,
    grantsOf: () => state.grants,
    fetchResource: options.fetchResource ?? (async ({ projectId }) => {
      state.fetchLog.push(projectId)
      return { html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: HTML.length, csp: "default-src 'none'" }
    }),
    now: () => 1_700_000_000_000
  }
  if (options.store) serviceOptions.store = options.store
  const service = new McpAppViewService(serviceOptions)
  return { service, state }
}

function factsFor(sessionId, runnerId, generation, sessionFile = `/sessions/${sessionId}.jsonl`) {
  return {
    sessionId,
    sessionFile,
    projectId: 'p1',
    runnerId,
    generation,
    cwd: 'C:/proj',
    title: 'Demo App'
  }
}

const rpc = (method, params, id) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })

async function init(service, instanceId, id = 1) {
  return service.dispatch(instanceId, rpc('ui/initialize', {}, id))
}

/* ------------------------------------------------------------------ 1. prepare / init / call / audit 真实落盘 */

await (async () => {
  const { service, state } = makeHarness({ name: 'happy' })
  const prepared = await service.prepare('call-1')
  ok(prepared.kind === 'ready', '同 owner 的调用记录 → 准备出 ready 实例', prepared.kind)
  if (prepared.kind !== 'ready') return
  ok(typeof prepared.instanceId === 'string' && prepared.instanceId.length > 0, '返回随机实例号')
  ok(parseMcpAppUrl(prepared.url)?.instanceId === prepared.instanceId, 'URL 是受控 inkstone-app 地址')
  ok(prepared.title === 'Demo App', '标题来自运行实例事实')
  ok(state.fetchLog.length === 1 && state.fetchLog[0] === 'p1', '资源 fetch 携带 owner.projectId（不是从 projectScope 猜）')

  const initialized = await init(service, prepared.instanceId)
  ok(initialized?.result?.hostContext?.platform === 'desktop', 'initialize 返回宿主上下文', JSON.stringify(initialized))

  const result = await service.dispatch(
    prepared.instanceId,
    rpc('tools/call', { name: 'read', arguments: { q: 'x' } }, 2)
  )
  ok(result?.result?.structuredContent?.chart === 1, 'tools/call 结果回给 iframe')
  ok(state.askLog.length === 1, '只读无 grant 必须询问一次')
  ok(state.callLog.length === 1 && state.callLog[0].toolName === 'read', '审批通过后真正调用工具')

  const entries = await service.audit('call-1')
  const phases = entries.map((entry) => entry.phase)
  ok(phases.includes('requested') && phases.includes('approved') && phases.includes('completed'), '审计含 requested→approved→completed', JSON.stringify(phases))
  ok(entries.every((entry) => entry.permissionMode === 'danger'), '审计记录权限档')
  ok(entries.some((entry) => typeof entry.argsHash === 'string' && entry.argsHash.length === 64), '审计含参数哈希')
  const dumped = JSON.stringify(entries)
  ok(!dumped.includes('MODEL-ONLY-TEXT'), '审计不含模型文本原文')
  ok(!dumped.includes('structuredContent') && !dumped.includes('"_meta"'), '审计不含 structuredContent / 原始 Meta')
  ok(!dumped.includes('"arguments"') && !dumped.includes('"q"'), '审计不含完整 args')

  const files = await readdir(join(root, 'audit-happy'))
  ok(files.length === 1 && files[0].endsWith('.jsonl'), '审计真实写入了隔离 JSONL', files.join(','))
  const raw = await readFile(join(root, 'audit-happy', files[0]), 'utf8')
  ok(raw.split('\n').filter(Boolean).length === 3, '一次调用落盘三条阶段记录')
  const expectedName = `${createHash('sha256').update('/sessions/s1.jsonl').digest('hex').slice(0, 32)}.jsonl`
  ok(files[0] === expectedName, '审计文件按 sessionFile 哈希分离')
})()

/* ------------------------------------------------------------------ 2. deny / null / 无本机结果 */

await (async () => {
  const deny = makeHarness({ name: 'deny', ask: () => Promise.resolve('deny') })
  const prepared = await deny.service.prepare('call-1')
  await init(deny.service, prepared.instanceId)
  const result = await deny.service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 3))
  ok(Boolean(result?.error), 'ask=deny：调用被拒')
  ok(deny.state.callLog.length === 0, 'ask=deny：不执行工具')
  const denied = await deny.service.audit('call-1')
  ok(denied.some((entry) => entry.phase === 'denied'), '拒绝路径落审计')

  const nullAsk = makeHarness({ name: 'nullask', ask: () => Promise.resolve(null) })
  const prepared2 = await nullAsk.service.prepare('call-1')
  await init(nullAsk.service, prepared2.instanceId)
  const result2 = await nullAsk.service.dispatch(prepared2.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 4))
  ok(Boolean(result2?.error) && nullAsk.state.callLog.length === 0, 'ask 无答复（null）：拒绝且不执行')

  /* 历史恢复：没有本机结果 → 文本回退，绝不重跑工具。 */
  const history = makeHarness({ name: 'history', records: new Map() })
  const fallback = await history.service.prepare('call-1')
  ok(fallback.kind === 'text', '没有本机结果是文本回退', fallback.kind)
  ok(history.state.callLog.length === 0, '文本回退不触发 tools/call')
  const noHost = makeHarness({ name: 'nohost', callFacts: new Map() })
  const unknown = await noHost.service.prepare('call-1')
  ok(unknown.kind === 'error', '解析不到运行实例是 error', unknown.kind)
})()

/* ------------------------------------------------------------------ 3. visibility 拒绝也记档；all 档写审计 */

await (async () => {
  const modelOnly = makeHarness({ name: 'visibility', tools: [appTool({ meta: { ui: { visibility: ['model'] } }, visibility: ['model'], appVisible: false })] })
  const prepared = await modelOnly.service.prepare('call-1')
  await init(modelOnly.service, prepared.instanceId)
  const result = await modelOnly.service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 5))
  ok(Boolean(result?.error), 'visibility 不含 app 的调用被拒')
  ok(modelOnly.state.callLog.length === 0, 'visibility 拒绝不执行工具')
  const entries = await modelOnly.service.audit('call-1')
  ok(entries.some((entry) => entry.phase === 'denied' && /visibility/.test(entry.summary)), 'visibility 拒绝也落审计')

  const allMode = makeHarness({ name: 'allmode', mode: 'all' })
  const prepared2 = await allMode.service.prepare('call-1')
  await init(allMode.service, prepared2.instanceId)
  const result2 = await allMode.service.dispatch(prepared2.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 6))
  ok(result2?.result !== undefined, 'all 档不额外拦截')
  ok(allMode.state.askLog.length === 0, 'all 档不弹卡')
  const entries2 = await allMode.service.audit('call-1')
  ok(entries2.length >= 3 && entries2.every((entry) => entry.permissionMode === 'all'), 'all 档仍真实写审计')
})()

/* ------------------------------------------------------------------ 4. schema / 未知工具 / 跨 server / 重放 */

await (async () => {
  const { service, state } = makeHarness({ name: 'schema', tools: [appTool(), writeTool()] })
  const prepared = await service.prepare('call-1')
  await init(service, prepared.instanceId)

  const missing = await service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'write', arguments: {} }, 7))
  ok(Boolean(missing?.error) && state.callLog.length === 0, 'schema 缺必填参数：拒绝且不执行')

  const unknown = await service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'nope', arguments: {} }, 8))
  ok(Boolean(unknown?.error) && state.callLog.length === 0, '未知工具：拒绝且不执行')

  const replay = await service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 9))
  ok(replay?.result !== undefined, '首次调用成功')
  const replayAgain = await service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 9))
  ok(replayAgain?.error?.code === -32600, '重复 id 被拒（拒绝重放）')
  ok(state.callLog.length === 1, '重放没有再次执行工具')

  const crossServer = makeHarness({ name: 'crossserver', serverConfigOf: () => null })
  const prepared2 = await crossServer.service.prepare('call-1')
  await init(crossServer.service, prepared2.instanceId)
  const result = await crossServer.service.dispatch(prepared2.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 10))
  ok(Boolean(result?.error) && crossServer.state.callLog.length === 0, '服务身份指纹缺失：拒绝且不执行（跨/未知 server）')

  const crossOwner = makeHarness({
    name: 'crossowner',
    records: new Map([['call-1', makeRecord({ owner: { sessionId: 'other', projectId: 'p1', runnerId: 'r1', epoch: 3 } })]])
  })
  const bad = await crossOwner.service.prepare('call-1')
  ok(bad.kind === 'error', '记录 owner 与当前会话不符：拒绝', bad.kind)
})()

/* ------------------------------------------------------------------ 4b. 破坏性即使有 grant 也逐次问；trusted 只读直接放行 */

await (async () => {
  let destructiveAsks = 0
  const destructive = makeHarness({
    name: 'destructive',
    tools: [writeTool()],
    grants: [{ serverFingerprint: FINGERPRINT, scope: 'server', authorizer: 'user', expiresAt: 1_800_000_000_000 }],
    ask: () => {
      destructiveAsks += 1
      return Promise.resolve('deny')
    }
  })
  const prepared = await destructive.service.prepare('call-1')
  await init(destructive.service, prepared.instanceId)
  const result = await destructive.service.dispatch(
    prepared.instanceId,
    rpc('tools/call', { name: 'write', arguments: { path: 'x' } }, 40)
  )
  ok(Boolean(result?.error) && destructive.state.callLog.length === 0, '破坏性工具即使有 grant 也逐次问（拒绝则不执行）')
  ok(destructive.state.askLog.length === 0 && destructiveAsks === 1, '破坏性工具确实弹了卡片')

  const trusted = makeHarness({
    name: 'trusted',
    grants: [{ serverFingerprint: FINGERPRINT, scope: 'server', authorizer: 'user', expiresAt: 1_800_000_000_000 }]
  })
  const prepared2 = await trusted.service.prepare('call-1')
  await init(trusted.service, prepared2.instanceId)
  const result2 = await trusted.service.dispatch(prepared2.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 41))
  ok(result2?.result !== undefined, 'trusted 只读直接放行')
  ok(trusted.state.askLog.length === 0 && trusted.state.callLog.length === 1, 'trusted 只读不弹卡且执行一次')
})()

/* ------------------------------------------------------------------ 5. 切会话等待审批 / 调用迟到作废 */

await (async () => {
  const gate = deferred()
  const cut = makeHarness({ name: 'cut-ask', ask: () => gate.promise })
  const prepared = await cut.service.prepare('call-1')
  await init(cut.service, prepared.instanceId)
  const pending = cut.service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 11))
  await delay(10)
  cut.state.activeSessions.delete('s1')
  cut.service.invalidateSession('s1')
  gate.resolve('once')
  const result = await pending
  ok(Boolean(result?.error), '切会话后等待中的审批结果作废')
  ok(cut.state.callLog.length === 0, '切会话后不执行工具')

  const callGate = deferred()
  const late = makeHarness({
    name: 'late-call',
    grants: [{ serverFingerprint: FINGERPRINT, scope: 'server', authorizer: 'user', expiresAt: 1_800_000_000_000 }],
    callImpl: () => callGate.promise
  })
  const prepared2 = await late.service.prepare('call-1')
  await init(late.service, prepared2.instanceId)
  const pending2 = late.service.dispatch(prepared2.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 12))
  await delay(10)
  late.state.activeSessions.delete('s1')
  callGate.resolve({
    result: { content: [], structuredContent: { leak: 1 }, _meta: {} },
    meta: {},
    structuredContent: { leak: 1 },
    resourceUri: null,
    uiCsp: null,
    isError: false,
    text: 'late'
  })
  const result2 = await pending2
  ok(Boolean(result2?.error), '调用迟到且归属已失效：丢弃结果')
  const lateEntries = await late.service.audit('call-1')
  ok(lateEntries.some((entry) => entry.phase === 'error'), '迟到结果落 error 审计')
  ok(!lateEntries.some((entry) => entry.phase === 'completed'), '迟到结果不落 completed')
})()

/* ------------------------------------------------------------------ 6. release 隔离 / close */

await (async () => {
  const callFacts = new Map([
    ['call-a', factsFor('s1', 'r1', 1)],
    ['call-b', factsFor('s2', 'r2', 1)]
  ])
  const records = new Map([
    ['call-a', makeRecord({ callId: 'call-a', owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 1 } })],
    ['call-b', makeRecord({ callId: 'call-b', owner: { sessionId: 's2', projectId: 'p1', runnerId: 'r2', epoch: 1 } })]
  ])
  const callGate = deferred()
  const { service, state } = makeHarness({
    name: 'release-isolation',
    callFacts,
    records,
    grants: [{ serverFingerprint: FINGERPRINT, scope: 'server', authorizer: 'user', expiresAt: 1_800_000_000_000 }],
    callImpl: () => callGate.promise
  })
  const a = await service.prepare('call-a')
  const b = await service.prepare('call-b')
  await init(service, a.instanceId)
  await init(service, b.instanceId)
  const pendingB = service.dispatch(b.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 13))
  await delay(10)
  await service.release(a.instanceId)
  const releasedAgain = await service.dispatch(a.instanceId, rpc('ui/initialize', {}, 14))
  ok(releasedAgain?.error?.code === -32600, '释放后实例不可再用')
  callGate.resolve({
    result: { content: [{ type: 'text', text: 'b-ok' }] },
    meta: {},
    structuredContent: null,
    resourceUri: null,
    uiCsp: null,
    isError: false,
    text: 'b-ok'
  })
  const resultB = await pendingB
  ok(resultB?.result !== undefined, '释放 A 不影响 B 的调用')
  ok(state.callLog.length === 1 && state.callLog[0].toolName === 'read', '只有 B 的工具被执行')

  service.close()
  const afterClose = await service.dispatch(b.instanceId, rpc('ui/initialize', {}, 15))
  ok(afterClose?.error?.code === -32600, 'close 取消全部实例')
})()

/* ------------------------------------------------------------------ 7. 审计写入失败 → 不执行 */

await (async () => {
  const failingAudit = {
    async record() {
      throw new Error('disk full')
    },
    async read() {
      return []
    },
    async clearSession() {}
  }
  const { service, state } = makeHarness({
    name: 'audit-fail',
    audit: failingAudit,
    grants: [{ serverFingerprint: FINGERPRINT, scope: 'server', authorizer: 'user', expiresAt: 1_800_000_000_000 }]
  })
  const prepared = await service.prepare('call-1')
  await init(service, prepared.instanceId)
  const result = await service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 16))
  ok(Boolean(result?.error) && state.callLog.length === 0, '审计写入失败：拒绝执行工具（fail-closed）')

  const allFail = makeHarness({
    name: 'audit-fail-all',
    mode: 'all',
    audit: failingAudit
  })
  const prepared2 = await allFail.service.prepare('call-1')
  await init(allFail.service, prepared2.instanceId)
  const result2 = await allFail.service.dispatch(prepared2.instanceId, rpc('tools/call', { name: 'read', arguments: {} }, 17))
  ok(Boolean(result2?.error) && allFail.state.callLog.length === 0, 'all 档审计失败同样不执行')
})()

/* ------------------------------------------------------------------ 8. 未审方法明确 unsupported；snapshot/refresh */

await (async () => {
  const { service, state } = makeHarness({ name: 'unsupported' })
  const prepared = await service.prepare('call-1')
  await init(service, prepared.instanceId)
  for (const [offset, method] of ['ui/message', 'ui/open-link', 'ui/update-model-context', 'sampling/createMessage'].entries()) {
    const result = await service.dispatch(prepared.instanceId, rpc(method, { text: 'x' }, 20 + offset))
    ok(result?.error?.code === -32601, `未审方法 ${method} 明确 unsupported`)
  }
  const read = await service.dispatch(prepared.instanceId, rpc('resources/read', { uri: 'ui://other/x' }, 30))
  ok(read?.error?.code === -32601, 'resources/read 不允许非本实例资源（不能跨 server 任意读）')

  const snap = await service.snapshot()
  ok(snap.needsRefresh === false && snap.toolCount === 1, 'snapshot 反映代理工具快照状态')
  const refreshed = await service.refresh()
  ok(refreshed.ok === true && refreshed.toolCount === 1, 'refresh 走代理刷新接口')
  ok(state.refreshLog.length === 1 && state.refreshLog[0].callerProjectId === 'p1', 'refresh 把可信 caller 项目传给代理')
})

/* ------------------------------------------------------------------ 9. 跨会话审计：前台 B 不得读后台 A */

await (async () => {
  const s1Facts = factsFor('s1', 'r1', 3)
  const s2Facts = factsFor('s2', 'r2', 1)
  let foreground = s1Facts
  const { service } = makeHarness({
    name: 'audit-cross-session',
    resolve: async () => foreground,
    currentProject: async () => 'p1'
  })
  const prepared = await service.prepare('call-1')
  await init(service, prepared.instanceId)
  const called = await service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'read', arguments: { q: 'x' } }, 60))
  ok(called?.result !== undefined, '会话 A 前台时调用并写入本会话审计')
  const inA = await service.audit('call-1')
  ok(inA.length >= 3 && inA.some((entry) => entry.phase === 'completed'), '同会话可读本机审计')

  /* 前台切到 B：即使 callId 曾被 A prepare 过，也不得拿 A 的 sessionFile 直读。 */
  foreground = s2Facts
  const inB = await service.audit('call-1')
  ok(inB.length === 0, '前台 B 读后台 A 的审计返回空（不跨会话）')

  /* 恢复回同一 sessionFile（历史恢复）：允许读本机该会话审计，且不重跑工具。 */
  foreground = s1Facts
  const restored = await service.audit('call-1')
  ok(restored.length >= 3, '回到同 session 可读本机历史审计（绝不重跑 tool）')
})()

/* ------------------------------------------------------------------ 10. snapshot/refresh 只计当前项目可见目标 */

await (async () => {
  const tools = [
    { serverId: 'global-app' },
    { serverId: 'proj-a-app', projectScope: 'p-a' },
    { serverId: 'proj-b-app', projectScope: 'p-b' }
  ]
  const a = makeHarness({ name: 'refresh-proj-a', registrableTools: () => tools, currentProject: async () => 'p-a' })
  const snapA = await a.service.snapshot()
  ok(snapA.toolCount === 2, '项目 A：只计全局 + 本项目（不泄 B 的条目数）', String(snapA.toolCount))
  const refreshedA = await a.service.refresh()
  ok(refreshedA.ok === true && a.state.refreshLog[0].callerProjectId === 'p-a', '刷新带 A 的可信 caller')

  const none = makeHarness({ name: 'refresh-no-project', registrableTools: () => tools, currentProject: async () => null })
  const snapNone = await none.service.snapshot()
  ok(snapNone.toolCount === 1, '无项目事实：只计全局条目（项目目标不可见）', String(snapNone.toolCount))
  await none.service.refresh()
  ok(!('callerProjectId' in none.state.refreshLog[0]), '无项目事实：不带 caller（由代理 fail-closed）')

  const fail = makeHarness({ name: 'refresh-config-fail', refreshThrows: 'mcp 配置读取失败' })
  const refreshedFail = await fail.service.refresh()
  ok(refreshedFail.ok === false && refreshedFail.toolCount === 0 && /配置/.test(refreshedFail.error ?? ''), '配置读取失败：刷新默认拒绝', refreshedFail.error)
  const snapFail = makeHarness({ name: 'snapshot-throw', snapshotStatus: () => { throw new Error('boom') } })
  const snapThrown = await snapFail.service.snapshot()
  ok(snapThrown.needsRefresh === true && snapThrown.toolCount === 0, '快照状态读取失败：按待刷新/0 工具处理')
})()

/* ------------------------------------------------------------------ 收尾 */

await rm(root, { recursive: true, force: true })

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
