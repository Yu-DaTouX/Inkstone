#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-call-approval-'))
for (const [key, value] of Object.entries({ YAN_DATA_DIR: join(root, 'data'), YAN_PI_DIR: join(root, 'pi'), YAN_SESSIONS_DIR: join(root, 'sessions') })) {
  process.env[key] = value
}

const report = { pass: 0, fail: 0 }
async function check(message, fn) {
  try {
    await fn()
    report.pass += 1
    process.stdout.write(`  ✓ ${message}\n`)
  } catch (error) {
    report.fail += 1
    process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      loader: 'js',
      contents: [
        'export const shell = { openPath: async () => "" }',
        'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
        'export const ipcMain = { handle: () => undefined }',
        'export const BrowserWindow = class {}',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (value) => Buffer.from(String(value)), decryptString: (value) => Buffer.from(value).toString() }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
        'export const session = { defaultSession: {}, fromPartition: () => ({ setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined }) }'
      ].join('\n')
    }))
  }
}

const outfile = fileURLToPath(new URL('../out/test/mcp-call-approval.mjs', import.meta.url))
const entry = join(root, 'entry.ts')
const sourceOf = (relative) => fileURLToPath(new URL(relative, import.meta.url)).replace(/\\/g, '/')
await writeFile(entry, `export { AgentController } from '${sourceOf('../src/main/agent.ts')}'
export { confirmMcpCall } from '${sourceOf('../src/main/agent-commands/mcp-command.ts')}'`)
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [electronStub]
})

const { AgentController, confirmMcpCall } = await import(pathToFileURL(outfile).href)

function fakeManager(tool) {
  return {
    listToolsCached: async () => [
      {
        name: tool.name,
        description: 'fixture tool',
        inputSchema: { type: 'object', properties: {} },
        ...(tool.annotations ? { annotations: tool.annotations } : {})
      }
    ]
  }
}

function makeAgent({ permissionMode = 'danger', confirmDanger = null } = {}) {
  const agent = Object.create(AgentController.prototype)
  const asked = []
  agent.cwd = 'C:/proj'
  agent.rpcInstanceId = 'fixture-instance'
  agent.capabilityOpts = { runnerGeneration: 3 }
  agent.getPermissionMode = async () => permissionMode
  agent.confirmDanger = confirmDanger
    ? async (request) => {
        asked.push(request)
        return confirmDanger(request)
      }
    : undefined
  return { agent, asked }
}

const describeCall = (agent, manager, toolName = 'Click', params = { arguments: { x: 1 } }) =>
  confirmMcpCall(agent.commandHost, manager, 'windows-mcp', toolName, params)

process.stdout.write('\n▌yan mcp call 在自动批准档也要过一次审批\n')
await check('「不受限制」档不问，直接放行', async () => {
  const { agent, asked } = makeAgent({ permissionMode: 'all' })
  await describeCall(agent, fakeManager({ name: 'Click' }))
  assert.equal(asked.length, 0, 'permissionMode=all 不应弹审批')
})

await check('服务自报只读（readOnlyHint）不问', async () => {
  const { agent, asked } = makeAgent()
  await describeCall(agent, fakeManager({ name: 'Snapshot', annotations: { readOnlyHint: true } }), 'Snapshot')
  assert.equal(asked.length, 0, '只读工具不应弹审批')
})

await check('没有注解的工具在「自动批准」档弹审批', async () => {
  const { agent, asked } = makeAgent({ confirmDanger: async () => ({ decision: 'allow' }) })
  await describeCall(agent, fakeManager({ name: 'Click' }))
  assert.equal(asked.length, 1, '无注解工具应弹审批')
  assert.equal(asked[0].tool, 'yan mcp call')
  assert.equal(asked[0].cwd, 'C:/proj')
  assert.deepEqual(asked[0].owner, { instanceId: 'fixture-instance', generation: 3 })
  assert.ok(asked[0].detail.includes('windows-mcp / Click'), `详情应带服务与工具名：${asked[0].detail}`)
  assert.ok(Array.isArray(asked[0].reasons) && asked[0].reasons.length > 0, '应带危险原因')
})

await check('显式 readOnlyHint:false 也弹审批', async () => {
  const { agent, asked } = makeAgent({ confirmDanger: async () => ({ decision: 'allow' }) })
  await describeCall(agent, fakeManager({ name: 'Type', annotations: { readOnlyHint: false } }), 'Type')
  assert.equal(asked.length, 1)
})

await check('用户拒绝时抛 mcp_call_denied，不执行', async () => {
  const { agent } = makeAgent({ confirmDanger: async () => ({ decision: 'deny' }) })
  await assert.rejects(
    () => describeCall(agent, fakeManager({ name: 'Click' })),
    (error) => {
      assert.equal(error.name, 'CapabilityCommandError')
      assert.equal(error.code, 'mcp_call_denied')
      assert.ok(/没有得到用户确认/.test(error.message), error.message)
      return true
    }
  )
})

await check('拒绝理由带进错误消息', async () => {
  const { agent } = makeAgent({ confirmDanger: async () => ({ decision: 'deny', feedback: '别点这个按钮' }) })
  await assert.rejects(
    () => describeCall(agent, fakeManager({ name: 'Click' })),
    (error) => /别点这个按钮/.test(error.message) && error.code === 'mcp_call_denied'
  )
})

await check('没有审批通道（confirmDanger 未接线）时按拒绝处理', async () => {
  const { agent } = makeAgent()
  await assert.rejects(
    () => describeCall(agent, fakeManager({ name: 'Click' })),
    (error) => error.code === 'mcp_call_denied'
  )
})

await check('参数完整带进详情，不再截断', async () => {
  const { agent, asked } = makeAgent({ confirmDanger: async () => ({ decision: 'allow' }) })
  await describeCall(agent, fakeManager({ name: 'Click' }), 'Click', { arguments: { text: 'x'.repeat(5000) } })
  assert.equal(asked.length, 1)
  const tail = asked[0].detail.split('\n').slice(1).join('\n')
  assert.ok(tail.includes('x'.repeat(5000)), `详情参数应完整保留：${tail.length}`)
})

await check('参数超过审批上限时拒绝执行，不弹审批', async () => {
  const { agent, asked } = makeAgent({ confirmDanger: async () => ({ decision: 'allow' }) })
  await assert.rejects(
    () => describeCall(agent, fakeManager({ name: 'Click' }), 'Click', { arguments: { text: 'x'.repeat(21000) } }),
    (error) => error.code === 'mcp_call_too_long'
  )
  assert.equal(asked.length, 0)
})


