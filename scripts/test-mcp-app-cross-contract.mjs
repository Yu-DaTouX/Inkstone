import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { fakeFrame, fakePort, fakeWindow } from './fixtures/mcp-app-cross-contract-boundary.mjs'

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

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-app-cross-contract-'))
process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_PI_DIR = join(root, 'pi-agent')

async function loadTsBundle(contents, external = []) {
  const bundled = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    external,
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

async function loadTsBundleFromFile(contents, external = []) {
  const dir = resolve('.tmp/A6R-cross-contract')
  await mkdir(dir, { recursive: true })
  const outfile = join(dir, `bundle-${Buffer.from(contents).toString('hex').slice(0, 16)}.mjs`)
  const bundled = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    external,
    logLevel: 'silent'
  })
  await writeFile(outfile, bundled.outputFiles[0].text, 'utf8')
  return import(pathToFileURL(outfile).href)
}

const main = await loadTsBundle(
  "export * from './src/main/mcp/app-view-service';" +
    "export * from './src/main/mcp/app-view-audit';" +
    "export * from './src/main/mcp/app-resource-store';" +
    "export * from './src/main/mcp/app-view-trust';" +
    "export * from './src/shared/mcp-app-preview';"
)
const renderer = await loadTsBundle(
  "export * from './src/renderer/src/features/artifacts/mcp-app-frame-model';" +
    "export * from './src/renderer/src/features/artifacts/mcp-app-channel';" +
    "export * from './src/renderer/src/features/artifacts/model';"
)

const { McpAppViewService, McpAppViewAuditStore, mcpServerIdentityFingerprint } = main
const { McpAppChannel } = renderer

const tick = () => new Promise((done) => setTimeout(done, 60))
async function waitFor(predicate, timeoutMs = 5000) {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return true
    if (Date.now() - start > timeoutMs) return false
    await new Promise((done) => setTimeout(done, 5))
  }
}
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
const SERVER_CONFIG = { id: SERVER, transport: 'stdio', command: 'node', args: ['x.mjs'], enabled: true, ownedBy: 'inkstone' }
const FINGERPRINT = mcpServerIdentityFingerprint(SERVER_CONFIG)

function factsFor(sessionId, runnerId, generation) {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    projectId: 'p1',
    runnerId,
    generation,
    cwd: 'C:/proj'
  }
}

function makeRecord(overrides = {}) {
  return {
    callId: 'call-1',
    owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 3 },
    serverId: SERVER,
    toolName: 'read',
    text: 'MODEL-TEXT',
    resourceUri: 'ui://srv/app.html',
    ...overrides
  }
}

const appTool = { name: 'read', annotations: { readOnlyHint: true }, meta: { ui: { visibility: ['app', 'model'] } }, visibility: ['app', 'model'], modelVisible: true, appVisible: true, resourceUri: null }

function makeOutcome(text = 'ok') {
  return {
    result: { content: [{ type: 'text', text }], structuredContent: { chart: 1 }, _meta: { ui: { resourceUri: null } } },
    meta: { ui: { resourceUri: null } },
    structuredContent: { chart: 1 },
    resourceUri: null,
    uiCsp: null,
    isError: false,
    text
  }
}

function makeBridge(options = {}) {
  const state = {
    active: new Set(options.active ?? ['s1', 's2']),
    foreground: options.foreground ?? factsFor('s1', 'r1', 3),
    currentProject: options.currentProject ?? 'p1',
    hostCalls: [],
    askLog: [],
    late: options.late ?? null
  }
  const records = options.records ?? new Map([['call-1', makeRecord()]])
  const service = new McpAppViewService({
    proxy: {
      getCallResult: (callId) => records.get(callId) ?? null,
      snapshotStatus: () => ({ present: true, stale: false, needsRefresh: false }),
      registrableTools: options.registrableTools ?? (() => [{ serverId: SERVER }]),
      refresh: async (refreshOptions) => {
        state.refreshOptions = refreshOptions
        return options.refreshResult ?? { ok: true, toolCount: 1 }
      }
    },
    host: {
      listToolsWithMeta: async () => options.tools ?? [appTool],
      callToolWithMeta: async (serverId, toolName, args) => {
        state.hostCalls.push({ serverId, toolName, args })
        if (state.late) return state.late.promise
        return makeOutcome()
      },
      readResource: async (serverId, uri) => ({ uri, mimeType: 'text/html;profile=mcp-app', text: HTML, bytes: HTML.length, meta: null, uiCsp: null })
    },
    ownerGuard: { isActive: (owner) => state.active.has(owner.sessionId) },
    runtime: {
      resolve: async () => state.foreground,
      currentProject: async () => state.currentProject
    },
    ask: (request) => {
      state.askLog.push(request)
      return Promise.resolve({ choice: 'once' })
    },
    audit: new McpAppViewAuditStore({ dir: join(root, `audit-${options.name ?? 'default'}`) }),
    serverConfigOf: () => SERVER_CONFIG,
    fetchResource: async ({ projectId }) => {
      state.fetchProjectId = projectId
      return { html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: HTML.length, csp: "default-src 'none'" }
    }
  })
  return { state, service }
}

function attachChannel(service, instanceId, overrides = {}) {
  const win = fakeWindow()
  const frame = fakeFrame()
  const api = {
    calls: [],
    dispatch(instanceIdArg, message) {
      api.calls.push(message)
      return service.dispatch(instanceIdArg, message)
    }
  }
  const channel = new McpAppChannel({
    instanceId,
    api,
    window: win,
    getFrame: () => frame,
    ...overrides
  })
  channel.attach()
  return { win, frame, api, channel }
}

const rpc = (method, params, id) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params })
const fromFrame = (frame, message) => ({ data: message, origin: 'null', source: frame })

{
  const { state, service } = makeBridge({ name: 'handshake' })
  const prepared = await service.prepare('call-1')
  ok(prepared.kind === 'ready', '正式 service.prepare 返回 ready 实例', prepared.kind)
  ok(state.fetchProjectId === 'p1', 'prepare 用 owner.projectId 取资源（不是目标 scope）')

  const { win, frame, api, channel } = attachChannel(service, prepared.instanceId)
  const other = fakeFrame()

  win.emit(fromFrame(frame, rpc('ui/initialize', { protocolVersion: 1 }, 11)))
  await waitFor(() => channel.getPhase() === 'ready')
  ok(api.calls.length === 1 && api.calls[0].method === 'ui/initialize', 'initialize 只派发给 host 一次')
  const envelope = frame.posted.at(-1).message
  ok(envelope.jsonrpc === '2.0' && envelope.id === 11, 'host 信封带 jsonrpc/id（单层）')
  ok(envelope.result?.hostContext?.platform === 'desktop', 'initialize 结果在顶层 result')
  ok(envelope.result?.result === undefined, 'ui/initialize 响应只有一层，没有被再包成 result.result')
  ok(channel.getPhase() === 'ready', '合法 initialize 应答后进入 ready')

  win.emit(fromFrame(frame, rpc('vendor/unknown', {}, 12)))
  await waitFor(() => frame.posted.at(-1)?.message?.error?.code === -32601)
  const unknown = frame.posted.at(-1).message
  ok(unknown.error?.code === -32601 && unknown.result === undefined, '未知方法保留顶层 error -32601 unsupported')

  const before = api.calls.length
  win.emit(fromFrame(other, rpc('tools/call', { name: 'read', arguments: {} }, 13)))
  await tick()
  ok(api.calls.length === before, '非本框 source 的消息不派发')
  ok(other.posted.length === 0, '结果不会回投给非本框')

  const dup = rpc('tools/call', { name: 'read', arguments: {} }, 14)
  win.emit(fromFrame(frame, dup))
  win.emit(fromFrame(frame, dup))
  await waitFor(() => state.hostCalls.length >= 1)
  await tick()
  ok(state.hostCalls.length === 1, '同代重复 id 只执行一次', String(state.hostCalls.length))
}

{
  const { state, service } = makeBridge({ name: 'reject-init' })
  const prepared = await service.prepare('call-1')
  state.active.delete('s1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  win.emit(fromFrame(frame, rpc('ui/initialize', {}, 21)))
  await waitFor(() => Boolean(frame.posted.at(-1)?.message?.error))
  const envelope = frame.posted.at(-1).message
  ok(envelope.error?.code === -32001 && envelope.result === undefined, 'host 拒绝 initialize 保留顶层 error，不转 result')
  ok(channel.getPhase() !== 'ready', '错误 initialize 不进 ready')
  ok(state.hostCalls.length === 0, '未成功 initialize 不放行 tools/call')
}

{
  const { state, service } = makeBridge({ name: 'tools' })
  const prepared = await service.prepare('call-1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  win.emit(fromFrame(frame, rpc('ui/initialize', {}, 31)))
  await waitFor(() => channel.getPhase() === 'ready')
  win.emit(fromFrame(frame, rpc('tools/call', { name: 'read', arguments: { q: 'x' } }, 32)))
  await waitFor(() => Boolean(frame.posted.at(-1)?.message?.result?.structuredContent))
  const envelope = frame.posted.at(-1).message
  ok(envelope.result?.structuredContent?.chart === 1, 'structuredContent 回到本框')
  ok(envelope.result?._meta !== undefined, '_meta 回到本框')
  ok(state.hostCalls.length === 1 && state.hostCalls[0].toolName === 'read', '审批通过后真正执行一次工具', String(state.hostCalls.length))
  ok(channel.getPhase() === 'ready', '工具调用不改变握手状态')
}

{
  const { state, service } = makeBridge({ name: 'audit' })
  const prepared = await service.prepare('call-1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  win.emit(fromFrame(frame, rpc('ui/initialize', {}, 41)))
  await waitFor(() => channel.getPhase() === 'ready')
  win.emit(fromFrame(frame, rpc('tools/call', { name: 'read', arguments: { q: 'x' } }, 42)))
  await waitFor(() => state.hostCalls.length === 1)
  await waitFor(async () => {
    const entries = await service.audit('call-1')
    return entries.some((entry) => entry.phase === 'completed')
  })
  const inA = await service.audit('call-1')
  ok(inA.some((entry) => entry.phase === 'completed'), '会话 A 可读本机审计（真实临时 JSONL 落盘）')

  state.foreground = factsFor('s2', 'r2', 1)
  const inB = await service.audit('call-1')
  ok(inB.length === 0, '前台 B 读后台 A 审计返回空（不跨会话）')

  state.foreground = factsFor('s1', 'r1', 3)
  const restored = await service.audit('call-1')
  ok(restored.length >= 3, '恢复同 sessionFile 可读本机历史审计（绝不重跑 tool）')
}

{
  const late = deferred()
  const { state, service } = makeBridge({ name: 'late', late })
  const prepared = await service.prepare('call-1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  win.emit(fromFrame(frame, rpc('ui/initialize', {}, 51)))
  await waitFor(() => channel.getPhase() === 'ready')
  win.emit(fromFrame(frame, rpc('tools/call', { name: 'read', arguments: {} }, 52)))
  await waitFor(() => state.hostCalls.length === 1)
  const postedBefore = frame.posted.length
  channel.nextGeneration()
  late.resolve(makeOutcome('late'))
  await tick()
  ok(frame.posted.length === postedBefore, '换代（iframe reload）后旧代迟到结果不回投')
  ok(channel.getPhase() === 'idle', '换代把握手重置为 idle')
}

{
  const { service } = makeBridge({ name: 'port' })
  const prepared = await service.prepare('call-1')
  const { win, frame, channel } = attachChannel(service, prepared.instanceId)
  const port = fakePort()
  win.emit({ ...fromFrame(frame, rpc('ui/initialize', {}, 61)), ports: [port] })
  await waitFor(() => port.posted.length === 1)
  ok(port.started, '本框初始化采纳 MessagePort 并 start')
  ok(port.posted.length === 1, 'initialize 应答经端口回投')
  ok(frame.posted.length === 0, '采纳端口后不再走 window.postMessage')
  channel.dispose()
  ok(port.closed, 'dispose 关闭端口')
}

{
  const proxy = await loadTsBundleFromFile("export * from './src/main/mcp/app-proxy-service';", [
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/*'
  ])
  const appHostMark = { at: '2026-10-16T00:00:00.000Z', natives: [{ path: '/pi/mcp.json', name: 'x', entry: {}, fingerprint: 'fp' }] }
  const server = (id, projectScope) => ({
    id,
    transport: 'stdio',
    command: 'x',
    enabled: true,
    ownedBy: 'inkstone',
    appHost: appHostMark,
    ...(projectScope ? { projectScope } : {})
  })
  const listCalls = []
  const host = {
    listManagedServers: () => [server('global-app'), server('proj-a-app', 'p-a'), server('proj-b-app', 'p-b')],
    listToolsWithMeta: async (serverId, options) => {
      listCalls.push({ serverId, projectId: options?.projectId })
      return [{ name: 't', modelVisible: true, appVisible: false, visibility: ['model'] }]
    },
    callToolWithMeta: async () => {
      throw new Error('unused')
    },
    statusOf: () => ({ status: 'ready' })
  }
  const scoped = new proxy.McpAppProxyService({ dir: join(root, 'proxy'), host })

  await scoped.refresh({ callerProjectId: 'p-a' })
  ok(listCalls.every((entry) => entry.serverId !== 'proj-b-app'), '项目 A 刷新不启动 B 服务')
  ok(listCalls.some((entry) => entry.serverId === 'proj-a-app' && entry.projectId === 'p-a'), '项目 A 刷新把真实 caller 带到 listTools（不从目标 scope 自证）')

  listCalls.length = 0
  const empty = await scoped.refresh({ serverIds: [], callerProjectId: 'p-a' })
  ok(empty.written === false && listCalls.length === 0, '显式空 serverIds = 0 目标，不启动任何服务')
  ok(empty.error === proxy.MCP_APP_PROXY_NO_TARGETS, '空目标返回明确 no_targets')

  const failing = new proxy.McpAppProxyService({
    dir: join(root, 'proxy-fail'),
    host: {
      listManagedServers: () => {
        throw new Error('mcp-servers.json 读取失败')
      },
      listToolsWithMeta: async () => [],
      callToolWithMeta: async () => {
        throw new Error('unused')
      },
      statusOf: () => ({ status: 'disconnected' })
    }
  })
  let failed = false
  try {
    await failing.refresh({ callerProjectId: 'p-a' })
  } catch {
    failed = true
  }
  ok(failed, '配置读取失败：刷新默认拒绝，不写出半份快照')
}

{
  const { service } = makeBridge({
    name: 'snapshot',
    currentProject: 'p-a',
    registrableTools: () => [{ serverId: 'global' }, { serverId: 'a', projectScope: 'p-a' }, { serverId: 'b', projectScope: 'p-b' }]
  })
  const snap = await service.snapshot()
  ok(snap.toolCount === 2, 'snapshot 只计当前项目可见（2 条），不泄 B 的条目数', String(snap.toolCount))
  const refreshed = await service.refresh()
  ok(refreshed.ok === true && refreshed.toolCount === 1, 'refresh 走代理刷新接口')
}

await rm(root, { recursive: true, force: true })

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
