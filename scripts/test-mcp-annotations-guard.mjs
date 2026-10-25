import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let total = 0
const failures = []
const ok = (cond, name) => {
  total += 1
  if (!cond) {
    failures.push(name)
    console.log(`✗ ${name}`)
  }
}

const requests = []
let decision = 'allow'
const prefs = { mode: 'danger', outsideWrites: false, allowRoots: [] }
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch {}
    res.writeHead(200, { 'content-type': 'application/json' })
    if (payload?.command === 'danger.prefs') return res.end(JSON.stringify({ ok: true, summary: { kind: 'danger-prefs', ...prefs } }))
    requests.push(payload)
    res.end(JSON.stringify(payload?.command === 'danger.confirm'
      ? { ok: true, summary: { kind: 'danger-confirm', allowed: decision === 'allow', decision: decision === 'allow' ? 'allow' : 'deny' } }
      : { ok: true, summary: {} }))
  })
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const hostUrl = `http://127.0.0.1:${server.address().port}`

const dataDir = await mkdtemp(join(tmpdir(), 'yan-mcp-annotations-'))
process.env.YAN_CLI_URL = hostUrl
process.env.YAN_CLI_TOKEN = 'test-token'
process.env.YAN_SESSION_ID = 'test-session'
process.env.YAN_PROJECT_ID = 'test-project'
process.env.YAN_DATA_DIR = dataDir
delete process.env.YAN_DANGER_GUARD

const writePrefs = async (mode) => { prefs.mode = mode }
await writePrefs('danger')

const tools = [
  { name: 'mcp__github__search_code', annotations: { readOnlyHint: true } },
  { name: 'mcp__github__delete_repo', annotations: { destructiveHint: true } },
  { name: 'mcp__db__query' },
  { name: 'mcp__mail__send', annotations: { openWorldHint: true, destructiveHint: false } },
  { name: 'mcp__local__noop', annotations: { destructiveHint: false, openWorldHint: false } },
  { name: 'mcp__ghost__self', annotations: { readOnlyHint: true, destructiveHint: true } },
  { name: 'list_mcp_resources', annotations: { readOnlyHint: true } },
  { name: 'bash', annotations: {} }
]

let handler
let getAllToolsCalls = 0
const fakePi = {
  on: (event, fn) => { if (event === 'tool_call') handler = fn },
  getAllTools: () => { getAllToolsCalls += 1; return tools }
}

const mod = await import(pathToFileURL(resolve('resources/pi-extensions/danger-guard.js')).href)
mod.default(fakePi)
ok(typeof handler === 'function', '扩展注册了 tool_call 处理')

const call = async (toolName, input, extra = {}) => {
  const before = requests.length
  let result
  try {
    result = await handler({ toolName, toolCallId: 'call-1', input, ...extra }, { cwd: 'C:/proj' })
  } catch (err) {
    result = { thrown: String(err) }
  }
  const asked = requests.length > before
  return { asked, result, request: asked ? requests[requests.length - 1] : undefined }
}

let hit = await call('mcp__github__search_code', { query: 'x' })
ok(!hit.asked && hit.result === undefined, '只读 MCP 工具不问')

hit = await call('mcp__db__query', { sql: 'select 1' })
ok(hit.asked, '缺注解的 MCP 工具要问')
ok(hit.request?.params?.reasons?.some((r) => r.includes('MCP 工具可能修改数据或对外操作：db / query')), '缺注解的提示写明服务 / 工具')
ok(hit.request?.params?.detail === JSON.stringify({ sql: 'select 1' }), '审批卡片展示 MCP 参数 JSON')
ok(hit.result === undefined && hit.request?.command === 'danger.confirm', '放行时处理器不额外拦截')

hit = await call('mcp__unknown__thing', { a: 1 })
ok(hit.asked, 'getAllTools 里查不到的 MCP 工具要问')

const getAllTools = fakePi.getAllTools
fakePi.getAllTools = undefined
hit = await call('mcp__github__search_code', {})
ok(hit.asked, 'getAllTools 不可用时默认询问')
fakePi.getAllTools = () => { throw new Error('unavailable') }
hit = await call('mcp__github__search_code', {})
ok(hit.asked, '读取注解失败时默认询问')
fakePi.getAllTools = getAllTools

hit = await call('mcp__db__query', { prompt: 'x'.repeat(3000) })
ok(hit.asked && JSON.parse(hit.request?.params?.detail ?? '{}').prompt?.length === 3000, 'MCP 参数完整展示，不截断到 2000 字')
hit = await call('mcp__db__query', { prompt: 'x'.repeat(21000) })
ok(!hit.asked && hit.result?.block === true && String(hit.result?.reason).includes('超过 20000 字'), '超过 2 万字的审批内容直接拒绝，不截断后让用户批准')

hit = await call('mcp__ghost__self', {})
ok(hit.asked, '显式破坏即使同时标了只读也要问')

hit = await call('mcp__mail__send', { to: 'x@y.z' })
ok(hit.asked, '非破坏但 openWorld 的 MCP 工具要问')

hit = await call('mcp__local__noop', {})
ok(!hit.asked, '明确非破坏且非开放世界的 MCP 工具不问')

hit = await call('list_mcp_resources', { server: 'github' })
ok(!hit.asked, 'pi 资源工具（非 mcp__ 前缀）不问')

hit = await call('mcp__github__delete_repo', { repo: 'x' }, { parentToolCallId: 'call-outer' })
ok(hit.asked, 'codemode 内层 MCP 调用同样要问')

decision = 'deny'
hit = await call('mcp__github__delete_repo', { repo: 'x' })
ok(hit.result?.block === true && /MCP 工具可能修改数据或对外操作/.test(hit.result.reason ?? ''), '用户拒绝后拦下并说明原因')
decision = 'allow'

hit = await call('bash', { command: 'rm -rf /' })
ok(hit.asked && hit.request?.params?.reasons?.some((r) => r.includes('递归删除大范围目录')), '内置 bash 高危判定不变')
ok(hit.request?.params?.detail === 'rm -rf /', '内置 bash 仍展示命令原文')

const toolsScannedBefore = getAllToolsCalls
hit = await call('bash', { command: 'npm test' })
ok(!hit.asked && hit.result === undefined, '内置 bash 普通命令不打扰')
ok(getAllToolsCalls === toolsScannedBefore, '内置工具调用不遍历 MCP 工具表（零开销）')

hit = await call('write', { path: '/etc/hosts' })
ok(hit.asked, '内置写入判定不变')

await writePrefs('all')
hit = await call('mcp__github__delete_repo', { repo: 'x' })
ok(!hit.asked && hit.result === undefined, '不受限制档直接放行 MCP 工具')
await writePrefs('danger')

await writeFile(join(dataDir, 'desktop.json'), JSON.stringify({ permissionMode: 'all' }), 'utf8')
hit = await call('mcp__github__delete_repo', { repo: 'x' })
ok(hit.asked, '模型改写 desktop.json 不能把守卫升成不受限制（档位只认宿主）')

process.env.YAN_DANGER_GUARD = '0'
hit = await call('mcp__github__delete_repo', { repo: 'x' })
ok(!hit.asked && hit.result === undefined, 'YAN_DANGER_GUARD=0 关闭整个护栏')
delete process.env.YAN_DANGER_GUARD

ok(mod.mcpApprovalNeeded(undefined) === true, '缺注解按要问处理')
ok(mod.mcpApprovalNeeded({ readOnlyHint: true }) === false, '只读不问')
ok(mod.mcpApprovalNeeded({ readOnlyHint: true, destructiveHint: true }) === true, '只读 + 破坏要问')
ok(mod.mcpApprovalNeeded({ destructiveHint: false, openWorldHint: false }) === false, '非破坏且非开放世界不问')
ok(mod.mcpCallDanger('bash', {})?.length === 0, '非 mcp__ 工具不产生 MCP 理由')

await new Promise((ready) => server.close(ready))
await rm(dataDir, { recursive: true, force: true })
console.log(`${total} 项，${failures.length} 项失败`)
if (failures.length > 0) for (const name of failures) console.log(`  - ${name}`)
process.exit(failures.length ? 1 : 0)
