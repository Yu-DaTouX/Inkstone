import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-cancel-iso-'))
const fixture = resolve('scripts/fixtures/mcp-app-cancel-isolation-server.mjs')
const logPath = join(root, 'cancel.log')

const outfile = join(process.cwd(), 'out', 'test', 'mcp-cancel-isolation-bundle.mjs')
await build({
  stdin: {
    contents: "export * from './src/main/mcp/connection-manager';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  logLevel: 'silent'
})
const { McpConnectionManager } = await import(pathToFileURL(outfile).href)

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail !== undefined ? `（${detail}）` : ''}`)
  checks++
  console.log(`✓ ${message}`)
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const logText = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
const rejectOf = (promise) => promise.then(() => undefined, (error) => error)

const isRequestCancelled = (error) => error?.code === 'request-cancelled'

const unhandled = []
process.on('unhandledRejection', (reason) => unhandled.push(reason))

const managers = []
const stdioConfig = (id, extraEnv = {}) => ({
  id,
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  env: { YAN_CANCEL_FIXTURE_LOG: logPath, ...extraEnv }
})
const newManager = (configs, timeoutMs = 5000) => {
  const manager = new McpConnectionManager(configs, timeoutMs)
  managers.push(manager)
  return manager
}
const assertConnected = (manager, id, label) =>
  ok(manager.statusOf(id).status === 'ready', label, manager.statusOf(id).status)

const netPort = async (port) => {
  const net = await import('node:net')
  for (let i = 0; i < 80; i++) {
    const up = await new Promise((done) => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); done(true) })
      socket.once('error', () => { socket.destroy(); done(false) })
    })
    if (up) return true
    await delay(100)
  }
  return false
}

let httpChild
try {

  {
    const manager = newManager([stdioConfig('iso')])
    await manager.callTool('iso', 'echo', { text: 'warm' })
    assertConnected(manager, 'iso', 'stdio 取消：连接就绪')

    const controller = new AbortController()
    let aState = 'pending'
    const a = manager.callTool('iso', 'slow', {}, { signal: controller.signal }).then(
      () => (aState = 'resolved'),
      () => (aState = 'rejected')
    )
    await delay(120)
    const b = await manager.callTool('iso', 'echo', { text: 'b' })
    ok(b?.structuredContent?.echo === 'b', 'stdio 取消：同连接并发的 B 成功')
    controller.abort()
    await a
    ok(aState === 'rejected', 'stdio 取消：A 以失败结束（不会迟到成功）')
    await delay(150)
    ok(logText().includes('cancelled'), 'stdio 取消：服务端确实收到并处理了取消')
    assertConnected(manager, 'iso', 'stdio 取消：连接仍是 ready（没被 A 拆掉）')
    const after = await manager.callTool('iso', 'echo', { text: 'after' })
    ok(after?.structuredContent?.echo === 'after', 'stdio 取消：之后同一连接继续可用')
  }

  {
    const manager = newManager([stdioConfig('iso-t')])
    await manager.callTool('iso-t', 'echo', { text: 'warm' })
    const a = rejectOf(manager.callTool('iso-t', 'slow', {}, { timeoutMs: 120 }))
    const b = await manager.callTool('iso-t', 'echo', { text: 'b' })
    ok(b?.structuredContent?.echo === 'b', 'stdio 超时：同连接并发的 B 成功')
    const aErr = await a
    ok(isRequestCancelled(aErr) && /超时/.test(aErr.message), 'stdio 超时：A 是调用级超时错误', aErr?.message)
    assertConnected(manager, 'iso-t', 'stdio 超时：连接仍是 ready')
    const after = await manager.callTool('iso-t', 'echo', { text: 'after' })
    ok(after?.structuredContent?.echo === 'after', 'stdio 超时：之后同一连接继续可用')
  }

  {
    const manager = newManager([stdioConfig('iso-e')])
    await manager.callTool('iso-e', 'echo', { text: 'warm' })
    const aErrPromise = rejectOf(manager.callTool('iso-e', 'fail', {}))
    const b = await manager.callTool('iso-e', 'echo', { text: 'b' })
    ok(b?.structuredContent?.echo === 'b', 'stdio 错误：同连接并发的 B 成功')
    const aErr = await aErrPromise
    ok(aErr instanceof Error && !isRequestCancelled(aErr), 'stdio 错误：A 是请求级错误（非取消）', aErr?.message)
    assertConnected(manager, 'iso-e', 'stdio 错误：健康连接被保留（没有一律拆连接）')
    const after = await manager.callTool('iso-e', 'echo', { text: 'after' })
    ok(after?.structuredContent?.echo === 'after', 'stdio 错误：之后同一连接继续可用')
  }

  {
    const manager = newManager([stdioConfig('iso-die')], 5000)
    await manager.callTool('iso-die', 'echo', { text: 'warm' })
    const dying = manager.callTool('iso-die', 'die', {})
    const inFlight = manager.callTool('iso-die', 'slow', {})
    const [dieErr, slowErr] = await Promise.all([rejectOf(dying), rejectOf(inFlight)])
    ok(dieErr instanceof Error && slowErr instanceof Error, 'transport 死亡：连接上所有请求都失败')
    ok(
      manager.statusOf('iso-die').status === 'disconnected' || manager.statusOf('iso-die').status === 'needs-auth',
      'transport 死亡：状态如实反映为非 ready',
      manager.statusOf('iso-die').status
    )
    const revived = await manager.callTool('iso-die', 'echo', { text: 'revived' })
    ok(revived?.structuredContent?.echo === 'revived', 'transport 死亡：之后按需重连成功')
    assertConnected(manager, 'iso-die', 'transport 死亡：重连后连接 ready')
  }

  {
    const manager = newManager([stdioConfig('iso-idle')])
    await manager.callTool('iso-idle', 'echo', { text: 'warm' })
    assertConnected(manager, 'iso-idle', '空闲断线：先连上')
    await manager.callTool('iso-idle', 'exit', {})
    await delay(400)
    ok(
      manager.statusOf('iso-idle').status === 'disconnected',
      '空闲断线：服务退出后 onclose 及时把状态改为 disconnected',
      manager.statusOf('iso-idle').status
    )
    const revived = await manager.callTool('iso-idle', 'echo', { text: 'revived' })
    ok(revived?.structuredContent?.echo === 'revived', '空闲断线：随后的单次调用即重连成功（不先失败一次）')
    assertConnected(manager, 'iso-idle', '空闲断线：重连后连接 ready')
    await manager.disconnect('iso-idle')
    ok(manager.statusOf('iso-idle').status === 'disconnected', '显式 disconnect：立即变为 disconnected')
    const afterDisconnect = await manager.callTool('iso-idle', 'echo', { text: 'after-disconnect' })
    ok(afterDisconnect?.structuredContent?.echo === 'after-disconnect', '显式 disconnect：之后可重新握手')
  }

  {
    const manager = newManager([stdioConfig('iso-page', { YAN_CANCEL_FIXTURE_PAGE2_DELAY_MS: '350' })])
    const warm = await manager.listTools('iso-page')
    ok(warm.map((tool) => tool.name).join(',') === 'echo,slow,fail,die', '分页：完整分页拿到全部工具')
    const controller = new AbortController()
    const pending = manager.listTools('iso-page', { signal: controller.signal })
    await delay(120)
    controller.abort()
    const err = await rejectOf(pending)
    ok(isRequestCancelled(err), '分页取消：整次分页以调用级取消结束', err?.message)
    assertConnected(manager, 'iso-page', '分页取消：连接仍是 ready')
    const again = await manager.listTools('iso-page')
    ok(again.length === 4, '分页取消：之后同连接能重新完整分页')
  }

  {
    const manager = newManager([stdioConfig('iso-pre')])
    const controller = new AbortController()
    controller.abort()
    const err = await rejectOf(manager.callTool('iso-pre', 'echo', {}, { signal: controller.signal }))
    ok(isRequestCancelled(err), 'abort 前已取消：调用被拒', err?.message)
    ok(manager.statusOf('iso-pre').status === 'disconnected', 'abort 前已取消：没有为取消的调用建立连接')
  }

  {
    const manager = newManager([
      { id: 'raw', transport: 'stdio', command: process.execPath, args: [fixture, '--raw'], env: { YAN_CANCEL_FIXTURE_LOG: logPath, YAN_CANCEL_FIXTURE_RAW_DELAY_MS: '300' } }
    ])
    await manager.callTool('raw', 'echo', { text: 'warm' })
    const controller = new AbortController()
    let aState = 'pending'
    const a = manager.callTool('raw', 'slow', {}, { signal: controller.signal }).then(
      () => (aState = 'resolved'),
      () => (aState = 'rejected')
    )
    await delay(100)
    const b = await manager.callTool('raw', 'echo', { text: 'b' })
    ok(b?.structuredContent?.raw === true, 'raw：无视取消的服务端上，B 仍成功')
    controller.abort()
    await a
    ok(aState === 'rejected', 'raw：A 以取消结束')
    await delay(450)
    ok(aState === 'rejected', 'raw：迟到成功结果不会把已取消的调用变回成功')
    ok(logText().includes('cancelled-ignored') && logText().includes('late-result-sent'), 'raw：确实发生了「无视取消 + 迟到结果」')
    assertConnected(manager, 'raw', 'raw：迟到结果没有拆掉连接')
    const after = await manager.callTool('raw', 'echo', { text: 'after' })
    ok(after?.structuredContent?.raw === true, 'raw：之后同一连接继续可用')
  }

  {
    const manager = newManager([
      { id: 'raw-app', transport: 'stdio', command: process.execPath, args: [fixture, '--raw'], env: { YAN_CANCEL_FIXTURE_LOG: logPath, YAN_CANCEL_FIXTURE_RAW_DELAY_MS: '250' } }
    ])
    const warm = await manager.callTool('raw-app', 'echo', { text: 'warm' })
    const bPromise = manager.callTool('raw-app', 'slow', {}).then(
      (value) => ({ resolved: true, value }),
      (error) => ({ resolved: false, error })
    )
    await delay(30)
    const aErr = await rejectOf(manager.callTool('raw-app', 'app-error', {}))
    ok(
      aErr?.code === -32000 && /application error/.test(String(aErr?.message)),
      '应用 -32000：A 收到服务端应用错误（码值恰为 -32000）',
      aErr?.message
    )
    const b = await bPromise
    ok(
      b.resolved && b.value?.content?.[0]?.text === 'raw-late-done',
      '应用 -32000：并发的 B 没被拆，正常返回',
      b.resolved ? JSON.stringify(b.value).slice(0, 200) : b.error?.message
    )
    assertConnected(manager, 'raw-app', '应用 -32000：连接仍是 ready（没有仅凭码值判死）')
    const c = await manager.callTool('raw-app', 'echo', { text: 'c' })
    ok(
      c?.structuredContent?.raw === true && c.structuredContent.pid === warm?.structuredContent?.pid,
      '应用 -32000：随后 C 仍在同一 client（同进程）上正常调用',
      `warmPid=${warm?.structuredContent?.pid} cPid=${c?.structuredContent?.pid}`
    )
  }

  {
    const port = 39800 + Math.floor(Math.random() * 500)
    httpChild = spawn(process.execPath, [fixture, '--http'], {
      stdio: 'ignore',
      env: { ...process.env, YAN_CANCEL_FIXTURE_HTTP_PORT: String(port), YAN_CANCEL_FIXTURE_LOG: logPath }
    })
    ok(await netPort(port), 'HTTP：合成服务器真监听上了')
    const manager = newManager([{ id: 'iso-http', transport: 'http', url: `http://127.0.0.1:${port}/mcp` }])
    await manager.callTool('iso-http', 'echo', { text: 'warm' })
    const controller = new AbortController()
    let aState = 'pending'
    const a = manager.callTool('iso-http', 'slow', {}, { signal: controller.signal }).then(
      () => (aState = 'resolved'),
      () => (aState = 'rejected')
    )
    await delay(120)
    const b = await manager.callTool('iso-http', 'echo', { text: 'b' })
    ok(b?.structuredContent?.echo === 'b', 'HTTP 取消：同连接并发的 B 成功')
    controller.abort()
    await a
    ok(aState === 'rejected', 'HTTP 取消：A 以失败结束')
    assertConnected(manager, 'iso-http', 'HTTP 取消：连接仍是 ready')
    const after = await manager.callTool('iso-http', 'echo', { text: 'after' })
    ok(after?.structuredContent?.echo === 'after', 'HTTP 取消：之后同一连接继续可用')
    httpChild.kill('SIGTERM')
    httpChild = undefined
  }

  await delay(700)
  ok(unhandled.length === 0, '全程没有未处理的 Promise rejection', unhandled.map((e) => String(e?.message ?? e)).join(' | '))
  console.log(`\n按调用取消隔离：${checks} 项检查通过`)
} finally {
  await Promise.all(managers.map((manager) => manager.close().catch(() => undefined)))
  if (httpChild) httpChild.kill('SIGTERM')
  await delay(200)
  await rm(root, { recursive: true, force: true })
}
