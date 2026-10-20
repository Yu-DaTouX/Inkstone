import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

const bundled = await build({
  stdin: {
    contents:
      "export * from './src/shared/mcp-approval';" +
      "export * from './src/main/mcp/app-view-approval';" +
      "export * from './src/main/approval-broker';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const shared = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

const ext = await import(pathToFileURL(resolve('resources/pi-extensions/danger-guard.js')).href)
ok(typeof shared.mcpApprovalNeeded === 'function', '加载共享 mcpApprovalNeeded')
ok(typeof ext.mcpApprovalNeeded === 'function', '加载扩展 mcpApprovalNeeded')

const CASES = [
  { key: 'none', annotations: undefined },
  { key: 'empty', annotations: {} },
  { key: 'null', annotations: null },
  { key: 'non-object', annotations: 42 },
  { key: 'readOnly-true', annotations: { readOnlyHint: true } },
  { key: 'readOnly-false', annotations: { readOnlyHint: false } },
  { key: 'destructive-true', annotations: { destructiveHint: true } },
  { key: 'destructive-false', annotations: { destructiveHint: false } },
  { key: 'idempotent-true', annotations: { idempotentHint: true } },
  { key: 'idempotent-false', annotations: { idempotentHint: false } },
  { key: 'openWorld-true', annotations: { openWorldHint: true } },
  { key: 'openWorld-false', annotations: { openWorldHint: false } },
  { key: 'ro+destructive', annotations: { readOnlyHint: true, destructiveHint: true } },
  { key: 'ro+openWorld', annotations: { readOnlyHint: true, openWorldHint: true } },
  { key: 'destructive-false+openWorld-false', annotations: { destructiveHint: false, openWorldHint: false } },
  { key: 'all-false', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { key: 'all-true', annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
  { key: 'non-boolean-hints', annotations: { destructiveHint: 'yes', openWorldHint: 1, readOnlyHint: 0 } }
]

const toolNameOf = (key) => `mcp__srv__${key.replace(/[^a-zA-Z0-9]+/g, '_')}`

for (const { key, annotations } of CASES) {
  const name = toolNameOf(key)
  ok(
    ext.mcpApprovalNeeded(annotations) === shared.mcpApprovalNeeded(annotations),
    `approval 一致：${key}`,
    `${ext.mcpApprovalNeeded(annotations)} vs ${shared.mcpApprovalNeeded(annotations)}`
  )
  ok(
    JSON.stringify(ext.mcpCallDanger(name, annotations)) === JSON.stringify(shared.mcpCallDanger(name, annotations)),
    `理由一致：${key}`,
    JSON.stringify(ext.mcpCallDanger(name, annotations))
  )
  ok(
    JSON.stringify(ext.mcpTarget(name)) === JSON.stringify(shared.mcpTarget(name)),
    `target 一致：${key}`
  )
}

ok(shared.mcpCallDanger('bash', { destructiveHint: true }).length === 0, '非 mcp__ 工具不产生 MCP 理由')

const requests = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch {}
    requests.push(payload)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload?.command === 'danger.confirm'
      ? { ok: true, summary: { kind: 'danger-confirm', allowed: true, decision: 'allow' } }
      : { ok: true, summary: {} }))
  })
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const hostUrl = `http://127.0.0.1:${server.address().port}`

const dataDir = await mkdtemp(join(tmpdir(), 'yan-mcp-approval-parity-'))
process.env.YAN_CLI_URL = hostUrl
process.env.YAN_CLI_TOKEN = 'test-token'
process.env.YAN_SESSION_ID = 'test-session'
process.env.YAN_PROJECT_ID = 'test-project'
process.env.YAN_DATA_DIR = dataDir
delete process.env.YAN_DANGER_GUARD

const writePrefs = (mode) => writeFile(join(dataDir, 'desktop.json'), JSON.stringify({ permissionMode: mode }), 'utf8')

const tools = CASES.map(({ key, annotations }) => {
  const entry = { name: toolNameOf(key) }
  if (annotations !== undefined) entry.annotations = annotations
  return entry
})
let handler
const fakePi = {
  on: (event, fn) => { if (event === 'tool_call') handler = fn },
  getAllTools: () => tools
}
ext.default(fakePi)
ok(typeof handler === 'function', '扩展注册了 tool_call 处理器')

const observedAsk = async (name) => {
  const before = requests.length
  await handler({ toolName: name, toolCallId: 'call-1', input: { arg: 1 } }, { cwd: 'C:/proj' })
  return requests.length > before
}

for (const mode of ['danger', 'all']) {
  await writePrefs(mode)
  for (const { key, annotations } of CASES) {
    const name = toolNameOf(key)
    const expected = shared.mcpCallReasons(name, annotations, mode).length > 0
    const asked = await observedAsk(name)
    ok(
      asked === expected,
      `处理器口径一致（${mode}）：${key}`,
      `asked=${asked} expected=${expected}`
    )
  }
}

await writePrefs('danger')

const baseCall = { server: 'srv', tool: 't', visibility: ['app'], cwd: 'C:/proj' }
const allowAsk = () => Promise.resolve({ choice: 'once' })
const denyAsk = () => Promise.resolve({ choice: 'deny' })

{
  const tracker = { calls: 0 }
  const result = await shared.approveAppViewCall(
    { ...baseCall, annotations: { readOnlyHint: true } },
    () => { tracker.calls += 1; return Promise.resolve({ choice: 'once' }) }
  )
  ok(result.allowed && result.asked && tracker.calls === 1 && result.recorded, '无宿主授权时只读调用先询问（不静默放行）')

  const trustedTracker = { calls: 0 }
  const now = Date.now()
  const trusted = await shared.approveAppViewCall(
    { ...baseCall, annotations: { readOnlyHint: true } },
    () => { trustedTracker.calls += 1; return Promise.resolve({ choice: 'once' }) },
    {
      serverFingerprint: 'f'.repeat(64),
      now,
      grants: [{ serverFingerprint: 'f'.repeat(64), scope: 'server', authorizer: 'user', expiresAt: now + 60_000 }]
    }
  )
  ok(trusted.allowed && !trusted.asked && trustedTracker.calls === 0, '有宿主 grant 的只读直接放行、不弹卡')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, denyAsk)
  ok(!result.allowed && result.asked && /拒绝/.test(result.reason ?? ''), '用户拒绝时视图调用被拒')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, () => Promise.resolve({ choice: 'once' }))
  ok(result.allowed && result.asked && result.recorded, '用户允许一次时视图调用放行')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, () => Promise.resolve({ choice: 'remember' }))
  ok(result.allowed, '允许并记住也视为放行')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { openWorldHint: true } }, () => Promise.reject(new Error('broken')))
  ok(!result.allowed && /没有得到用户确认/.test(result.reason ?? ''), '询问通道异常按无答复拒绝')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, () => Promise.resolve(null))
  ok(!result.allowed && /没有得到用户确认|拒绝/.test(result.reason ?? ''), 'ask 返回 null 判拒绝')
}

{
  let asked = false
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: ['model'], annotations: { destructiveHint: true } }, () => { asked = true; return Promise.resolve({ choice: 'once' }) })
  ok(!result.allowed && !asked && /未向 App 视图开放/.test(result.reason ?? ''), 'visibility 不含 app 直接拒绝、不弹卡')
}
{
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: undefined, annotations: { destructiveHint: true } }, allowAsk)
  ok(!result.allowed && /缺少 visibility/.test(result.reason ?? ''), '缺 visibility 按最严处理（不对 App 开放）')
}
{
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: 'app', annotations: { destructiveHint: true } }, allowAsk)
  ok(!result.allowed && /缺少 visibility/.test(result.reason ?? ''), 'visibility 非数组按缺省处理')
}
{
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: [], annotations: { destructiveHint: true } }, allowAsk)
  ok(!result.allowed && /未向 App 视图开放/.test(result.reason ?? ''), 'visibility 空数组视为不含 app')
}
{
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: ['model', 'app'], annotations: { destructiveHint: true } }, allowAsk)
  ok(result.allowed, 'visibility 含 app 且获允许时放行')
}

{
  let asked = false
  const result = await shared.approveAppViewCall({ ...baseCall, permissionMode: 'all', annotations: { destructiveHint: true } }, () => { asked = true; return Promise.resolve({ choice: 'deny' }) })
  ok(result.allowed && !asked && result.recorded && result.reasons.length > 0, 'all 档不拦截但仍记录风险')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: undefined }, denyAsk)
  ok(!result.allowed && result.asked, '缺注解按要问处理')
}

{
  const broker = new shared.ApprovalBroker({ canAsk: () => true, open: () => {}, close: () => {} })
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, _ms, ...rest) => realSetTimeout(fn, 0, ...rest)
  try {
    const choice = await broker.ask({ kind: 'danger', tool: 'mcp__srv__t', title: 't', detail: '{}', reasons: ['r'], cwd: '', canRemember: false })
    ok(choice === null, 'ApprovalBroker 超时判为无答复（null）')

    let askCalls = 0
    const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, () => {
      askCalls += 1
      return broker.ask({ kind: 'danger', tool: 'mcp__srv__t', title: 't', detail: '{}', reasons: ['r'], cwd: '', canRemember: false })
    })
    ok(askCalls === 1 && !result.allowed, '真实 broker 超时后视图调用判拒绝')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
}

{
  const broker = new shared.ApprovalBroker({ canAsk: () => false, open: () => {}, close: () => {} })
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, (request) => broker.ask(request))
  ok(!result.allowed && result.asked, '无可用窗口时视图调用判拒绝')
}

await new Promise((ready) => server.close(ready))
await rm(dataDir, { recursive: true, force: true })

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
