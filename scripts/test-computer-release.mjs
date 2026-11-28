import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-computer-release-'))
for (const [key, value] of Object.entries({ YAN_DATA_DIR: join(root, 'data'), YAN_PI_DIR: join(root, 'pi'), YAN_SESSIONS_DIR: join(root, 'sessions') })) process.env[key] = value

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

const sourceOf = (relative) => fileURLToPath(new URL(relative, import.meta.url)).replace(/\\/g, '/')
const entry = join(root, 'entry.ts')
await writeFile(entry, `export { McpConnectionManager } from '${sourceOf('../src/main/mcp/connection-manager.ts')}'
export { sharedResources, INTERACTIVE_RESOURCE } from '${sourceOf('../src/main/interactive-resources.ts')}'
export { AgentController } from '${sourceOf('../src/main/agent.ts')}'
export { StreamLoopGuard, AutoContinueBudget } from '${sourceOf('../src/main/stream-loop-guard.ts')}'
export { runMcpCommand, COMPUTER_TOOL_TARGETS } from '${sourceOf('../src/main/agent-commands/mcp-command.ts')}'`)
const outfile = fileURLToPath(new URL('../out/test/computer-release.mjs', import.meta.url))
await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning', packages: 'external', plugins: [electronStub] })
const { McpConnectionManager, sharedResources, INTERACTIVE_RESOURCE, AgentController, StreamLoopGuard, AutoContinueBudget, runMcpCommand, COMPUTER_TOOL_TARGETS } = await import(pathToFileURL(outfile).href)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fixture = fileURLToPath(new URL('./fixtures/windows-mcp-control-server.mjs', import.meta.url))
let checks = 0
const warnings = []
const originalWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))

async function withManager(name, fn, { id = 'windows-mcp', failRelease = false, hangRelease = false } = {}) {
  const log = join(root, `${name}.log`)
  const manager = new McpConnectionManager([{
    id,
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: { WINDOWS_MCP_FIXTURE_LOG: log, ...(failRelease ? { WINDOWS_MCP_FIXTURE_FAIL_RELEASE: '1' } : {}), ...(hangRelease ? { WINDOWS_MCP_FIXTURE_HANG_RELEASE: '1' } : {}) }
  }])
  const calls = async () => (existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean) : [])
  try {
    await fn(manager, calls)
    checks++
  } finally {
    await manager.close()
    sharedResources.resolveUncertain?.(INTERACTIVE_RESOURCE)
  }
}

try {
  await withManager('never-started', async (manager, calls) => {
    assert.equal(await manager.releaseComputerControl(), 'skipped', '没调用过电脑工具时不释放')
    assert.deepEqual(await calls(), [], '没开过 windows-mcp 进程')
  })

  await withManager('observe-only', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Snapshot', { use_vision: false })
    await manager.callTool('windows-mcp', 'Wait', { duration: 1 })
    assert.equal(await manager.releaseComputerControl(), 'skipped', '只读工具不占控制，不调用 ControlStatus')
    assert.deepEqual(await calls(), ['Snapshot {"use_vision":false}', 'Wait {"duration":1}'])
  })

  await withManager('input-then-release', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Snapshot', {})
    await manager.callTool('windows-mcp', 'Click', { loc: [1, 2] })
    await manager.callTool('windows-mcp', 'Type', { text: 'x' })
    assert.equal(await manager.releaseComputerControl(), 'released')
    assert.equal(await manager.releaseComputerControl(), 'skipped', '释放一次后不重复调用')
    assert.deepEqual(await calls(), ['Snapshot {}', 'Click {"loc":[1,2]}', 'Type {"text":"x"}', 'ControlStatus {"release":true}'], '输入类工具之后才释放，且只释放一次')
  })

  await withManager('model-released', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Click', {})
    await manager.callTool('windows-mcp', 'ControlStatus', { release: true })
    assert.equal(await manager.releaseComputerControl(), 'skipped', '模型已主动释放时宿主不再调用')
    await manager.callTool('windows-mcp', 'Click', {})
    await manager.callTool('windows-mcp', 'ControlStatus', {})
    assert.equal(await manager.releaseComputerControl(), 'released', '只查状态不算释放')
    assert.deepEqual((await calls()).filter((line) => line.startsWith('ControlStatus')), ['ControlStatus {"release":true}', 'ControlStatus {}', 'ControlStatus {"release":true}'])
  })

  await withManager('close-releases', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'App', { mode: 'switch', name: 'x' })
    await manager.close()
    assert.deepEqual(await calls(), ['App {"mode":"switch","name":"x"}', 'ControlStatus {"release":true}'], '关闭连接（会话关闭、应用退出）前先释放')
  })

  await withManager('release-fails', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Click', {})
    const before = warnings.length
    assert.equal(await manager.releaseComputerControl(), 'failed', '释放失败不抛错')
    assert.ok(warnings.length > before && /release desktop control failed/.test(warnings.at(-1)), '失败只记日志')
    assert.equal((await calls()).at(-1), 'ControlStatus {"release":true}')
  }, { failRelease: true })

  await withManager('other-server', async (manager, calls) => {
    await manager.callTool('other', 'Click', {})
    assert.equal(await manager.releaseComputerControl(), 'skipped', '其他 MCP 服务的同名工具不触发')
    assert.deepEqual(await calls(), ['Click {}'])
  }, { id: 'other' })

  await withManager('idle-release', async (manager, calls) => {
    assert.equal(manager.computerIdleReleaseMs, 15_000, '默认空闲 15 秒释放')
    manager.computerIdleReleaseMs = 300
    await manager.callTool('windows-mcp', 'Click', {})
    await sleep(150)
    await manager.callTool('windows-mcp', 'Snapshot', {})
    await manager.callTool('windows-mcp', 'Type', { text: 'a' })
    await sleep(200)
    assert.ok(!(await calls()).some((line) => line.startsWith('ControlStatus')), '新的输入动作取消计时，只读动作不延长也不释放')
    await sleep(300)
    assert.deepEqual(await calls(), ['Click {}', 'Snapshot {}', 'Type {"text":"a"}', 'ControlStatus {"release":true}'], '最后一个输入动作结束后空闲到期释放一次')
    assert.equal(await manager.releaseComputerControl(), 'skipped', '空闲释放后回合结束不再重复')
  })

  await withManager('idle-after-model-release', async (manager, calls) => {
    manager.computerIdleReleaseMs = 200
    await manager.callTool('windows-mcp', 'Click', {})
    await manager.callTool('windows-mcp', 'ControlStatus', { release: true })
    await sleep(350)
    assert.deepEqual(await calls(), ['Click {}', 'ControlStatus {"release":true}'], '模型已释放时取消空闲计时')
  })

  await withManager('disconnect-releases', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Click', {})
    assert.equal(await manager.disconnect('windows-mcp'), true)
    assert.deepEqual(await calls(), ['Click {}', 'ControlStatus {"release":true}'], '设置里断开连接前先释放')
  })

  await withManager('sync-releases', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Click', {})
    const releases = manager.syncServers([])
    assert.equal(releases.length, 1)
    await releases[0].release
    assert.deepEqual(await calls(), ['Click {}', 'ControlStatus {"release":true}'], '关掉电脑操作或启动参数变化时先释放再关进程')
  })

  await withManager('sync-cancels-in-flight', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Snapshot', {})
    const slow = manager.callTool('windows-mcp', 'Click', { delay_ms: 30_000 })
    const outcome = slow.then(() => null, (error) => error)
    await sleep(300)
    const started = Date.now()
    const releases = manager.syncServers([], { cancelInFlight: '电脑操作已被关闭，进行中的操作已中止' })
    assert.equal(releases.length, 1)
    const error = await outcome
    const abortedAfter = Date.now() - started
    const closed = await releases[0].release
    assert.ok(abortedAfter < 5000, '关闭电脑操作后立即中止进行中的动作，不等它跑完：' + abortedAfter + 'ms')
    assert.ok(Date.now() - started < 25_000, '断开不等进行中的动作跑完（该动作要 30 秒）：' + (Date.now() - started) + 'ms')
    assert.equal(closed.confirmed, true)
    assert.equal(error?.name, 'McpRequestCancelledError', '进行中的电脑操作被中止')
    assert.match(error.message, /电脑操作已被关闭/, '中止时给出清楚的提示')
    assert.ok((await calls()).includes('ControlStatus {"release":true}'), '断开前先交还桌面控制')
    assert.equal(manager.statusOf('windows-mcp').status, 'error', '已不再登记该服务')
  })

  await withManager('queued-call-dies-after-tighten', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Snapshot', {})
    const slow = manager.callTool('windows-mcp', 'Snapshot', { delay_ms: 3000 })
    const slowOutcome = slow.then(() => null, (error) => error)
    await sleep(300)
    const pin = manager.pinConnection('windows-mcp')
    const queued = manager.callTool('windows-mcp', 'Type', { text: 'queued' }, { connection: pin })
    const queuedOutcome = queued.then(() => null, (error) => error)
    await sleep(100)
    const config = manager.list()[0]
    const releases = manager.syncServers([{ ...config, args: [...config.args, 'tightened'] }], { cancelInFlight: '权限模式已调低' })
    assert.equal((await slowOutcome)?.name, 'McpRequestCancelledError', '进行中的调用被中止')
    const error = await queuedOutcome
    assert.equal(error?.name, 'McpRequestCancelledError', '排在锁后面的调用不在新连接上执行')
    assert.match(error.message, /权限已调低，操作已中止|Permissions were tightened/)
    await Promise.all(releases.map((item) => item.release))
    const logged = await calls()
    assert.ok(!logged.some((line) => line.startsWith('Type')), '排队调用没有发到服务端：' + logged.join('|'))
    const late = manager.callTool('windows-mcp', 'Snapshot', {}, { connection: pin })
    assert.equal((await late.then(() => null, (e) => e))?.name, 'McpRequestCancelledError', '旧连接的凭据过期后不能再用')
  })

  await withManager('abort-computer-calls-without-config-change', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Snapshot', {})
    const slow = manager.callTool('windows-mcp', 'Click', { delay_ms: 3000 })
    const slowOutcome = slow.then(() => null, (error) => error)
    await sleep(300)
    const pin = manager.pinConnection('windows-mcp')
    const queued = manager.callTool('windows-mcp', 'Type', { text: 'queued' }, { connection: pin })
    const queuedOutcome = queued.then(() => null, (error) => error)
    await sleep(100)
    manager.abortComputerCalls('急停')
    assert.match((await slowOutcome)?.message ?? '', /急停/, '配置没变也中止进行中的调用')
    assert.ok((await queuedOutcome) instanceof Error, '输入类调用被中止后资源待核实，排队的调用不执行')
    assert.ok(!(await calls()).some((line) => line.startsWith('Type')))
    assert.equal(manager.heldControl, false, '急停后不再持有控制')
    sharedResources.resolveUncertain?.(INTERACTIVE_RESOURCE)
    assert.equal((await manager.callTool('windows-mcp', 'Snapshot', {})).content[0].text, 'ok:Snapshot', '急停之后新发起的调用可正常执行')
  })

  await withManager('abort-cancels-queued-pinned-call', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Snapshot', {})
    const slow = manager.callTool('windows-mcp', 'Snapshot', { delay_ms: 3000 })
    const slowOutcome = slow.then(() => null, (error) => error)
    await sleep(300)
    const pin = manager.pinConnection('windows-mcp')
    const queued = manager.callTool('windows-mcp', 'Type', { text: 'queued' }, { connection: pin })
    const queuedOutcome = queued.then(() => null, (error) => error)
    await sleep(100)
    manager.abortComputerCalls('急停')
    assert.match((await slowOutcome)?.message ?? '', /急停/)
    const error = await queuedOutcome
    assert.equal(error?.name, 'McpRequestCancelledError', '配置没变时排队的调用同样以权限已调低失败')
    assert.match(error.message, /权限已调低，操作已中止|Permissions were tightened/)
    assert.ok(!(await calls()).some((line) => line.startsWith('Type')))
  })

  await withManager('removal-without-message-still-cancels', async (manager) => {
    await manager.callTool('windows-mcp', 'Snapshot', {})
    const slow = manager.callTool('windows-mcp', 'Click', { delay_ms: 3000 })
    const slowOutcome = slow.then(() => null, (error) => error)
    await sleep(300)
    const releases = manager.syncServers([])
    assert.equal((await slowOutcome)?.name, 'McpRequestCancelledError', '无提示的普通同步发现 windows-mcp 被移除也中止进行中的调用')
    await Promise.all(releases.map((item) => item.release))
  })

  await withManager('sync-without-cancel-keeps-in-flight', async (manager) => {
    const slow = manager.callTool('windows-mcp', 'Click', { delay_ms: 400 })
    await sleep(100)
    assert.equal(manager.isBusy(), true, '没有 cancelInFlight 时进行中的调用照常算忙')
    assert.equal((await slow).content[0].text, 'ok:Click', '调用跑完且未被中止')
    assert.equal(manager.isBusy(), false)
  })

  await withManager('approval-releases-first', async (manager, calls) => {
    const agent = Object.create(AgentController.prototype)
    agent.mcp = { current: () => manager, connectionManager: () => manager, configError: () => undefined }
    agent.cwd = root
    agent.rpcInstanceId = 'fixture'
    agent.capabilityOpts = { runnerGeneration: 1 }
    agent.getPermissionMode = async () => 'danger'
    const seenAtApproval = []
    const asked = []
    agent.confirmDanger = async (request) => {
      asked.push(request)
      seenAtApproval.push(await calls())
      return { decision: 'allow' }
    }
    await manager.callTool('windows-mcp', 'Click', {})
    await runMcpCommand(agent.commandHost, 'call', { server: 'windows-mcp', tool: 'Type', arguments: { text: 'b' }, via: 'computer_type', toolCall: { id: 'tc-1', cwd: root, subagent: false } })
    assert.deepEqual(seenAtApproval[0], ['Click {}', 'ControlStatus {"release":true}'], '弹审批卡时控制已经交还')
    assert.equal(asked[0].tool, 'computer_type', '审批卡显示实际工具名')
    assert.deepEqual(await calls(), ['Click {}', 'ControlStatus {"release":true}', 'Type {"text":"b"}'])
    await runMcpCommand(agent.commandHost, 'call', { server: 'windows-mcp', tool: 'Type', arguments: { text: 'c' }, via: 'computer_type' })
    assert.equal(asked[1].tool, 'yan mcp call', '没有 toolCall（命令行）时不信 via')
    assert.equal(seenAtApproval[1].at(-1), 'ControlStatus {"release":true}', '第二张审批前也先释放')
  })

  await withManager('defer-during-input', async (manager, calls) => {
    const agent = Object.create(AgentController.prototype)
    agent.mcp = { current: () => manager, connectionManager: () => manager, configError: () => undefined }
    agent.cwd = root
    agent.rpcInstanceId = 'fixture'
    agent.capabilityOpts = { runnerGeneration: 1 }
    agent.getPermissionMode = async () => 'danger'
    const seen = []
    agent.confirmDanger = async () => { seen.push(await calls()); return { decision: 'deny' } }
    await manager.callTool('windows-mcp', 'Snapshot', {})
    const slow = manager.callTool('windows-mcp', 'Click', { delay_ms: 400 })
    await sleep(100)
    const started = Date.now()
    await agent.commandHost.confirmDanger({ tool: 'bash', detail: 'x', reasons: [], cwd: root, owner: {} })
    assert.ok(Date.now() - started < 200, '有输入动作在跑时不等它，审批卡照常弹出')
    assert.deepEqual(seen[0], ['Snapshot {}', 'Click {"delay_ms":400}'], '弹卡时不抢先释放、不打断该动作')
    await slow
    await sleep(150)
    assert.deepEqual(await calls(), ['Snapshot {}', 'Click {"delay_ms":400}', 'ControlStatus {"release":true}'], '该动作结束后立即释放（不等 15 秒）')
    assert.equal(await manager.releaseComputerControl(), 'skipped')
  })

  await withManager('release-bounded', async (manager, calls) => {
    await manager.callTool('windows-mcp', 'Click', {})
    const started = Date.now()
    assert.equal(await manager.releaseComputerControl(), 'failed', '服务不回应时按失败处理')
    const took = Date.now() - started
    assert.ok(took >= 2500 && took < 4500, `释放最多等约 3 秒：${took}ms`)
    assert.equal((await calls()).at(-1), 'ControlStatus {"release":true}')
  }, { hangRelease: true })

  {
    const { createComputerTools } = await import(pathToFileURL(fileURLToPath(new URL('../resources/pi-extensions/computer-tools.js', import.meta.url))).href)
    const sent = []
    for (const tool of createComputerTools(async (input) => { sent.push([input.params.via, input.params.tool]); return { ok: true, data: { text: '' } } })) await tool.execute('t', {}, undefined, undefined, {})
    assert.deepEqual(Object.fromEntries(sent), COMPUTER_TOOL_TARGETS, '审批卡标签表与 computer_* 工具一一对应')
    checks++
  }

  await withManager('via-must-match', async (manager) => {
    const asked = []
    const host = {
      cwd: () => root,
      mcpConnectionManager: () => manager,
      mcpConfigError: () => undefined,
      permissionMode: async () => 'danger',
      confirmDanger: async (request) => { asked.push(request.tool); return { decision: 'allow' } },
      approvalOwner: () => ({})
    }
    const toolCall = { id: 'tc', cwd: root, subagent: false }
    await runMcpCommand(host, 'call', { server: 'windows-mcp', tool: 'Click', arguments: {}, via: 'computer_snapshot', toolCall })
    await runMcpCommand(host, 'call', { server: 'windows-mcp', tool: 'Click', arguments: {}, via: 'computer_click', toolCall })
    await runMcpCommand(host, 'call', { server: 'windows-mcp', tool: 'Click', arguments: {}, via: 'toString', toolCall })
    assert.deepEqual(asked, ['yan mcp call', 'computer_click', 'yan mcp call'], 'via 与实际工具不符时按命令行请求显示')
  })

  {
    const make = (name, env = {}) => {
      const log = join(root, `${name}.log`)
      const manager = new McpConnectionManager([{ id: 'windows-mcp', transport: 'stdio', command: process.execPath, args: [fixture], env: { WINDOWS_MCP_FIXTURE_LOG: log, ...env } }])
      return { manager, calls: async () => (existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean) : []) }
    }
    const holderA = make('cross-a')
    const holderFail = make('cross-fail', { WINDOWS_MCP_FIXTURE_FAIL_RELEASE: '1' })
    const observer = make('cross-observer')
    const asker = make('cross-asker')
    try {
      await holderA.manager.callTool('windows-mcp', 'Click', {})
      await holderFail.manager.callTool('windows-mcp', 'Type', { text: 'x' })
      await observer.manager.callTool('windows-mcp', 'Snapshot', {})
      await asker.manager.callTool('windows-mcp', 'Snapshot', {})
      const agent = Object.create(AgentController.prototype)
      agent.mcp = { current: () => asker.manager }
      await agent.releaseBeforeAsking()
      assert.equal((await holderA.calls()).at(-1), 'ControlStatus {"release":true}', '会话 B 弹卡前释放会话 A 占用的控制')
      assert.equal((await holderFail.calls()).at(-1), 'ControlStatus {"release":true}', '释放失败的实例也被调用且不抛错')
      assert.deepEqual(await observer.calls(), ['Snapshot {}'], '只读、没占用控制的实例不被调用')
      assert.deepEqual(await asker.calls(), ['Snapshot {}'], '提问方自己没占用时也不调用')
      await agent.releaseBeforeAsking()
      assert.equal((await holderA.calls()).filter((line) => line.startsWith('ControlStatus')).length, 1, '已释放的实例不重复调用')
    } finally {
      for (const item of [holderA, holderFail, observer, asker]) await item.manager.close()
      sharedResources.resolveUncertain?.(INTERACTIVE_RESOURCE)
    }
    checks++
  }

  {
    const released = []
    const agent = new AgentController({ cwd: root, piBin: join(root, 'missing-pi.js'), push: () => {} })
    agent.mcp = { current: () => ({ releaseComputerControl: async () => { released.push('release'); return 'released' } }) }
    const answer = agent.ui.requestHostUi({ method: 'select', title: 'Q?', options: ['A', 'B'], timeout: 60_000 })
    assert.equal(released.length, 1, '弹提问/选择前释放')
    agent.ui.rejectPendingHostUi('done')
    await answer.catch(() => undefined)
    checks++
  }

  {
    const released = []
    const fakePi = join(root, 'exit-pi.mjs')
    await writeFile(fakePi, 'setTimeout(() => process.exit(3), 50)\n')
    const agent = new AgentController({ cwd: root, piBin: fakePi, push: () => {} })
    agent.mcp = { current: () => ({ releaseComputerControl: async () => { released.push('release'); return 'released' } }), close: async () => {}, closeRetired: async () => {}, configError: () => undefined, connectionManager: () => undefined }
    await agent.start().catch(() => undefined)
    const end = Date.now() + 5000
    while (!released.length && Date.now() < end) await sleep(20)
    assert.ok(released.length >= 1, 'pi 退出时释放')
    await agent.stop().catch(() => undefined)
    checks++
  }

  {
    const released = []
    const agent = Object.create(AgentController.prototype)
    agent.mcp = { current: () => ({ releaseComputerControl: async () => { released.push('release'); return 'released' } }) }
    agent.autoContinue = new AutoContinueBudget()
    agent.loopGuard = new StreamLoopGuard()
    agent.cancelImages = () => {}
    agent.cancelApprovals = () => { released.push('cancel-approvals') }
    agent.approvalOwner = () => ({})
    agent.terminalTurnStop = new AbortController()
    agent.turn = { terminal: 'completed', messageIds: [] }
    agent.stream = { streaming: null }
    agent.agentRunning = true
    agent.items = { uiMessages: () => [] }
    agent.queue = { clearForStop: async () => ({ steering: [], followUp: [] }) }
    agent.bash = null
    agent.capabilityOpts = { runnerGeneration: 1 }
    agent.state = { sessionId: 's' }
    agent.rpc = { command: async () => ({ success: false, error: 'pi stuck' }) }
    const result = await agent.abortCurrent()
    assert.equal(result.error, 'pi stuck')
    assert.deepEqual(released, ['cancel-approvals', 'release'], '停止时在撤审批之后、等 abort 之前释放，abort 失败也已释放')
    checks++
  }

  {
    const released = []
    const agent = Object.create(AgentController.prototype)
    agent.mcp = { current: () => ({ releaseComputerControl: async () => { released.push('release'); return 'released' } }) }
    agent.liveItemEdits = 0
    agent.loopGuard = new StreamLoopGuard()
    agent.autoContinue = new AutoContinueBudget()
    agent.emitRunSignals = () => {}
    agent.persistTurnTiming = async () => {}
    agent.syncDeferredModelSwitch = () => {}
    agent.refreshStats = async () => null
    agent.turn = { terminal: 'completed', startedMono: undefined }
    agent.handleEvent({ type: 'agent_end', willRetry: true })
    assert.equal(released.length, 0, '还要重试的 agent_end 不释放')
    agent.handleEvent({ type: 'agent_end' })
    assert.equal(released.length, 1, '回合结束释放')

    agent.clearPendingModelChange = () => {}
    agent.items = { discardStreaming: () => {} }
    agent.markStreaming = () => {}
    agent.setAgentRunning = () => {}
    agent.queue = { reset: () => {} }
    agent.operations = { reset: () => {} }
    agent.acp = { resetScope: () => {} }
    agent.stream = {}
    agent.resetSessionScope()
    assert.equal(released.length, 2, '会话切换/新建/分叉时释放')

    agent.mcp = { current: () => undefined }
    agent.handleEvent({ type: 'agent_end' })
    assert.equal(released.length, 2, '没有 MCP 连接（没开电脑操作）时什么都不做')
    checks++
  }

  console.log(`computer-release: ${checks} groups passed`)
} finally {
  console.warn = originalWarn
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
