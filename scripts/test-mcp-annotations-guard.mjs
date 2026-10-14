/**
 * MCP 工具按注解进审批（resources/pi-extensions/danger-guard.js）的定向检查。
 *
 * 为什么现场加载扩展：注解分支藏在 `tool_call` 处理的调用次序里（模式档、内置判定、
 * 委派判定之后），只测纯函数测不到接线。这里用假 pi 注册处理器、用本机 HTTP 假宿主
 * 接 `danger.confirm`，真实走一遍「要问 / 不问」的分叉；不执行任何真实危险命令。
 *
 * 用法：node scripts/test-mcp-annotations-guard.mjs
 */
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

/* ---------------------------------------------------------------- 假宿主 */

const requests = []
let decision = 'allow'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch {}
    requests.push(payload)
    res.writeHead(200, { 'content-type': 'application/json' })
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

const writePrefs = (mode) => writeFile(join(dataDir, 'desktop.json'), JSON.stringify({ permissionMode: mode }), 'utf8')
await writePrefs('danger')

/* ---------------------------------------------------------------- 假 pi */

/* 形状对齐 pi 1.2.0：getAllTools() 每项带 name / annotations（只保留布尔 hint）。 */
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

/* ---------------------------------------------------------------- 注解规则 */

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
ok(hit.asked && hit.request?.params?.detail.length === 2000, 'MCP 参数即使含 prompt 仍遵守展示长度上限')

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

/* ---------------------------------------------------------------- 非 MCP 不变 */

hit = await call('bash', { command: 'rm -rf /' })
ok(hit.asked && hit.request?.params?.reasons?.some((r) => r.includes('递归删除大范围目录')), '内置 bash 高危判定不变')
ok(hit.request?.params?.detail === 'rm -rf /', '内置 bash 仍展示命令原文')

const toolsScannedBefore = getAllToolsCalls
hit = await call('bash', { command: 'npm test' })
ok(!hit.asked && hit.result === undefined, '内置 bash 普通命令不打扰')
ok(getAllToolsCalls === toolsScannedBefore, '内置工具调用不遍历 MCP 工具表（零开销）')

hit = await call('write', { path: '/etc/hosts' })
ok(hit.asked, '内置写入判定不变')

/* ---------------------------------------------------------------- 档位与开关 */

await writePrefs('all')
hit = await call('mcp__github__delete_repo', { repo: 'x' })
ok(!hit.asked && hit.result === undefined, '不受限制档直接放行 MCP 工具')
await writePrefs('danger')

process.env.YAN_DANGER_GUARD = '0'
hit = await call('mcp__github__delete_repo', { repo: 'x' })
ok(!hit.asked && hit.result === undefined, 'YAN_DANGER_GUARD=0 关闭整个护栏')
delete process.env.YAN_DANGER_GUARD

/* ---------------------------------------------------------------- 纯函数口径 */

ok(mod.mcpApprovalNeeded(undefined) === true, '缺注解按要问处理')
ok(mod.mcpApprovalNeeded({ readOnlyHint: true }) === false, '只读不问')
ok(mod.mcpApprovalNeeded({ readOnlyHint: true, destructiveHint: true }) === true, '只读 + 破坏要问')
ok(mod.mcpApprovalNeeded({ destructiveHint: false, openWorldHint: false }) === false, '非破坏且非开放世界不问')
ok(mod.mcpCallDanger('bash', {})?.length === 0, '非 mcp__ 工具不产生 MCP 理由')

/* ---------------------------------------------------------------- 收尾 */

await new Promise((ready) => server.close(ready))
await rm(dataDir, { recursive: true, force: true })
console.log(`${total} 项，${failures.length} 项失败`)
if (failures.length > 0) for (const name of failures) console.log(`  - ${name}`)
process.exit(failures.length ? 1 : 0)
