import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

async function isolated(run) {
  const savedEnv = { ...process.env }
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
    Object.assign(process.env, savedEnv)
  }
}

async function viewServiceSuite() {
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
    hostRequests: options.hostRequests,
    ownerGuard,
    runtime: {
      resolve: options.resolve ?? (async ({ callId }) => callFacts.get(callId) ?? null),
      currentProject: options.currentProject ?? (async () => 'p1')
    },
    ask: options.ask ?? ((request) => {
      state.askLog.push(request)
      return Promise.resolve({ choice: 'once' })
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
  return service.dispatch(instanceId, rpc('inkstone/activate', {}, id))
}

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

await (async () => {
  const deny = makeHarness({ name: 'deny', ask: () => Promise.resolve({ choice: 'deny' }) })
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

  const history = makeHarness({ name: 'history', records: new Map() })
  const fallback = await history.service.prepare('call-1')
  ok(fallback.kind === 'text', '没有本机结果是文本回退', fallback.kind)
  ok(history.state.callLog.length === 0, '文本回退不触发 tools/call')
  const noHost = makeHarness({ name: 'nohost', callFacts: new Map() })
  const unknown = await noHost.service.prepare('call-1')
  ok(unknown.kind === 'error', '解析不到运行实例是 error', unknown.kind)
})()

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

await (async () => {
  let destructiveAsks = 0
  const destructive = makeHarness({
    name: 'destructive',
    tools: [writeTool()],
    grants: [{ serverFingerprint: FINGERPRINT, scope: 'server', authorizer: 'user', expiresAt: 1_800_000_000_000 }],
    ask: () => {
      destructiveAsks += 1
      return Promise.resolve({ choice: 'deny' })
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
  const releasedAgain = await service.dispatch(a.instanceId, rpc('inkstone/activate', {}, 14))
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
  const afterClose = await service.dispatch(b.instanceId, rpc('inkstone/activate', {}, 15))
  ok(afterClose?.error?.code === -32600, 'close 取消全部实例')
})()

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

  foreground = s2Facts
  const inB = await service.audit('call-1')
  ok(inB.length === 0, '前台 B 读后台 A 的审计返回空（不跨会话）')

  foreground = s1Facts
  const restored = await service.audit('call-1')
  ok(restored.length >= 3, '回到同 session 可读本机历史审计（绝不重跑 tool）')
})()

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

await (async () => {
  const audit = new McpAppViewAuditStore({ dir: join(root, 'audit-clearsession') })
  await audit.record('C:/sessions/a.jsonl', {
    callId: 'c1',
    toolName: 't',
    phase: 'requested',
    permissionMode: 'danger',
    summary: 's'
  })
  const before = await audit.read('C:/sessions/a.jsonl')
  await audit.clearSession('C:/sessions/a.jsonl')
  const after = await audit.read('C:/sessions/a.jsonl')
  ok(before.length === 1 && after.length === 0, '会话删除：clearSession 清掉该会话的审计文件')
})()

await (async () => {
  const protoTool = appTool({
    name: 'needsToString',
    inputSchema: { type: 'object', properties: { toString: { type: 'string' } }, required: ['toString'] }
  })
  const harness = makeHarness({ name: 'proto-args', tools: [protoTool] })
  const prepared = await harness.service.prepare('call-1')
  await init(harness.service, prepared.instanceId)
  const result = await harness.service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'needsToString', arguments: {} }, 7))
  ok(Boolean(result?.error) && /缺少必填参数/.test(result.error.message), '必填参数判定不过原型链（toString 未提供即缺参）', JSON.stringify(result?.error))
  ok(harness.state.callLog.length === 0, '缺参不执行工具')
})()

await (async () => {
  const bigText = 'x'.repeat(200_000)
  const harness = makeHarness({
    name: 'big-result',
    callImpl: async () => ({
      result: { content: [{ type: 'text', text: bigText }] },
      meta: null,
      structuredContent: null,
      resourceUri: null,
      uiCsp: null,
      isError: false,
      text: bigText
    })
  })
  const prepared = await harness.service.prepare('call-1')
  await init(harness.service, prepared.instanceId)
  const result = await harness.service.dispatch(prepared.instanceId, rpc('tools/call', { name: 'read', arguments: { path: 'x' } }, 8))
  const text = result?.result?.content?.[0]?.text ?? ''
  ok(text.length < 40_000 && text.includes('已截断'), '大结果：文本内容截到 32KB 以内并带占位', String(text.length))

  const mode = await harness.service.dispatch(prepared.instanceId, rpc('ui/request-display-mode', { mode: 'fullscreen' }, 9))
  ok(mode?.error?.code === -32601, '显示模式由官方 AppBridge 处理，不转发到主进程协议', JSON.stringify(mode))
})()

await (async () => {
  const harness = makeHarness({ name: 'reload', maxInstances: 2 })
  const first = await harness.service.prepare('call-1')
  await init(harness.service, first.instanceId)
  const facts = factsFor('s1', 'r1', 3)
  const secondCallId = 'call-2'
  harness.service
  ok(first.kind === 'ready', 'reload：首个实例准备成功')
  ok(harness.service.resourceStore().size === 1, 'reload：资源存储登记了实例')
  const removed = harness.service.resetForReload()
  ok(removed === 1 && harness.service.resourceStore().size === 0, 'reload：重载后实例与资源缓存一起清空', String(removed))
  const again = await harness.service.prepare('call-1')
  ok(again.kind === 'ready', 'reload：清空后可以重新准备（不会 8 次后永久不可用）')
  void facts
  void secondCallId
})()

await (async () => {
  const effects = []
  const hostRequests = {
    message: async (text, facts) => effects.push(['message', text, facts.runnerId]),
    openLink: async (url, facts) => effects.push(['link', url, facts.runnerId]),
    downloadFile: async (contents, facts) => effects.push(['download', contents.length, facts.runnerId])
  }
  const { service, state } = makeHarness({ name: 'sdk-host-requests', hostRequests })
  const prepared = await service.prepare('call-1')
  const initialized = await init(service, prepared.instanceId)
  ok(initialized.result.hostCapabilities.message.text !== undefined && initialized.result.hostCapabilities.openLinks !== undefined && initialized.result.hostCapabilities.downloadFile !== undefined, '握手只声明实际接线的宿主能力')
  ok(Object.keys(initialized.result.hostCapabilities.sandbox.permissions).length === 0, '沙箱明确不授予浏览器设备权限')
  for (const [id, method, params] of [
    [201, 'ui/message', { role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    [202, 'ui/open-link', { url: 'https://example.com/path' }],
    [203, 'ui/download-file', { contents: [{ type: 'resource', resource: { uri: 'file:///export.txt', text: 'hello' } }] }]
  ]) {
    const response = await service.dispatch(prepared.instanceId, rpc(method, params, id))
    ok(response.result && !response.result.isError, `宿主请求通过审批：${method}`)
  }
  ok(effects.length === 3 && effects.every((effect) => effect[2] === 'r1'), '宿主副作用使用绑定的 runner，不从前台会话猜测')
  ok(state.askLog.length === 3 && state.askLog.every((request) => request.runId === 'r1' && request.canRemember === false), '消息/链接/下载逐次审批，不能借只读信任跳过')
  const audit = await service.audit('call-1')
  ok(audit.filter((entry) => entry.phase === 'completed').length === 3, '三类宿主请求都保留审计')
  const invalid = await service.dispatch(prepared.instanceId, rpc('ui/message', { role: 'user', content: [{ type: 'image', data: 'aA==', mimeType: 'image/png' }] }, 204))
  ok(invalid.error?.code === -32602 && effects.length === 3, '未声明的消息模态不执行')
  state.activeSessions.delete('s1')
  const stale = await service.dispatch(prepared.instanceId, rpc('ui/open-link', { url: 'https://example.com' }, 205))
  ok(stale.error?.code === -32001 && effects.length === 3, '归属失效后宿主请求同样拒绝')
  service.close()

  const denied = makeHarness({ name: 'sdk-host-denied', hostRequests, ask: async () => ({ choice: 'deny' }) })
  const deniedPrepared = await denied.service.prepare('call-1')
  await init(denied.service, deniedPrepared.instanceId)
  const refused = await denied.service.dispatch(deniedPrepared.instanceId, rpc('ui/message', { role: 'user', content: [{ type: 'text', text: 'no' }] }, 206))
  ok(refused.result?.isError === true && effects.length === 3, '用户拒绝时返回规范 isError，不执行副作用')
  denied.service.close()
})()

await rm(root, { recursive: true, force: true })

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
}

async function viewTrustSuite() {
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

const dataDir = await mkdtemp(join(tmpdir(), 'yan-mcp-app-view-trust-'))
process.env.YAN_DATA_DIR = dataDir

let mod
try {
  const bundled = await build({
    stdin: {
      contents:
        "export * from './src/main/mcp/app-view-approval';" +
        "export * from './src/main/mcp/app-view-trust';",
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

const { approveAppViewCall, evaluateHostTrust, mcpServerIdentityFingerprint } = mod
ok(typeof approveAppViewCall === 'function', '加载 approveAppViewCall')
ok(typeof evaluateHostTrust === 'function', '加载 evaluateHostTrust')
ok(typeof mcpServerIdentityFingerprint === 'function', '加载 mcpServerIdentityFingerprint')

const NOW = 1_700_000_000_000
const FP_A = 'a'.repeat(64)
const FP_B = 'b'.repeat(64)
const SERVER = 'srv'
const baseCall = { server: SERVER, tool: 'read', visibility: ['app'], cwd: 'C:/proj' }
const safeAnnotations = { readOnlyHint: true }
const safeExplicit = { destructiveHint: false, openWorldHint: false }
const destructiveAnnotations = { destructiveHint: true }

const grant = (overrides = {}) => ({
  serverFingerprint: FP_A,
  scope: 'server',
  authorizer: 'user',
  expiresAt: NOW + 60_000,
  ...overrides
})
const ctx = (overrides = {}) => ({ serverFingerprint: FP_A, grants: [grant()], now: NOW, ...overrides })

const allowAsk = (tracker) => () => {
  if (tracker) tracker.calls += 1
  return Promise.resolve({ choice: 'once' })
}
const denyAsk = (tracker) => () => {
  if (tracker) tracker.calls += 1
  return Promise.resolve({ choice: 'deny' })
}
const nullAsk = (tracker) => () => {
  if (tracker) tracker.calls += 1
  return Promise.resolve(null)
}
const throwingAsk = (tracker) => () => {
  if (tracker) tracker.calls += 1
  return Promise.reject(new Error('broker timeout'))
}

{
  const tracker = { calls: 0 }
  const result = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker))
  ok(result.allowed && result.asked, '无 context 只读必须经询问后才放行（fail-closed）', JSON.stringify({ asked: result.asked }))
  ok(result.asked && tracker.calls === 1, '无 context 只读必须询问，不能静默执行')
  ok(result.recorded && result.audit.trustVerdict === 'no-fingerprint', '无 context 只读判定要求审计记录')
}

{
  const tracker = { calls: 0 }
  const result = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations },
    allowAsk(tracker),
    { serverFingerprint: FP_A, now: NOW }
  )
  ok(result.allowed && result.asked && tracker.calls === 1, '有指纹无 grant 的只读仍须询问')
  ok(result.audit.trustVerdict === 'no-grant' && result.audit.persistentGrant === false, '无 grant 记录 no-grant 且不建立持久授权')
}

{
  const tracker = { calls: 0 }
  const result = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations },
    denyAsk(tracker),
    { serverFingerprint: FP_A, now: NOW }
  )
  ok(!result.allowed && result.asked && /拒绝/.test(result.reason ?? ''), '无 grant 只读被拒不执行')
}

{
  const trackerA = { calls: 0 }
  const remembered = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, () => {
    trackerA.calls += 1
    return Promise.resolve({ choice: 'remember' })
  }, { serverFingerprint: FP_A, now: NOW })
  ok(remembered.allowed && remembered.asked, '无 grant 只读：remember 也只对本次生效')
  ok(remembered.audit.persistentGrant === false, 'remember 不写持久授权')

  const trackerB = { calls: 0 }
  const again = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, denyAsk(trackerB), {
    serverFingerprint: FP_A,
    now: NOW
  })
  ok(trackerB.calls === 1 && !again.allowed, '第二次调用仍重新询问（一次 allow 不持久化）')
}

{
  const tracker = { calls: 0 }
  const result = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), ctx())
  ok(result.allowed && !result.asked && tracker.calls === 0, '命中宿主 grant 的只读直接放行、不弹卡')
  ok(result.trust.trusted && result.trust.verdict === 'trusted' && result.trust.scope === 'server', '记录 trusted / server 范围')
  ok(result.recorded && result.audit.trustVerdict === 'trusted' && result.audit.persistentGrant === false, 'trusted 只读仍要求审计')
}

{
  const tracker = { calls: 0 }
  const explicit = await approveAppViewCall({ ...baseCall, annotations: safeExplicit }, allowAsk(tracker), ctx())
  ok(explicit.allowed && !explicit.asked && tracker.calls === 0, '显式「非破坏且非开放世界」也走 grant 直放')
}

{
  const tracker = { calls: 0 }
  const scoped = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    serverFingerprint: FP_A,
    now: NOW,
    grants: [grant({ scope: 'tool', tool: 'read' })]
  })
  ok(scoped.allowed && !scoped.asked && scoped.trust.scope === 'tool', 'tool 范围 grant 命中同一工具可直放')

  const tracker2 = { calls: 0 }
  const other = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker2), {
    serverFingerprint: FP_A,
    now: NOW,
    grants: [grant({ scope: 'tool', tool: 'write' })]
  })
  ok(other.allowed && other.asked && tracker2.calls === 1, 'tool 范围 grant 不覆盖其它工具，仍需询问')
}

for (const [key, annotations] of [['破坏性', destructiveAnnotations], ['未知注解', undefined], ['缺注解', {}]]) {
  const tracker = { calls: 0 }
  const result = await approveAppViewCall({ ...baseCall, annotations }, allowAsk(tracker), ctx())
  ok(result.allowed && result.asked && tracker.calls === 1, `${key}调用即使有 grant 仍询问`)
  ok(result.audit.trustVerdict === 'bypassed', `${key}调用审计记为未用授权（bypassed）`)
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    serverFingerprint: FP_A,
    now: NOW,
    grants: [grant({ serverFingerprint: FP_B })]
  })
  ok(r.allowed && r.asked && r.audit.trustVerdict === 'mismatch', '旧指纹 / 跨 server grant 失效，仍询问')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    ...ctx(),
    grants: [grant({ revoked: true })]
  })
  ok(r.allowed && r.asked && r.audit.trustVerdict === 'revoked' && tracker.calls === 1, '已撤销 grant 失效，仍询问')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    ...ctx(),
    grants: [grant({ expiresAt: NOW - 1 })]
  })
  ok(r.allowed && r.asked && r.audit.trustVerdict === 'expired', '已过期 grant 失效，仍询问')

  const r2 = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, denyAsk(), {
    ...ctx(),
    grants: [grant({ expiresAt: undefined })]
  })
  ok(!r2.allowed && r2.audit.trustVerdict === 'expired', '缺有效期 grant 失效（fail-closed）')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations, sessionId: 'session-me' },
    allowAsk(tracker),
    { ...ctx(), sessionId: 'session-me', grants: [grant({ sessionId: 'session-other' })] }
  )
  ok(r.allowed && r.asked && r.audit.trustVerdict === 'wrong-owner', 'owner（会话）不符 grant 失效，仍询问')

  const r2 = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations },
    allowAsk({ calls: 0 }),
    { ...ctx(), projectId: 'p1', grants: [grant({ projectId: 'p2' })] }
  )
  ok(r2.asked && r2.audit.trustVerdict === 'wrong-owner', 'owner（项目）不符 grant 失效，仍询问')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk(tracker), {
    ...ctx(),
    grants: [grant({ permissionMode: 'all' })]
  })
  ok(r.asked && r.audit.trustVerdict === 'no-grant', '仅 all 档有效的 grant 在 danger 档不生效')

  const r2 = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk({ calls: 0 }), {
    ...ctx(),
    grants: [grant({ authorizer: 'iframe' })]
  })
  ok(r2.asked, '非法授权人不构成信任，仍询问')
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall(
    { ...baseCall, annotations: safeAnnotations, trust: true, trusted: true, source: 'iframe' },
    allowAsk(tracker),
    { serverFingerprint: FP_A, trusted: true, now: NOW }
  )
  ok(r.allowed && r.asked && tracker.calls === 1, '裸布尔 trusted / iframe 自报 trust 不构成授权')

  const r2 = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, allowAsk({ calls: 0 }), {
    trusted: true,
    now: NOW
  })
  ok(r2.asked && r2.audit.trustVerdict === 'no-fingerprint', '缺指纹时即使传布尔也按 fail-closed 询问')

  const r3 = evaluateHostTrust({ serverFingerprint: FP_A, tool: 'read', grants: true, now: NOW })
  ok(!r3.trusted && r3.verdict === 'no-grant', 'evaluateHostTrust 不接受布尔 grants')
}

{
  const r = await approveAppViewCall(
    { ...baseCall, visibility: ['model'], annotations: destructiveAnnotations },
    allowAsk(),
    ctx()
  )
  ok(!r.allowed && !r.asked && r.recorded && r.audit.trustVerdict === 'bypassed', 'visibility 不含 app：拒绝且要求记录')

  const r2 = await approveAppViewCall({ ...baseCall, visibility: undefined, annotations: destructiveAnnotations }, allowAsk())
  ok(!r2.allowed && /缺少 visibility/.test(r2.reason ?? '') && r2.recorded, '缺 visibility 按最严拒绝并记录')

  for (const [key, visibility] of [
    ['字符串', 'app'],
    ['混入未知值', ['app', 'junk']],
    ['原始 meta 对象', { ui: { visibility: ['app'] } }]
  ]) {
    const r3 = await approveAppViewCall({ ...baseCall, visibility, annotations: safeAnnotations }, allowAsk(), ctx())
    ok(!r3.allowed && r3.recorded, `visibility 只接受宿主归一化数组：${key}被拒`)
  }
}

{
  const tracker = { calls: 0 }
  const r = await approveAppViewCall(
    { ...baseCall, annotations: destructiveAnnotations, permissionMode: 'all' },
    allowAsk(tracker),
    ctx()
  )
  ok(r.allowed && !r.asked && tracker.calls === 0, 'all 档不额外拦截')
  ok(r.recorded && r.audit.permissionMode === 'all' && r.reasons.length > 0, 'all 档仍记录风险与档位')
  ok(r.audit.trustVerdict === 'bypassed', 'all 档审计记为未进入信任判定')
}

for (const [key, ask] of [['异常', throwingAsk({ calls: 0 })], ['返回 null', nullAsk({ calls: 0 })]]) {
  const r = await approveAppViewCall({ ...baseCall, annotations: destructiveAnnotations }, ask, ctx())
  ok(!r.allowed && r.asked && /没有得到用户确认/.test(r.reason ?? ''), `ask ${key}判拒绝`)
  ok(r.recorded && r.audit.asked === true, `ask ${key}仍要求审计`)
}

{
  const r = await approveAppViewCall({ ...baseCall, annotations: safeAnnotations }, nullAsk({ calls: 0 }), {
    serverFingerprint: FP_A,
    now: NOW
  })
  ok(!r.allowed && r.asked && /没有得到用户确认/.test(r.reason ?? ''), '无 grant 只读的 ask 超时/null 判拒绝')
}

{
  const r = await approveAppViewCall({ ...baseCall, annotations: destructiveAnnotations }, () => Promise.resolve(undefined), ctx())
  ok(!r.allowed, 'ask 返回非法 shape（undefined）判拒绝')
}

{
  const a = mcpServerIdentityFingerprint({ id: 'srv', transport: 'stdio', command: 'node', args: ['--x'], env: { TOKEN: 'secret-token' } })
  const b = mcpServerIdentityFingerprint({ id: 'srv', transport: 'stdio', command: 'node', args: ['--x'], env: { TOKEN: 'secret-token' } })
  const c = mcpServerIdentityFingerprint({ id: 'srv', transport: 'stdio', command: 'node', args: ['--y'], env: { TOKEN: 'secret-token' } })
  ok(a === b && /^[0-9a-f]{64}$/.test(a), '相同配置指纹稳定且为 sha256 hex')
  ok(a !== c, '配置变化（args）指纹随之变化')
  ok(!a.includes('secret-token'), '指纹不泄露 env 里的凭证原文')
}

await rm(dataDir, { recursive: true, force: true })

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
}

console.log('\n=====mcp-app-view-service =====')
await isolated(viewServiceSuite)
console.log('\n=====mcp-app-view-trust =====')
await isolated(viewTrustSuite)

process.exit(0)
