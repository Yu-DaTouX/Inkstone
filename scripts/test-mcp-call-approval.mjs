#!/usr/bin/env node
import './lib/test-isolate.mjs'
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
export { confirmMcpCall, runMcpCommand } from '${sourceOf('../src/main/agent-commands/mcp-command.ts')}'`)
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

const { AgentController, confirmMcpCall, runMcpCommand } = await import(pathToFileURL(outfile).href)

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

process.stdout.write('\n▌windows-mcp 的 save_path 不开放\n')
function runHost(serverId = 'windows-mcp') {
  const calls = []
  const asked = []
  const pin = { serverId: 'pin', conn: {}, epoch: 0 }
  const manager = {
    pinConnection: () => pin,
    listToolsCached: async () => ['Snapshot', 'Screenshot', 'Click'].map((name) => ({
      name,
      inputSchema: { type: 'object', properties: { save_path: { anyOf: [{ type: 'string' }, { type: 'null' }] }, use_vision: { type: 'boolean' } } },
      annotations: { readOnlyHint: name !== 'Click', destructiveHint: name === 'Click' }
    })),
    callTool: async (server, tool, args, options) => {
      calls.push({ server, tool, args, connection: options?.connection })
      return { content: [{ type: 'text', text: 'ok' }] }
    }
  }
  const host = {
    cwd: () => 'C:/proj',
    mcpConnectionManager: () => manager,
    mcpConfigError: () => undefined,
    permissionMode: async () => 'danger',
    confirmDanger: async (request) => { asked.push(request); return { decision: 'allow' } },
    approvalOwner: () => ({ instanceId: 'fixture', generation: 1 })
  }
  return { host, calls, asked, serverId, pin }
}

for (const tool of ['Snapshot', 'Screenshot']) {
  await check(`yan mcp call windows-mcp/${tool} 带 save_path 时拒绝且不执行`, async () => {
    const { host, calls, asked } = runHost()
    await assert.rejects(
      () => runMcpCommand(host, 'call', { server: 'windows-mcp', tool, arguments: { save_path: 'C:/Windows/x.png' } }),
      (error) => error.code === 'mcp_argument_blocked' && /save_path/.test(error.message) && /自动保存|already saves/.test(error.message)
    )
    assert.equal(calls.length, 0, '不应调用 windows-mcp')
    assert.equal(asked.length, 0, '不应弹审批')
  })
}

await check('args 别名与动作类工具同样拦下 save_path', async () => {
  const { host, calls, asked } = runHost()
  await assert.rejects(
    () => runMcpCommand(host, 'call', { server: 'windows-mcp', tool: 'Click', args: { save_path: 'D:/' } }),
    (error) => error.code === 'mcp_argument_blocked'
  )
  assert.equal(calls.length + asked.length, 0)
})

await check('save_path 为 null 或不带时照常执行', async () => {
  const { host, calls } = runHost()
  await runMcpCommand(host, 'call', { server: 'windows-mcp', tool: 'Snapshot', arguments: { use_vision: false, save_path: null } })
  await runMcpCommand(host, 'call', { server: 'windows-mcp', tool: 'Snapshot', arguments: { use_vision: false } })
  assert.equal(calls.length, 2)
})

await check('调用开始时定下的连接一路传给管理器，执行前由它核对', async () => {
  const { host, calls, pin } = runHost()
  await runMcpCommand(host, 'call', { server: 'windows-mcp', tool: 'Snapshot', arguments: { use_vision: false } })
  assert.equal(calls[0].connection, pin)
})

await check('其他 MCP 服务的同名参数不受影响', async () => {
  const { host, calls } = runHost()
  await runMcpCommand(host, 'call', { server: 'other-server', tool: 'Snapshot', arguments: { save_path: 'C:/proj/a.png' } })
  assert.equal(calls.length, 1)
})

process.stdout.write(`\n${report.pass} 通过，${report.fail} 失败\n`)
if (report.fail > 0) process.exitCode = 1


