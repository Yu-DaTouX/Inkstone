import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'

await mkdir('.tmp/backend-boundaries', { recursive: true })
const root = await mkdtemp(resolve('.tmp/backend-boundaries/run-'))
for (const [key, value] of Object.entries({
  YAN_DATA_DIR: join(root, 'data'), YAN_PI_DIR: join(root, 'pi'), YAN_SESSIONS_DIR: join(root, 'sessions'),
  TMP: join(root, 'temp'), TEMP: join(root, 'temp'), TMPDIR: join(root, 'temp')
})) process.env[key] = value
process.env.YAN_CLI_URL = ''
process.env.YAN_CLI_TOKEN = ''
await mkdir(join(root, 'temp'), { recursive: true })
const entry = join(root, 'entry.ts')
const source = (path) => JSON.stringify(resolve(path).replaceAll('\\', '/'))
await writeFile(entry, [
  `export { AgentController } from ${source('src/main/agent.ts')}`,
  `export { SubagentService } from ${source('src/main/subagent-service.ts')}`,
  `export { ApprovalBroker } from ${source('src/main/approval-broker.ts')}`,
  `export { McpConnectionManager } from ${source('src/main/mcp/connection-manager.ts')}`,
  `export * from ${source('src/main/capability-server.ts')}`,
  `export * from ${source('src/main/capabilities/acquired-skills.ts')}`,
  `export { patchSettings } from ${source('src/main/settings.ts')}`
].join('\n'))
const outfile = join(root, 'fixture.mjs')
await build({
  entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{ name: 'electron-fixture', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: [
      'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
      'export const shell = { openPath: async () => "" }',
      'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
      'export const ipcMain = { handle: () => {} }',
      'export const BrowserWindow = class {}',
      'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(String(value)), decryptString: value => Buffer.from(value).toString() }',
      'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
      'export const session = { defaultSession: {}, fromPartition: () => ({ setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} }) }'
    ].join('\n') }))
  } }]
})
const mod = await import(pathToFileURL(outfile).href)
let passed = 0
function ok(value, label) {
  assert.ok(value, label)
  passed++
  console.log(`✓ ${label}`)
}
async function test(label, run) {
  await run()
  ok(true, label)
}
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const project = join(root, 'project')
const outside = join(root, 'outside', 'file.txt')
await mkdir(project, { recursive: true })
await mkdir(join(root, 'outside'), { recursive: true })
await writeFile(outside, 'outside fixture')
await writeFile(join(project, 'file.txt'), 'project fixture')
await mod.patchSettings({ guardOutsideWrites: true, permissionMode: 'danger', guardAllowRoots: [] })

const own = { id: 'sub-a1a1a1a1', name: 'own', parentSessionId: 'parent-a', status: 'running', transcript: [], deliverables: [] }
const foreign = { ...own, id: 'sub-b2b2b2b2', parentSessionId: 'parent-b' }
let fullReads = 0
let stops = 0
let starts = []
const controller = {
  setContext() {}, list: () => [own, foreign, { ...own, id: 'sub-c3c3c3c3', parentSessionId: undefined }],
  get: id => [own, foreign].find(run => run.id === id),
  getFull: async id => { fullReads++; return controller.get(id) },
  stop: async () => { stops++; return { ok: true } },
  start: async (_task, _model, isolation) => { starts.push({ isolation }); return { ok: true, run: own } }
}
const service = new mod.SubagentService({ resolveModelLabel: async () => ({ ok: true, label: 'fixture/fixture' }) })
service.get = async () => controller
const context = { cwd: project, parentSessionId: 'parent-a', parentRpcInstanceId: 'fixture-owner' }
await test('子代理列表、详情和停止只能访问当前父会话', async () => {
  const listed = await service.run('subagent.list', {}, context)
  assert.deepEqual(listed.data.map(run => run.id), [own.id])
  for (const action of ['get', 'stop']) {
    await assert.rejects(service.run(`subagent.${action}`, { id: foreign.id }, context), { code: 'subagent_not_found' })
    await assert.rejects(service.run(`subagent.${action}`, { id: own.id }, { cwd: project }), { code: 'subagent_not_found' })
  }
  assert.equal(fullReads, 0)
  assert.equal(stops, 0)
  await service.run('subagent.get', { id: own.id }, context)
  await service.run('subagent.stop', { id: own.id }, context)
  assert.equal(fullReads, 1)
  assert.equal(stops, 1)
  assert.deepEqual((await service.run('subagent.list', {}, { cwd: project })).data, [])
})

const server = new mod.CapabilityServer({ handlers: { run: (command, params) => service.run(command, params, context) }, opsDir: join(root, 'capability') })
const binding = { sessionId: 'parent-a', projectId: 'fixture-project' }
const connection = await server.start(binding)
const request = body => fetch(connection.url, {
  method: 'POST', headers: { authorization: `Bearer ${connection.token}` },
  body: JSON.stringify(body), signal: AbortSignal.timeout(3000)
})
try {
  await test('真实 CLI 的只读参数、显式 false 和非法值不会静默变为可写', async () => {
    const run = promisify(execFile)
    const cli = resolve('resources/yan-cli/yan.mjs')
    const env = { ...process.env, YAN_CLI_URL: connection.url, YAN_CLI_TOKEN: connection.token, YAN_SESSION_ID: binding.sessionId, YAN_PROJECT_ID: binding.projectId }
    await run(process.execPath, [cli, 'subagent', '--help'], { env, timeout: 5000 })
    for (const [flags, isolation] of [
      [['--read-only'], 'controlled-cwd'], [['--read-only', 'true'], 'controlled-cwd'],
      [['--readOnly', 'true'], 'controlled-cwd'], [['--read-only', 'false'], 'shared-cwd'], [[], 'shared-cwd']
    ]) {
      await run(process.execPath, [cli, 'subagent', 'start', '--task', 'fixture', ...flags], { env, timeout: 5000 })
      assert.equal(starts.at(-1).isolation, isolation)
    }
    for (const value of ['yes', '1', 1, null, {}, []]) {
      const count = starts.length
      await assert.rejects(service.run('subagent.start', { task: 'fixture', readOnly: value }, context), { code: 'subagent_read_only_invalid' })
      assert.equal(starts.length, count)
    }
  })
  await test('异常 JSON 顶层和 params 返回 400，后续请求保持可用', async () => {
    for (const body of [null, [], true, 1, 'text']) assert.equal((await request(body)).status, 400)
    for (const params of [null, [], true, 1, 'text']) {
      assert.equal((await request({ ...binding, apiVersion: 1, command: 'subagent.list', params })).status, 400)
    }
    assert.equal((await request({ ...binding, apiVersion: 1, command: 'subagent.list', params: {} })).status, 200)
  })
  await test('请求处理异常有 500 兜底，不形成未处理拒绝', async () => {
    const handle = server.handle
    server.handle = async () => { throw new Error('fixture') }
    try {
      const response = await request({})
      assert.equal(response.status, 500)
      assert.deepEqual(await response.json(), { ok: false, error: 'internal_error' })
    } finally { server.handle = handle }
  })
} finally { server.stop() }

function agentWith(manager, permissionMode = 'all') {
  const agent = Object.create(mod.AgentController.prototype)
  agent.cwd = project
  agent.rpcInstanceId = 'fixture-owner'
  agent.capabilityOpts = { runnerGeneration: 1 }
  agent.getPermissionMode = async () => permissionMode
  agent.mcpConnectionManager = () => manager
  return agent
}
function managerWith(callTool, readOnly = true) {
  return {
    list: () => [{ id: 'fixture' }],
    listToolsCached: async () => [{ name: 'observe', inputSchema: { type: 'object' }, annotations: { readOnlyHint: readOnly } }],
    callTool
  }
}
const mcpParams = { server: 'fixture', tool: 'observe', arguments: {} }
await test('已取消的 MCP 请求不读取工具清单、不调用工具', async () => {
  let called = 0
  const manager = managerWith(async () => { called++; return {} })
  manager.listToolsCached = async () => { called++; return [] }
  const cancel = new AbortController()
  cancel.abort()
  await assert.rejects(agentWith(manager).runCapabilityCommand('mcp.call', mcpParams, cancel.signal), { code: 'mcp_cancelled' })
  assert.equal(called, 0)
})
await test('MCP 执行中取消会传到工具调用', async () => {
  const entered = deferred()
  const cancel = new AbortController()
  const manager = managerWith((_server, _tool, _args, options) => new Promise((_resolve, reject) => {
    assert.equal(options.signal, cancel.signal)
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    entered.resolve()
  }))
  const pending = agentWith(manager).runCapabilityCommand('mcp.call', mcpParams, cancel.signal)
  await entered.promise
  cancel.abort()
  await assert.rejects(pending, { code: 'mcp_cancelled' })
})
await test('MCP 工具清单缓存不吞取消信号，已取消时不返回缓存', async () => {
  const manager = Object.create(mod.McpConnectionManager.prototype)
  manager.toolCache = new Map()
  manager.connections = new Map()
  const cancel = new AbortController()
  manager.listTools = async (_server, options) => { assert.equal(options.signal, cancel.signal); return [] }
  await manager.listToolsCached('fixture', { signal: cancel.signal })
  cancel.abort()
  await assert.rejects(manager.listToolsCached('fixture', { signal: cancel.signal }), { code: 'request-cancelled' })
})
await test('取消 MCP 审批会关闭该请求，不影响其他审批，也不会调用工具', async () => {
  const opened = deferred()
  let calls = 0
  const broker = new mod.ApprovalBroker({ canAsk: () => true, open: request => opened.resolve(request), close() {} })
  const cancel = new AbortController()
  const agent = agentWith(managerWith(async () => { calls++; return {} }, false), 'danger')
  agent.confirmDanger = async request => {
    const answer = await broker.ask({ kind: 'danger', tool: request.tool, title: 'fixture', detail: request.detail, reasons: [], cwd: project, canRemember: false }, request.signal)
    return answer ? { decision: 'allow' } : null
  }
  try {
    const pending = agent.runCapabilityCommand('mcp.call', mcpParams, cancel.signal)
    await opened.promise
    const other = broker.ask({ kind: 'danger', tool: 'other', title: 'other', detail: '', reasons: [], cwd: project, canRemember: false })
    cancel.abort()
    await assert.rejects(pending, { code: 'mcp_cancelled' })
    assert.equal(broker.list().length, 1)
    assert.equal(broker.list()[0].tool, 'other')
    broker.cancel(() => true)
    assert.equal(await other, null)
    assert.equal(calls, 0)
    const count = broker.list().length
    assert.equal(await broker.ask({ kind: 'danger', tool: 'canceled', title: '', detail: '', reasons: [], cwd: project, canRemember: false }, cancel.signal), null)
    assert.equal(broker.list().length, count)
  } finally { broker.cancel(() => true) }
})

await test('回收站对目录外批量操作先审批，拒绝或无通道均不移动任何文件', async () => {
  const moved = []
  const agent = agentWith(null, 'danger')
  agent.capabilityOpts.trashItem = async path => { moved.push(path) }
  await assert.rejects(agent.runFileTrashCommand({ paths: ['file.txt', outside] }), { code: 'trash_outside_denied' })
  assert.deepEqual(moved, [])
  let asked = 0
  agent.confirmDanger = async request => { asked++; assert.deepEqual(request.outsideDirs, [outside]); return { decision: 'deny' } }
  await assert.rejects(agent.runFileTrashCommand({ path: outside }), { code: 'trash_outside_denied' })
  assert.equal(asked, 1)
  assert.deepEqual(moved, [])
  agent.confirmDanger = async () => ({ decision: 'allow' })
  await agent.runFileTrashCommand({ path: outside })
  assert.deepEqual(moved, [outside])
  agent.confirmDanger = async () => assert.fail('项目内文件不应审批')
  await agent.runFileTrashCommand({ path: 'file.txt' })
  await mod.patchSettings({ guardAllowRoots: [join(root, 'outside')] })
  await agent.runFileTrashCommand({ path: outside })
  await mod.patchSettings({ guardAllowRoots: [] })
  agent.getPermissionMode = async () => 'all'
  await agent.runFileTrashCommand({ path: outside })
})
await test('回收站识别项目内目录链接指向的目录外文件', async () => {
  const link = join(project, 'linked-outside')
  await symlink(join(root, 'outside'), link, process.platform === 'win32' ? 'junction' : 'dir')
  const agent = agentWith(null, 'danger')
  agent.capabilityOpts.trashItem = async () => assert.fail('目录链接不能绕过目录外保护')
  await assert.rejects(agent.runFileTrashCommand({ path: join(link, 'file.txt') }), { code: 'trash_outside_denied' })
})
await test('取消回收站审批后不会移动文件', async () => {
  const agent = agentWith(null, 'danger')
  agent.capabilityOpts.trashItem = async () => assert.fail('已取消操作不能移动文件')
  const cancel = new AbortController()
  agent.confirmDanger = async () => { cancel.abort(); return { decision: 'allow' } }
  await assert.rejects(agent.runFileTrashCommand({ path: outside }, cancel.signal), error => error.name === 'AbortError')
})

const skillRoot = join(root, 'skills')
const install = (name, sessionId = 'parallel') => mod.installAcquiredSkill({
  root: skillRoot, scope: 'session', sessionId, name, description: 'Fixture',
  files: [{ path: 'SKILL.md', content: new TextEncoder().encode(`# ${name}`) }], source: { candidateId: `fixture-${name}` }
})
await test('并发安装、读取、删除和提升技能不会丢索引或互相覆盖', async () => {
  const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
  for (let round = 0; round < 3; round++) {
    const sessionId = `parallel-${round}`
    await Promise.all(names.map(name => install(name, sessionId)))
    assert.deepEqual((await mod.listSessionSkills(skillRoot, sessionId)).map(skill => skill.name).sort(), [...names].sort())
    await Promise.all([mod.removeSessionSkill(skillRoot, sessionId, 'alpha'), install('omega', sessionId), mod.listSessionSkills(skillRoot, sessionId)])
    const results = await Promise.allSettled([
      mod.promoteSessionSkill(skillRoot, sessionId, 'beta'),
      mod.promoteSessionSkill(skillRoot, sessionId, 'beta'),
      install('theta', sessionId)
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
    const listed = (await mod.listSessionSkills(skillRoot, sessionId)).map(skill => skill.name).sort()
    assert.deepEqual(listed, ['gamma', 'delta', 'epsilon', 'zeta', 'omega', 'theta'].sort())
    assert.ok(existsSync(join(skillRoot, 'skills', 'beta', 'SKILL.md')))
    await rm(join(skillRoot, 'skills', 'beta'), { recursive: true })
  }
})
await test('技能索引写失败明确保留恢复路径，失败后队列仍可继续', async () => {
  const base = mod.sessionSkillsDir(skillRoot, 'broken')
  await mkdir(join(base, 'index.json'), { recursive: true })
  await assert.rejects(install('recoverable', 'broken'), error => error.code === 'index-write' && error.message.includes(join(base, 'recoverable')))
  assert.ok(existsSync(join(base, 'recoverable', 'SKILL.md')))
  await rm(join(base, 'index.json'), { recursive: true })
  await install('recoverable', 'broken')
  assert.equal((await mod.listSessionSkills(skillRoot, 'broken')).length, 1)
})

console.log(`backend capability boundaries: ${passed} assertions/groups passed (local fixtures only)`)
