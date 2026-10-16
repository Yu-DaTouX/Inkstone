/**
 * HI4 · MCP App **生产装配**跨层小测（正式 service + 正式 channel + 正式 runtime 包装）。
 *
 * ── 它证明什么 ──
 *   1. `createMcpAppViewRuntime` 装上「真实前台事实源」后的行为：current 有效 → prepare
 *      成功；切到 B 后旧 A 的 instance / audit / dispatch 全部失效；晚到结果被丢弃。
 *   2. owner / project / generation 任一不符都拒绝（full-match），不因「旧 runner 还活着」放行。
 *   3. ownerGuard 缺省不成立：错误 initialize 不放行 tools/call（service 与 channel 两层）。
 *   4. renderer 异常 / 主 frame 重载走 `close()`：实例与在途调用立即作废。
 *   5. legacy 连接事实缺失 / pi 已退出但 legacy ready **不被当作无持有**（HA3 行为不回退）。
 *   6. 沙箱 / CSP / 协议来源：`allow-scripts` 且无 same-origin；跨 owner 读被拒。
 *   7. 运动偏好：默认 static；用户 reduce 后停；播放器不重建菜单 / 不每 tick 读盘。
 *
 * ── 哪些边界是假的 ──
 *   · 浏览器 iframe / window / MessagePort = fake（fixtures/mcp-app-cross-contract-boundary）；
 *   · MCP host / proxy / ask = 内存假件；批准固定返回 once；
 *   · 不启 Electron、不建真实 iframe、不连真实 MCP 服务、不调真实模型。
 *   `protocol.handle` / webRequest / 系统托盘 / DPI / 真实第三方 App 兼容仍未验 ——
 *   本测只说「模块与静态装配通过」。
 *
 * 运行：node scripts/test-mcp-app-final-wiring.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { fakeFrame, fakeWindow } from './fixtures/mcp-app-cross-contract-boundary.mjs'

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
const eq = (actual, expected, message) => ok(Object.is(actual, expected), message, `实际 ${JSON.stringify(actual)}`)

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-app-final-wiring-'))
process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_MCP_SERVERS_FILE = join(root, 'mcp-servers.json')

async function loadTsBundle(contents) {
  const bundled = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
}

const main = await loadTsBundle(
  "export * from './src/main/mcp/app-view-service';" +
    "export * from './src/main/mcp/app-view-audit';" +
    "export * from './src/main/mcp/app-resource-store';" +
    "export * from './src/main/mcp/app-view-trust';" +
    "export * from './src/main/mcp/app-runtime-ownership';" +
    "export * from './src/main/attention/tray-animation';" +
    "export * from './src/shared/mcp-app-preview';"
)
const renderer = await loadTsBundle(
  "export * from './src/renderer/src/features/artifacts/mcp-app-channel';" +
    "export * from './src/renderer/src/features/artifacts/mcp-app-frame-model';"
)

const {
  McpAppViewService,
  McpAppViewAuditStore,
  McpAppResourceStore,
  createMcpAppViewRuntime,
  mayHoldMcpAppWithLegacy,
  createTrayAnimationPlayer,
  MCP_APP_SANDBOX,
  buildMcpAppCsp,
  mcpAppErrorHeaders,
  mcpAppResponseHeaders,
  parseMcpAppUrl
} = main
const { McpAppChannel, MCP_APP_FRAME_SANDBOX, MCP_APP_FRAME_ALLOW, MCP_APP_FRAME_REFERRER_POLICY } = renderer

/* ------------------------------------------------------------------ 固定夹具 */

const HTML = '<!doctype html><html><body>app</body></html>'
const SERVER = 'srv'
const SERVER_CONFIG = { id: SERVER, transport: 'stdio', command: 'node', args: ['x.mjs'], enabled: true, ownedBy: 'inkstone' }

const facts = (sessionId, runnerId, generation, projectId = 'p1') => ({
  sessionId,
  sessionFile: `/sessions/${sessionId}.jsonl`,
  projectId,
  runnerId,
  generation,
  cwd: 'C:/proj'
})
const FACTS_A = facts('s1', 'r1', 3)
const FACTS_B = facts('s2', 'r2', 7)

const makeRecord = (overrides = {}) => ({
  callId: 'call-1',
  owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 3 },
  serverId: SERVER,
  toolName: 'read',
  text: 'MODEL-TEXT',
  resourceUri: 'ui://srv/app.html',
  ...overrides
})

const appTool = {
  name: 'read',
  annotations: { readOnlyHint: true },
  meta: { ui: { visibility: ['app', 'model'] } },
  visibility: ['app', 'model'],
  modelVisible: true,
  appVisible: true,
  resourceUri: null
}

const outcome = (text = 'ok') => ({
  result: { content: [{ type: 'text', text }], structuredContent: { chart: 1 }, _meta: { ui: { resourceUri: null } } },
  meta: { ui: { resourceUri: null } },
  structuredContent: { chart: 1 },
  resourceUri: null,
  uiCsp: null,
  isError: false,
  text
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * 装配「正式 runtime 包装 + 正式 service + 前台事实源」，逐字对应 index.ts 的接线：
 *   · current / currentProject / isActive 都读**同一个**前台事实；
 *   · isActive 全字段对照（runner / session / sessionFile / project / generation）。
 * `syncForeground` 复刻 index.ts 的 `syncAppViewForeground`（前台变化即 invalidate）。
 */
function makeAssembly({ name = 'default', foreground = FACTS_A, records, hostTools, deferredOutcome } = {}) {
  const state = { foreground, last: foreground ?? null, refreshes: [], askLog: [], afterCalls: [] }
  const callRecords = records ?? new Map([['call-1', makeRecord()]])

  const source = {
    current: () => state.foreground,
    currentProject: () => state.foreground?.projectId ?? null,
    isActive: (owner) => {
      const f = state.foreground
      if (!f) return false
      return (
        owner.runnerId === f.runnerId &&
        owner.sessionId === f.sessionId &&
        owner.sessionFile === f.sessionFile &&
        owner.projectId === f.projectId &&
        owner.generation === f.generation
      )
    }
  }
  const { runtime, ownerGuard } = main.createMcpAppViewRuntime(source)

  const service = new McpAppViewService({
    proxy: {
      getCallResult: (callId) => callRecords.get(callId) ?? null,
      snapshotStatus: () => ({ present: true, stale: false, needsRefresh: false }),
      registrableTools: () => [{ serverId: SERVER }, { serverId: SERVER, projectScope: 'p1' }, { serverId: SERVER, projectScope: 'p2' }],
      refresh: async (options) => {
        state.refreshes.push(options)
        return { ok: true, toolCount: 1 }
      }
    },
    host: {
      listToolsWithMeta: async () => hostTools ?? [appTool],
      callToolWithMeta: async () => (deferredOutcome ? deferredOutcome.promise : outcome()),
      readResource: async (serverId, uri) => ({ uri, mimeType: 'text/html;profile=mcp-app', text: HTML, bytes: HTML.length, meta: null, uiCsp: null })
    },
    runtime,
    ownerGuard,
    ask: (request) => {
      state.askLog.push(request)
      return Promise.resolve('once')
    },
    audit: new McpAppViewAuditStore({ dir: join(root, `audit-${name}`) }),
    serverConfigOf: () => SERVER_CONFIG,
    fetchResource: async () => ({ html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: HTML.length, csp: "default-src 'none'" })
  })

  const syncForeground = (next) => {
    const previous = state.last
    state.foreground = next
    state.last = next
    if (!previous) return
    if (
      next &&
      previous.runnerId === next.runnerId &&
      previous.sessionId === next.sessionId &&
      previous.sessionFile === next.sessionFile &&
      previous.generation === next.generation
    ) {
      return
    }
    service.invalidateRunnerId(previous.runnerId)
    service.invalidateSession(previous.sessionId)
  }

  return { state, service, syncForeground }
}

const call = (instanceId, method, params = {}, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  params
})

/* ══════════════════════════════════ 1 · 装配与前台事实 ══════════════════════════════════ */

{
  const { service } = makeAssembly({ name: 'valid' })
  const prepared = await service.prepare('call-1')
  ok(prepared.kind === 'ready', '正式装配：当前前台会话的有效调用 prepare 成功', prepared.kind)
  ok(typeof prepared.instanceId === 'string' && prepared.instanceId.length > 0, 'prepare 返回实例号')
  ok(parseMcpAppUrl(prepared.url) !== null, 'prepare 返回受控 inkstone-app 地址', prepared.url)

  const init = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'ui/initialize', {}, 10))
  ok(init && init.result && typeof init.result === 'object', 'initialize 返回单层 result 信封')
  const tool = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 11))
  ok(tool && tool.result && tool.result.structuredContent && tool.result.structuredContent.chart === 1, 'tools/call 返回 structuredContent（只回本框）')
  const audit = await service.audit('call-1')
  const phases = audit.map((entry) => entry.phase)
  ok(phases.includes('requested') && phases.includes('approved') && phases.includes('completed'), '真实审计落盘含 requested/approved/completed', phases.join(','))
  ok(audit.every((entry) => entry.summary && !('rawMeta' in entry) && !('structuredContent' in entry)), '审计只存安全摘要，不含 rawMeta/structuredContent')

  const snap = await service.snapshot()
  ok(snap.toolCount === 2, 'snapshot 只计当前项目可见条目（全局 + p1 = 2）', snap.toolCount)
  const refreshed = await service.refresh()
  ok(refreshed.ok === true && refreshed.toolCount === 1, 'refresh 走正式代理刷新入口', JSON.stringify(refreshed))
}

/* ══════════════════════════════════ 2 · 切 B 旧 A 失效 ══════════════════════════════════ */

{
  const { service, syncForeground } = makeAssembly({ name: 'switch' })
  const prepared = await service.prepare('call-1')
  ok(prepared.kind === 'ready', '切换前 A 实例可用')
  syncForeground(FACTS_B)

  const oldDispatch = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 21))
  ok(oldDispatch && oldDispatch.error && oldDispatch.error.code === -32600, '切到 B 后旧 A 实例 dispatch 被拒（实例已注销）', JSON.stringify(oldDispatch))
  const oldAudit = await service.audit('call-1')
  eq(oldAudit.length, 0, '切到 B 后读不到 A 会话的审计（不跨会话）')

  /* 仅改前台事实、不主动 invalidate：ownerGuard 也必须拒绝（防漏接）。 */
  const { service: bare } = makeAssembly({ name: 'switch-gate' })
  const barePrepared = await bare.prepare('call-1')
  ok(barePrepared.kind === 'ready', '未主动失效时 A 实例先建立')
  const gate = makeAssembly({ name: 'switch-gate-2' })
  const prepared2 = await gate.service.prepare('call-1')
  gate.state.foreground = FACTS_B
  const gated = await gate.service.dispatch(prepared2.instanceId, call(prepared2.instanceId, 'tools/call', { name: 'read', arguments: {} }, 22))
  ok(gated && gated.error && gated.error.code === -32001, '前台切走后 ownerGuard 拒绝 tools/call（不靠 runtimeOf 旧 runner）', JSON.stringify(gated))
  void bare
}

/* ══════════════════════════════════ 3 · 晚到结果丢弃 ══════════════════════════════════ */

{
  const late = deferred()
  const { service, syncForeground } = makeAssembly({ name: 'late', deferredOutcome: late })
  const prepared = await service.prepare('call-1')
  const pending = service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 31))
  await new Promise((done) => setTimeout(done, 30))
  syncForeground(FACTS_B)
  late.resolve(outcome('LATE'))
  const result = await pending
  ok(result && result.error, '切换后晚到的工具结果被丢弃（返回错误）', JSON.stringify(result))
  const audit = await service.audit('call-1')
  eq(audit.length, 0, '晚到结果不会写进 B 的会话审计')
}

/* ══════════════════════════════════ 4 · owner/project/generation 不符 ══════════════════════════════════ */

{
  const cases = [
    ['调用记录会话不符', { owner: { sessionId: 'sX', projectId: 'p1', runnerId: 'r1', epoch: 3 } }],
    ['调用记录 runner 不符', { owner: { sessionId: 's1', projectId: 'p1', runnerId: 'rX', epoch: 3 } }],
    ['调用记录项目不符', { owner: { sessionId: 's1', projectId: 'pX', runnerId: 'r1', epoch: 3 } }],
    ['调用记录代次不符', { owner: { sessionId: 's1', projectId: 'p1', runnerId: 'r1', epoch: 4 } }]
  ]
  for (const [label, overrides] of cases) {
    const { service } = makeAssembly({ name: `mismatch-${label}`, records: new Map([['call-1', makeRecord(overrides)]]) })
    const prepared = await service.prepare('call-1')
    ok(prepared.kind === 'error', `${label}：prepare 明确拒绝`, prepared.kind)
  }

  /* project 变更（同 runner/session/generation）→ isActive 全字段核对也必须拒绝 */
  const { service, state } = makeAssembly({ name: 'project-gate' })
  const prepared = await service.prepare('call-1')
  await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'ui/initialize', {}, 40))
  const before = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 41))
  ok(before && before.result, '项目一致时正常调用', JSON.stringify(before))
  state.foreground = { ...FACTS_A, projectId: 'p2' }
  const after = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 42))
  ok(after && after.error && after.error.code === -32001, 'projectId 变化后 ownerGuard 拒绝（full-match）', JSON.stringify(after))
  const snap = await service.snapshot()
  ok(snap.toolCount === 2, 'snapshot 用同源 currentProject 计数（p2 → 全局 + p2）', snap.toolCount)
  await service.refresh()
}

/* ══════════════════════════════════ 5 · 错误 initialize 不 ready ══════════════════════════════════ */

{
  /* service 层：未 initialize 直接 tools/call → -32002 */
  const { service } = makeAssembly({ name: 'init-service' })
  const prepared = await service.prepare('call-1')
  const early = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 51))
  ok(early && early.error && early.error.code === -32002, 'service：未初始化先 tools/call 被拒（-32002）', JSON.stringify(early))

  /* channel 层：host 返回 error 的 initialize → 通道不 ready，tools/call 本地拒绝 */
  const win = fakeWindow()
  const frame = fakeFrame()
  const dispatched = []
  const channel = new McpAppChannel({
    instanceId: 'inst-x',
    api: {
      dispatch: async (_instanceId, message) => {
        dispatched.push(message)
        return { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32000, message: '初始化失败' } }
      }
    },
    window: win,
    getFrame: () => frame
  })
  channel.attach()
  win.emit({ data: call('inst-x', 'ui/initialize', {}, 61), origin: 'null', source: frame })
  await new Promise((done) => setTimeout(done, 20))
  ok(channel.getPhase() !== 'ready', 'channel：host 返回 error 的 initialize 不进入 ready', channel.getPhase())
  const blocked = await new Promise((resolve) => {
    const before = frame.posted.length
    win.emit({ data: call('inst-x', 'tools/call', { name: 'read', arguments: {} }, 62), origin: 'null', source: frame })
    setTimeout(() => resolve(frame.posted.slice(before)), 10)
  })
  ok(blocked.some((item) => item.message && item.message.error && item.message.error.code === -32002), 'channel：未 ready 的 tools/call 本地拒绝（-32002）')
  channel.dispose()
}

/* ══════════════════════════════════ 6 · renderer 异常失效 ══════════════════════════════════ */

{
  const { service } = makeAssembly({ name: 'renderer-gone' })
  const prepared = await service.prepare('call-1')
  ok(prepared.kind === 'ready', 'renderer 失效前实例存在')
  service.close()
  const after = await service.dispatch(prepared.instanceId, call(prepared.instanceId, 'tools/call', { name: 'read', arguments: {} }, 71))
  ok(after && after.error && after.error.code === -32600, 'renderer 异常 / close 后实例被清，dispatch 拒绝', JSON.stringify(after))

  const { service: svc2 } = makeAssembly({ name: 'reclaim' })
  const p2 = await svc2.prepare('call-1')
  svc2.invalidateRunnerId('r1')
  const afterReclaim = await svc2.dispatch(p2.instanceId, call(p2.instanceId, 'tools/call', { name: 'read', arguments: {} }, 72))
  ok(afterReclaim && afterReclaim.error, '回收 runner 后绑定它的实例立即失效')
}

/* ══════════════════════════════════ 7 · legacy 事实不回退 ══════════════════════════════════ */

{
  const server = { serverId: SERVER, scope: 'global' }
  const exited = { processRunning: false, conn: 'exited', projectId: null }
  eq(
    mayHoldMcpAppWithLegacy({ ...exited, legacyMcpServices: null }, server),
    true,
    'legacy 事实缺失（null）按「可能持有」，不放行新连接'
  )
  eq(
    mayHoldMcpAppWithLegacy({ ...exited, legacyMcpServices: [{ serverId: SERVER, status: 'ready' }] }, server),
    true,
    'pi 已退出但 legacy client 仍 ready → 仍算持有'
  )
  eq(
    mayHoldMcpAppWithLegacy({ ...exited, legacyMcpServices: [{ serverId: 'other', status: 'ready' }] }, server),
    false,
    '确定退出且目标服务无 legacy 连接 → 才排除持有'
  )
  eq(
    mayHoldMcpAppWithLegacy({ processRunning: true, conn: 'ready', projectId: null, legacyMcpServices: [] }, server),
    true,
    '存活新的 pi 实例仍可能持有（新会话不被误排除）'
  )
}

/* ══════════════════════════════════ 8 · 沙箱 / CSP / 跨 owner ══════════════════════════════════ */

{
  eq(MCP_APP_FRAME_SANDBOX, 'allow-scripts', 'iframe sandbox 固定 allow-scripts')
  ok(!String(MCP_APP_FRAME_SANDBOX).includes('allow-same-origin'), 'sandbox 不含 allow-same-origin')
  eq(MCP_APP_SANDBOX, 'allow-scripts', '共享 sandbox 常量与渲染端一致')
  eq(MCP_APP_FRAME_REFERRER_POLICY, 'no-referrer', 'referrerPolicy 固定 no-referrer')
  ok(String(MCP_APP_FRAME_ALLOW).split(';').every((item) => item.trim() === '' || /'none'$/.test(item.trim())), 'allow 权限全关（逐项 none）', MCP_APP_FRAME_ALLOW)

  const csp = buildMcpAppCsp({})
  ok(csp.includes('connect-src \'none\''), '首版 CSP connect-src 为 none（拒绝网络声明）')
  ok(csp.includes("frame-src 'none'") && csp.includes("object-src 'none'") && csp.includes("base-uri 'none'"), 'CSP 关闭 frame/object/base')
  ok(csp.includes('sandbox allow-scripts'), 'CSP 末尾带 sandbox allow-scripts')
  const headers = mcpAppResponseHeaders(csp)
  ok(headers['X-Content-Type-Options'] === 'nosniff' && headers['Referrer-Policy'] === 'no-referrer', '响应带 nosniff / no-referrer')
  ok(String(mcpAppErrorHeaders()['Permissions-Policy']).includes('camera=()'), '错误页也带关闭的 Permissions-Policy')

  /* 跨 owner 读：store 只认自己登记的实例 */
  let fetchCount = 0
  const store = new McpAppResourceStore({
    ownerGuard: { isActive: () => true },
    fetchResource: async () => {
      fetchCount += 1
      return { html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: HTML.length, csp: "default-src 'none'" }
    }
  })
  const ownerA = { serverId: SERVER, sessionId: 's1', sessionFile: '/s1.jsonl', projectId: 'p1', runnerId: 'r1', generation: 3, toolCallId: 'call-1' }
  const ownerB = { ...ownerA, sessionId: 's2', sessionFile: '/s2.jsonl', runnerId: 'r2' }
  const prepared = await store.prepare({ serverId: SERVER, resourceUri: 'ui://srv/app.html', owner: ownerA })
  ok(prepared.ok === true && typeof prepared.instanceId === 'string', 'store：owner 有效时登记实例')
  const wrong = store.read(prepared.url, { owner: ownerB })
  ok(wrong.ok === false && wrong.error === 'owner', 'store：跨 owner 读被拒', wrong.error)
  const revoked = new McpAppResourceStore({ ownerGuard: { isActive: () => false }, fetchResource: async () => ({ html: HTML, mimeType: 'text/html;profile=mcp-app', bytes: HTML.length, csp: 'x' }) })
  const denied = await revoked.prepare({ serverId: SERVER, resourceUri: 'ui://srv/app.html', owner: ownerA })
  ok(denied.ok === false && denied.error === 'revoked', 'store：owner 不活跃时 fail-closed，不抓取', denied.error)
  void fetchCount
}

/* ══════════════════════════════════ 9 · 运动偏好 ══════════════════════════════════ */

{
  let now = 0
  const timers = new Set()
  const applied = []
  const player = createTrayAnimationPlayer({
    assets: (state, theme) => ({ frames: [{ image: `${state}-0`, durationMs: 25 }, { image: `${state}-1`, durationMs: 25 }], static: `${state}-static` }),
    theme: () => 'on-light',
    apply: (image) => applied.push(image),
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => {
        const handle = { fn, at: now + ms }
        timers.add(handle)
        return handle
      },
      clearTimeout: (handle) => timers.delete(handle)
    }
  })
  player.setState('running')
  eq(player.animating(), false, '运动偏好未上报时默认 static（不播放）')
  eq(player.frameIndex(), 0, '默认 static 显示静止帧')
  ok(applied.includes('running-static'), '默认 static 应用 running 静态图')

  now = 1000
  player.setMotionAllowed(true)
  eq(player.animating(), true, '收到允许后开始播放')
  player.setMotionAllowed(false)
  eq(player.animating(), false, '用户 reduce 立即停止')
  eq(player.frameIndex(), 0, '停止后回到静态第一帧')

  player.setState('waiting')
  eq(player.animating(), false, '等待态但 motion 关闭时仍 static')
  player.dispose()

  /* 播放器不重建菜单 / 不读盘：帧集每 tick 都从注入端口取内存缓存，apply 只在帧变化时发生。 */
  let assetReads = 0
  const p2 = createTrayAnimationPlayer({
    assets: () => {
      assetReads += 1
      return { frames: [{ image: 'a', durationMs: 10 }, { image: 'b', durationMs: 10 }], static: 's' }
    },
    theme: () => 'on-light',
    apply: () => undefined,
    clock: { now: () => now, setTimeout: () => ({ id: 1 }), clearTimeout: () => undefined }
  })
  p2.setState('running')
  p2.setMotionAllowed(true)
  const readsAfterStart = assetReads
  p2.setState('running')
  eq(assetReads, readsAfterStart, '同一状态重复 setState 不重新取素材')
  p2.dispose()
}

/* ══════════════════════════════════ 10 · 静态装配断言（index/preload/shared/协议合并） ══════════════════════════════════ */

{
  const index = await readFile('src/main/index.ts', 'utf8')
  const preload = await readFile('src/preload/index.ts', 'utf8')
  const sharedIpc = await readFile('src/shared/ipc.ts', 'utf8')
  const htmlPreview = await readFile('src/main/html-artifact-preview.ts', 'utf8')
  const protocol = await readFile('src/main/mcp/app-protocol.ts', 'utf8')

  ok(index.includes('registerMcpAppViewIpc(ipc, { service: () => mcpAppViewService })'), 'index：注册正式 view IPC（地址只经主窗口白名单）')
  ok(index.includes('createMcpAppViewRuntime({') && index.includes('registerMcpAppProtocol(mcpAppViewService.resourceStore())'), 'index：正式组装 runtime 并在 ready 后注册协议 handler')
  ok(
    index.includes('owner.runnerId === facts.runnerId') &&
      index.includes('owner.sessionId === facts.sessionId') &&
      index.includes('owner.sessionFile === facts.sessionFile') &&
      index.includes('owner.projectId === facts.projectId') &&
      index.includes('owner.generation === facts.generation'),
    'index：ownerGuard 对当前前台全字段核对'
  )
  ok(index.includes('currentProject: (): string | null => appViewForegroundFacts()?.projectId ?? null'), 'index：currentProject 与 current 同源前台项目')
  ok(index.includes('mcpAppViewService?.close()'), 'index：renderer 失效 / 退出主动 close 实例')
  ok(index.indexOf('mcpAppViewService?.invalidateRunnerId(id)') >= 0, 'index：回收实例时 invalidate 绑定视图')
  ok(index.includes("ipcMain.on('yan:motion-preference'") && index.includes('typeof reduced !== \'boolean\''), 'index：运动偏好 IPC 校验主窗口且严格 boolean')
  ok(index.includes('let trayMotionAllowed = false'), 'index：运动偏好默认 false（静态）')
  ok(index.includes('ensureTrayAssets()') && index.includes('trayAnimationAssets:') && index.includes('motionAllowed: () => trayMotionAllowed'), 'index：启动预载托盘素材并接入 attention 端口')

  ok(preload.includes('mcpApps: {') && preload.includes('MCP_APP_VIEW_CHANNELS.prepare'), 'preload：暴露 mcpApps，通道名来自共享唯一源')
  ok(preload.includes("ipcRenderer.send('yan:motion-preference', Boolean(reduced))"), 'preload：运动偏好单向 send 且转成 boolean')
  ok(sharedIpc.includes('mcpApps: McpAppViewApi') && sharedIpc.includes('setMotionPreference(reduced: boolean): void'), 'shared/ipc：YanBridge 含 mcpApps 与 setMotionPreference')

  ok(htmlPreview.includes('parseMcpAppUrl(details.url) !== null'), '离线 HTML 拦截合并放行受控 inkstone-app 子框（不新增第二个 onBeforeRequest）')
  ok(!protocol.includes('onBeforeRequest'), 'MCP App 协议不注册自己的 webRequest 监听（不与离线成果争单监听）')
  ok(protocol.includes('store.read(request.url, { method: request.method })') && protocol.includes('mcpAppResponseHeaders(result.csp)'), '协议 handler 只读 store，经共享头沿用严格离线 CSP')
}

/* ------------------------------------------------------------------ 汇总 */

await rm(root, { recursive: true, force: true }).catch(() => undefined)
console.log(``)
if (failures.length) {
  console.log(`MCP App 生产装配小测：${checks} 项，${failures.length} 项失败`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`MCP App 生产装配小测：${checks} 项全部通过`)
