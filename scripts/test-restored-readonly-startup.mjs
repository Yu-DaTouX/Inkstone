import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const source = readFileSync('src/main/index.ts', 'utf8')
const calls = ['startDataMaintenance(', 'startSessionPurgeSweep(', 'sweepCredentialFiles(', 'startDailyCredentialSweep(', 'sweepStaleTemps(', 'moveLegacyState(']
for (const call of calls) {
  const count = source.split(call).length - 1
  assert.equal(count, 1, `index.ts 里 ${call} 只启动一处，便于核对只读判断（实际 ${count} 处）`)
}
assert.match(source, /if \(!isRestoredReadonly\(\)\) stopMaintenance\.push\(startDataMaintenance\(/, '只读恢复实例不启动数据维护（检查点清理、附件进回收站等）')
assert.match(source, /if \(!isRestoredReadonly\(\)\) stopMaintenance\.push\(startSessionPurgeSweep\(\)\)/, '只读恢复实例不清理回收站与会话旁路数据')
const block = /if \(!isRestoredReadonly\(\)\) \{\n([\s\S]*?)\n {2}\}/.exec(source.slice(source.indexOf('sweepCredentialFiles(') - 200))
assert.ok(block, '凭据扫描、过期临时文件清扫与旧状态迁移在同一个只读判断块里')
for (const call of ['sweepCredentialFiles(', 'startDailyCredentialSweep(', 'sweepStaleTemps(', 'moveLegacyState(']) {
  assert.ok(block[1].includes(call), `只读恢复实例不执行 ${call.slice(0, -1)}`)
}
assert.match(source, /async function runShutdown\(\): Promise<void> \{\s*shuttingDown = true\s*for \(const stop of stopMaintenance\.splice\(0\)\) stop\(\)/, '退出先停止周期维护，再执行清理步骤')
assert.match(block[1], /stopMaintenance\.push\(startDailyCredentialSweep\(/, '退出时也取消每日凭据扫描')
await mkdir('out/test', { recursive: true })
const root = await mkdtemp(resolve('out/test/restored-readonly-'))
try {
  const outfile = join(root, 'fixture.mjs')
  await build({
    stdin: {
      contents: [
        'export { AgentController } from "./src/main/agent"',
        'export { registerAgentIpc } from "./src/main/ipc/agent-ipc"',
        'export { RESTORED_READONLY_ENV, restoredReadonlyMessage } from "./src/main/restored-readonly"'
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'electron-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'restored-fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'restored-fixture' }, () => ({ loader: 'js', contents: [
        'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false }',
        'export const shell = {}, dialog = {}, ipcMain = {}, safeStorage = {}, nativeImage = {}, session = {}',
        'export const BrowserWindow = class {}'
      ].join('\n') }))
    } }]
  })
  const { AgentController, registerAgentIpc, RESTORED_READONLY_ENV, restoredReadonlyMessage } = await import(pathToFileURL(outfile).href)
  const previous = process.env[RESTORED_READONLY_ENV]
  process.env[RESTORED_READONLY_ENV] = '1'
  try {
    const calls = { admission: 0, rpc: 0, messages: 0, push: 0, target: 0, compaction: 0 }
    const agent = Object.create(AgentController.prototype)
    agent.acp = {}
    agent.withExecutionAdmission = async () => { calls.admission++; return { ok: true } }
    agent.rpc = { command: async () => { calls.rpc++; return { success: true } } }
    agent.items = { appendMessage: () => { calls.messages++ } }
    agent.push = () => { calls.push++ }
    agent.listModels = async () => [{ id: 'fixture-model' }]
    const handlers = new Map()
    let registry
    registerAgentIpc({ handle: (ch, handler) => handlers.set(ch, handler) }, {
      runners: () => { calls.target++; return registry },
      normalizeExpectedRuntime: () => null,
      agentStatus: () => ({ fixture: true }),
      ac: () => agent,
      syncCompactionLines: async () => { calls.compaction++ }
    })
    const blocked = { ok: false, error: restoredReadonlyMessage() }
    assert.deepEqual(await agent.runBash('fixture-command'), blocked)
    const queue = { steering: [], followUp: [{ text: 'fixture-message' }] }
    for (const [method, arg] of [
      ['steer', 'fixture-message'], ['followUp', 'fixture-message'], ['steerIntoUserRun', 'fixture-message'],
      ['steerQueued', 'fixture-id'], ['removeQueued', 'fixture-id'], ['editQueue', { op: 'fixture' }],
      ['rewriteQueue', queue], ['planQueue', () => ({ next: queue })], ['restoreQueueSnapshot', queue]
    ]) assert.deepEqual(await agent[method](arg), blocked, method)
    for (const [channel, args] of [
      ['yan:runBash', ['fixture-command']],
      ['yan:send', ['fixture-message']],
      ['yan:steer', ['fixture-message']],
      ['yan:followUp', ['fixture-message']],
      ['yan:steerQueued', ['fixture-id']],
      ['yan:removeQueued', ['fixture-id']],
      ['yan:queueEdit', [{ op: 'fixture' }]],
      ['yan:queueEdit', [{ steering: [], followUp: [] }]],
      ['yan:respondUi', [{ id: 'fixture-approval' }]],
      ['yan:setModel', ['fixture-provider', 'fixture-model']],
      ['yan:start', []],
      ['yan:piInfo', []],
      ['yan:redetectPi', []]
    ]) assert.deepEqual(await handlers.get(channel)(...args), blocked, channel)
    assert.deepEqual(await handlers.get('yan:agentStatus')(), { fixture: true })
    assert.deepEqual(await handlers.get('yan:listModels')(), [{ id: 'fixture-model' }])
    assert.deepEqual(calls, { admission: 0, rpc: 0, messages: 0, push: 0, target: 0, compaction: 0 })
    registry = { activeRunner: () => ({ id: 'fixture' }), guardExecute: () => ({ ok: true }), agentOf: () => agent }
    process.env[RESTORED_READONLY_ENV] = '0'
    assert.deepEqual(await handlers.get('yan:runBash')('fixture-command'), { ok: true })
    assert.equal(calls.admission, 1)
  } finally {
    if (previous === undefined) delete process.env[RESTORED_READONLY_ENV]
    else process.env[RESTORED_READONLY_ENV] = previous
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('restored-readonly-startup: 全部通过')
