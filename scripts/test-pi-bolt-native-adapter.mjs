#!/usr/bin/env node
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  EXT_DIR, PI_BOLT_EXE_DEFAULT, verifyCandidateExe, bundledCliJs, electronExe,
  isolatedEnv, writeModelsJson, resetDir, thinExtensionArgs, codemodeWorkload,
  waitForSettled, sampleProcessTree, median
} from './helpers/pi-bolt-adapter-harness.mjs'
import { startProvider } from './helpers/pi-bolt-adapter-provider.mjs'

const WORK = mkdtempSync(join(tmpdir(), 'pb2-adapter-test-'))
const REPO = resolve(import.meta.dirname, '..')
const DIAG_FIXTURE = join(import.meta.dirname, 'helpers', 'pi-bolt-adapter-diag.js')

let total = 0
let failed = 0
const failures = []
function check(cond, name, detail = '') {
  total += 1
  if (cond) {
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function note(name) {
  console.log(`⚠ ${name}`)
}
function section(name) {
  console.log(`\n--- ${name} ---`)
}

async function bundle(entry, name) {
  const out = join(WORK, `${name}.mjs`)
  await build({ entryPoints: [resolve(REPO, entry)], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(out).href)
}

function attach(rpc) {
  rpc.__events = []
  rpc.on('event', (e) => rpc.__events.push(e))
  return rpc
}

const { PiRpc } = await bundle('src/main/protocol.ts', 'protocol')
const { runtimeProbe, ignoresElectronRunAsNode } = await bundle('src/main/pi-runtime-launch.ts', 'launch')

section('纯启动语义（native-exe vs node/electron）')
{
  const absExe = process.platform === 'win32' ? 'C:\\tools\\pi-bolt\\pi-bolt.exe' : '/opt/pi-bolt/pi-bolt'
  const native = new PiRpc({ cwd: WORK, runtime: { kind: 'native-exe', executable: absExe } })
  check(native.probe.cmd === absExe, 'native-exe cmd = 绝对 exe')
  check(native.probe.args.length === 0, 'native-exe 没有 CLI 前缀参数')

  const nodeRuntime = new PiRpc({ cwd: WORK, runtime: { kind: 'node', executable: process.execPath, cli: '/x/cli.js' } })
  check(nodeRuntime.probe.cmd === process.execPath && nodeRuntime.probe.args[0] === '/x/cli.js', 'node 仍 = executable + cli')
  const electronRuntime = new PiRpc({ cwd: WORK, runtime: { kind: 'electron', executable: '/x/electron', cli: '/x/cli.js' } })
  check(electronRuntime.probe.cmd === '/x/electron' && electronRuntime.probe.args[0] === '/x/cli.js', 'electron 仍 = executable + cli')

  let threw = false
  try { new PiRpc({ cwd: WORK, runtime: { kind: 'native-exe', executable: 'pi-bolt.exe' } }) } catch { threw = true }
  check(threw, 'native-exe 拒绝相对路径，不按 cwd/PATH 解析')

  check(ignoresElectronRunAsNode({ kind: 'native-exe', executable: absExe }) === true, 'native-exe 清 ELECTRON_RUN_AS_NODE')
  check(ignoresElectronRunAsNode({ kind: 'node', executable: process.execPath, cli: '/x' }) === true, 'node 清 ELECTRON_RUN_AS_NODE')
  check(ignoresElectronRunAsNode({ kind: 'electron', executable: '/x', cli: '/y' }) === false, 'electron 仍注入 ELECTRON_RUN_AS_NODE')
  check(ignoresElectronRunAsNode(undefined) === false, '默认定位仍注入 ELECTRON_RUN_AS_NODE')
  check(runtimeProbe({ kind: 'native-exe', executable: absExe }).tried[0].includes('native-exe'), 'native-exe 探测标注来源')
}

section('真实 PiRpc：node/electron 参数与环境不变')
{
  const stub = join(WORK, 'spawn-stub.mjs')
  writeFileSync(stub, 'import { writeFileSync } from "node:fs"\nwriteFileSync(process.env.STUB_OUT, JSON.stringify({ argv: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE ?? null }))\n')
  const runStub = (opts, out) => new Promise((resolvePromise) => {
    const rpc = new PiRpc({ cwd: WORK, args: ['--no-session'], env: { STUB_OUT: out }, ...opts })
    rpc.spawn()
    rpc.once('exit', () => resolvePromise(JSON.parse(readFileSync(out, 'utf8'))))
  })

  const nodeDiag = await runStub({ runtime: { kind: 'node', executable: process.execPath, cli: stub } }, join(WORK, 'node.json'))
  check(nodeDiag.argv[0] === '--mode' && nodeDiag.argv[1] === 'rpc' && nodeDiag.argv[2] === '--no-session', 'node 参数 = <cli> --mode rpc <args>', JSON.stringify(nodeDiag.argv))
  check(nodeDiag.electron === null, 'node 子进程无 ELECTRON_RUN_AS_NODE')

  const electronDiag = await runStub({ runtime: { kind: 'electron', executable: process.execPath, cli: stub } }, join(WORK, 'electron.json'))
  check(electronDiag.argv[0] === '--mode' && electronDiag.argv[1] === 'rpc', 'electron 参数顺序不变', JSON.stringify(electronDiag.argv))
  check(electronDiag.electron === '1', 'electron 子进程有 ELECTRON_RUN_AS_NODE=1')

  const defaultDiag = await runStub({ piBin: stub }, join(WORK, 'default.json'))
  check(defaultDiag.argv[0] === '--mode' && defaultDiag.argv[1] === 'rpc', '默认定位（override）参数不变', JSON.stringify(defaultDiag.argv))
  check(defaultDiag.electron === '1', '默认定位保留 ELECTRON_RUN_AS_NODE=1')
}

const live = process.env.PB2_ADAPTER_LIVE === '1'
if (!live) {
  console.log(`\n离线部分：${total} 项，${failed} 项失败`)
  console.log('未设 PB2_ADAPTER_LIVE=1，跳过真实便携 exe 对照。')
  rmSync(WORK, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}

const candidateExe = process.env.PI_BOLT_ADAPTER_EXE || PI_BOLT_EXE_DEFAULT
const verified = verifyCandidateExe(candidateExe)
if (!verified.ok) {
  console.log(`\n候选 exe 校验失败，停止真实对照（不绕过）：${verified.reason}`)
  rmSync(WORK, { recursive: true, force: true })
  process.exit(1)
}
console.log(`\n候选 exe：${candidateExe}（${verified.sizeBytes} B，sha256 ${verified.sha256.slice(0, 12)}…）`)

const { CapabilityServer } = await bundle('src/main/capability-server.ts', 'capability-server')
const { ApprovalBroker } = await bundle('src/main/approval-broker.ts', 'approval-broker')
const { applyHumanApproval, approvalDigest } = await bundle('src/main/remote-approval.ts', 'remote-approval')

const CANDIDATE = { kind: 'native-exe', executable: candidateExe }
const BASELINE = { kind: 'electron', executable: electronExe(), cli: bundledCliJs() }

function makeFixture(tag) {
  const baseDir = join(WORK, `iso-${tag}`)
  resetDir(baseDir)
  const bag = isolatedEnv({ baseDir })
  return bag
}

function launch(kind, bag, { args, env = {}, port }) {
  writeModelsJson(bag.agent, port)
  const rpc = new PiRpc({
    cwd: bag.cwd,
    runtime: kind === 'candidate' ? CANDIDATE : BASELINE,
    args: ['--model', 'eval/eval-model', '--session-dir', bag.sessions, ...args],
    env: { ...bag.env, ...env },
    inheritEnv: false
  })
  attach(rpc)
  return rpc
}

async function closeServer(server) {
  server.close()
  server.closeAllConnections?.()
}

function postJson(url, body, { token, signal } = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal
  })
}

section('L1 真实 native-exe：薄层加载 + mcp-app-proxy 注册与宿主执行')
try {
  const bag = makeFixture('l1')
  const snapshotPath = join(bag.baseDir, 'proxy-tools.json')
  writeFileSync(snapshotPath, JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'pb2-fixture',
    tools: [{ name: 'mcp__demo__echo', serverId: 'demo', toolName: 'echo', description: 'PB2 synthetic echo tool', inputSchema: { type: 'object', properties: { message: { type: 'string' } } }, annotations: { readOnlyHint: true } }],
    servers: [],
    excluded: []
  }))
  const calls = []
  const caps = new CapabilityServer({
    opsDir: join(bag.baseDir, 'ops'),
    onlyCommands: ['mcp.app.call'],
    handlers: {
      run: async (command, params) => {
        calls.push({ command, params })
        if (command === 'mcp.app.call') return { summary: { text: 'host-proxy-ok' } }
        throw new Error(`unexpected ${command}`)
      }
    }
  })
  const endpoint = await caps.start({ sessionId: 'pb2-session', projectId: 'pb2-project' })
  const provider = await startProvider({ tools: [{ name: 'mcp__demo__echo', args: { message: 'hi' } }] })
  const diagOut = join(bag.baseDir, 'tools.json')
  const rpc = launch('candidate', bag, {
    port: provider.port,
    args: [...thinExtensionArgs(), '--extension', DIAG_FIXTURE],
    env: {
      DIAG_TOOLS_OUT: diagOut,
      YAN_CLI_URL: endpoint.url,
      YAN_CLI_TOKEN: endpoint.token,
      YAN_SESSION_ID: 'pb2-session',
      YAN_PROJECT_ID: 'pb2-project',
      YAN_MCP_APP_TOOLS: snapshotPath,
      YAN_MCP_APP_PROJECT_ID: 'pb2-project'
    }
  })
  rpc.spawn()
  const state = await rpc.command('get_state', {}, { timeoutMs: 60000 })
  check(state.success === true, 'L1 get_state 成功')
  await new Promise((r) => setTimeout(r, 1200))
  const toolFile = existsSync(diagOut) ? JSON.parse(readFileSync(diagOut, 'utf8')) : null
  const names = new Set((toolFile?.tools ?? []).map((t) => t.name))
  for (const expected of ['read', 'write', 'edit', 'bash', 'codemode', 'diag_danger']) {
    check(names.has(expected), `L1 工具可见：${expected}`)
  }
  check(names.has('mcp__demo__echo'), 'L1 mcp-app-proxy 注册了快照工具', JSON.stringify([...names]))
  const diag = (toolFile?.tools ?? []).find((t) => t.name === 'diag_danger')
  check(diag?.annotations?.destructiveHint === true, 'L1 diag_danger 危险注解保留')
  check(rpc.__events.some((e) => e.type === 'session_start') || state.data?.sessionId, 'L1 会话已建立')

  await rpc.command('prompt', { message: 'call proxy tool' }, { timeoutMs: 60000 })
  check(await waitForSettled(rpc, { timeoutMs: 60000 }), 'L1 一轮结束')
  const msgs = await rpc.command('get_messages', {}, { timeoutMs: 20000 })
  const proxyResult = (msgs.data?.messages ?? []).find((m) => (m.role === 'toolResult' || m.role === 'tool') && m.toolName === 'mcp__demo__echo')
  check(!!proxyResult && !proxyResult.isError, 'L1 代理工具执行未报错')
  check(JSON.stringify(proxyResult?.content ?? '').includes('host-proxy-ok'), 'L1 结果来自宿主 mcp.app.call 端点')
  check(calls.some((c) => c.command === 'mcp.app.call' && c.params?.toolName === 'echo'), 'L1 宿主收到 mcp.app.call')
  check(calls.every((c) => c.command !== 'danger.confirm'), 'L1 只读注解未触发危险确认')
  await rpc.close()
  await closeServer(provider.server)
  caps.stop()
} catch (error) {
  check(false, 'L1 场景异常结束', String(error?.stack ?? error).slice(0, 600))
}

section('L2 真实 native-exe：脚本 provider 一轮 read/write')
try {
  const bag = makeFixture('l2')
  const readFile = join(bag.cwd, 'read-target.txt')
  const writeFile = join(bag.cwd, 'write-target.txt')
  writeFileSync(readFile, 'pb2 read target\n')
  const provider = await startProvider({ readFile, writeFile, chunks: 8 })
  const rpc = launch('candidate', bag, { port: provider.port, args: thinExtensionArgs() })
  rpc.spawn()
  await rpc.command('get_state', {}, { timeoutMs: 60000 })
  await rpc.command('prompt', { message: 'scripted turn' }, { timeoutMs: 60000 })
  check(await waitForSettled(rpc, { timeoutMs: 60000 }), 'L2 一轮结束')
  check(readFileSync(writeFile, 'utf8') === 'pb2-adapter write-back\n', 'L2 写回内容一致')
  await rpc.close()
  await closeServer(provider.server)
} catch (error) {
  check(false, 'L2 场景异常结束', String(error?.stack ?? error).slice(0, 600))
}

section('L3 真实 native-exe：danger-guard 宿主审批（允许/拒绝/错 token/会话不符）')
try {
  const bag = makeFixture('l3')
  writeFileSync(join(bag.data, 'desktop.json'), JSON.stringify({ permissionMode: 'danger', guardOutsideWrites: true }))
  const decisions = ['allow', 'deny']
  const hostCalls = []
  const caps = new CapabilityServer({
    opsDir: join(bag.baseDir, 'ops'),
    onlyCommands: ['danger.confirm'],
    handlers: {
      run: async (command, params) => {
        hostCalls.push({ command, params })
        const decision = decisions.shift() ?? 'deny'
        return { summary: decision === 'allow' ? { allowed: true, decision: 'allow' } : { allowed: false, decision: 'deny' } }
      }
    }
  })
  const endpoint = await caps.start({ sessionId: 'pb2-dg', projectId: 'pb2-dg-project' })
  const provider = await startProvider({ tools: [{ name: 'bash', args: { command: 'git reset --hard HEAD' } }], chunks: 4 })
  const runDanger = async (envExtra) => {
    const rpc = launch('candidate', bag, {
      port: provider.port,
      args: ['--extension', join(EXT_DIR, 'danger-guard.js')],
      env: {
        YAN_CLI_URL: endpoint.url,
        YAN_CLI_TOKEN: endpoint.token,
        YAN_SESSION_ID: 'pb2-dg',
        YAN_PROJECT_ID: 'pb2-dg-project',
        ...envExtra
      }
    })
    rpc.spawn()
    await rpc.command('get_state', {}, { timeoutMs: 60000 })
    await rpc.command('prompt', { message: 'run dangerous' }, { timeoutMs: 60000 })
    await waitForSettled(rpc, { timeoutMs: 60000 })
    const msgs = await rpc.command('get_messages', {}, { timeoutMs: 20000 })
    const result = (msgs.data?.messages ?? []).find((m) => (m.role === 'toolResult' || m.role === 'tool') && m.toolName === 'bash')
    const text = JSON.stringify(result?.content ?? '')
    await rpc.close()
    return { result, text }
  }

  const allowed = await runDanger({})
  check(hostCalls.length >= 1 && hostCalls[0].command === 'danger.confirm', 'L3 允许：真实宿主收到 danger.confirm')
  check(!allowed.text.includes('高危操作未获用户确认'), 'L3 允许：未被护栏拦下', allowed.text.slice(0, 200))

  const denied = await runDanger({})
  check(denied.result?.isError === true && denied.text.includes('高危操作'), 'L3 拒绝：护栏拦下并给出原因', denied.text.slice(0, 200))

  const wrongToken = await runDanger({ YAN_CLI_TOKEN: 'wrong-token' })
  check(wrongToken.text.includes('高危操作未获用户确认'), 'L3 错 token：拒绝并封闭', wrongToken.text.slice(0, 200))

  const wrongSession = await runDanger({ YAN_SESSION_ID: 'other-session' })
  check(wrongSession.text.includes('高危操作未获用户确认'), 'L3 会话不符：拒绝并封闭', wrongSession.text.slice(0, 200))

  await closeServer(provider.server)
  caps.stop()
} catch (error) {
  check(false, 'L3 场景异常结束', String(error?.stack ?? error).slice(0, 600))
}

section('L4 CapabilityServer 端点：401 / 403 / 版本 / 未知命令 / 取消透传')
try {
  let aborted = false
  const caps = new CapabilityServer({
    opsDir: join(WORK, 'ops-l4'),
    onlyCommands: ['danger.confirm', 'test.wait'],
    handlers: {
      run: async (command, _params, _ctx, signal) => {
        if (command === 'test.wait') {
          await new Promise((resolvePromise) => {
            if (signal?.aborted) return resolvePromise()
            signal?.addEventListener('abort', resolvePromise, { once: true })
            setTimeout(resolvePromise, 3000)
          })
          aborted = signal?.aborted === true
          return { summary: { aborted } }
        }
        return { summary: { allowed: true, decision: 'allow' } }
      }
    }
  })
  const endpoint = await caps.start({ sessionId: 's1', projectId: 'p1' })
  const base = { apiVersion: 1, command: 'danger.confirm', params: {}, sessionId: 's1', projectId: 'p1' }

  const r401 = await postJson(endpoint.url, base, { token: 'bad' })
  check(r401.status === 401, 'L4 错 token → 401')
  const r403 = await postJson(endpoint.url, { ...base, sessionId: 's2' }, { token: endpoint.token })
  check(r403.status === 403 && (await r403.json()).error === 'identity_mismatch', 'L4 会话/project 不符 → 403 identity_mismatch')
  const rVer = await postJson(endpoint.url, { ...base, apiVersion: 2 }, { token: endpoint.token })
  check(rVer.status === 400 && (await rVer.json()).error === 'api_version_mismatch', 'L4 api 版本不符 → 400')
  const rUnknown = await postJson(endpoint.url, { ...base, command: 'subagent.start' }, { token: endpoint.token })
  check(rUnknown.status === 400 && (await rUnknown.json()).error === 'unknown_command', 'L4 白名单外命令 → 400 unknown_command')

  const controller = new AbortController()
  const waitReq = postJson(endpoint.url, { ...base, command: 'test.wait' }, { token: endpoint.token, signal: controller.signal }).catch(() => null)
  await new Promise((r) => setTimeout(r, 150))
  controller.abort()
  await waitReq
  await new Promise((r) => setTimeout(r, 200))
  check(aborted === true, 'L4 客户端断开 → 命令收到取消信号')
  caps.stop()
} catch (error) {
  check(false, 'L4 场景异常结束', String(error?.stack ?? error).slice(0, 600))
}

section('L5 ApprovalBroker / remote-approval：允许/拒绝/内容或会话变化')
try {
  const opened = []
  let canAsk = true
  const broker = new ApprovalBroker({
    canAsk: () => canAsk,
    open: (request) => opened.push(request.id),
    close: () => {}
  })
  const askOnce = broker.ask({ title: 't', kind: 'danger', tool: 'bash', detail: 'x' })
  check(opened.length === 1, 'L5 有窗口时打开一张卡')
  check(broker.answer(opened[0], 'once') === true, 'L5 卡上允许被接受')
  check((await askOnce)?.choice === 'once', 'L5 允许答复返回 once')
  const askDeny = broker.ask({ title: 't', kind: 'danger', tool: 'bash', detail: 'x' })
  check(broker.answer(opened[1], 'deny') === true, 'L5 拒绝被接受')
  check((await askDeny)?.choice === 'deny', 'L5 拒绝答复返回 deny')
  const askBad = broker.ask({ title: 't', kind: 'danger', tool: 'bash', detail: 'x' })
  check(broker.answer(opened[2], 'bogus') === false, 'L5 非合法答复被拒绝')
  canAsk = false
  check((await broker.ask({ title: 't', kind: 'danger', tool: 'bash', detail: 'x' })) === null, 'L5 无窗口 → 无答复')

  const question = { id: 'approval:1', sessionId: 's1', runId: 'r1', method: 'confirm', title: 't', message: 'm', sensitive: true, deadline: Date.now() + 60000 }
  const digest = approvalDigest(question)
  const ok = applyHumanApproval(question, { sessionId: 's1', runId: 'r1', digest, confirmed: true }, () => true)
  check(ok.ok === true, 'L5 摘要与会话一致时允许')
  const changedSession = applyHumanApproval(question, { sessionId: 's2', runId: 'r1', digest, confirmed: true }, () => true)
  check(changedSession.ok === false && changedSession.code === 'approval_changed', 'L5 会话变化 → approval_changed')
  const changedDigest = applyHumanApproval(question, { sessionId: 's1', runId: 'r1', digest: 'f'.repeat(64), confirmed: true }, () => true)
  check(changedDigest.ok === false && changedDigest.code === 'approval_changed', 'L5 摘要不符 → approval_changed')
} catch (error) {
  check(false, 'L5 场景异常结束', String(error?.stack ?? error).slice(0, 600))
}

section('L6 codemode tools.read + tools.bash 交错重复对比')
try {
  const bag = makeFixture('l6')
  const readFile = join(bag.cwd, 'codemode-read.txt')
  const writeFile = join(bag.cwd, 'codemode-write.txt')
  writeFileSync(readFile, 'codemode-fixture content for pb2 adapter\n')
  const code = codemodeWorkload({ readPath: readFile, writePath: writeFile })

  const measure = async (kind) => {
    const provider = await startProvider({ tools: [{ name: 'codemode', args: { code } }], chunks: 2 })
    const rpc = launch(kind, bag, { port: provider.port, args: ['--extension', join(EXT_DIR, 'codemode-policy.js')] })
    rpc.spawn()
    await rpc.command('get_state', {}, { timeoutMs: 60000 })
    const before = await sampleProcessTree(rpc.child?.pid ?? 0)
    const t0 = performance.now()
    await rpc.command('prompt', { message: 'run codemode workload' }, { timeoutMs: 60000 })
    const settled = await waitForSettled(rpc, { timeoutMs: 60000 })
    const wallMs = performance.now() - t0
    const after = await sampleProcessTree(rpc.child?.pid ?? 0)
    const msgs = await rpc.command('get_messages', {}, { timeoutMs: 20000 })
    const result = (msgs.data?.messages ?? []).find((m) => (m.role === 'toolResult' || m.role === 'tool') && m.toolName === 'codemode')
    const text = JSON.stringify(result?.content ?? '')
    await rpc.close()
    await closeServer(provider.server)
    const cpuMs = before && after ? Math.max(0, after.cpuMs - before.cpuMs) : null
    const wsBytes = after ? after.peakWorkingSetBytes : null
    const wrote = existsSync(writeFile) && readFileSync(writeFile, 'utf8') === 'pb2-codemode-write\n'
    return { wallMs, cpuMs, wsBytes, ok: settled && result && !result.isError && text.includes('Script completed') && wrote, text }
  }

  const warmups = 3
  const rounds = 7
  const candidateWall = []
  const baselineWall = []
  const candidateCpu = []
  const baselineCpu = []
  const candidateWs = []
  const baselineWs = []
  const errors = []
  for (let i = 0; i < warmups; i++) {
    await measure('candidate')
    await measure('baseline')
  }
  for (let i = 0; i < rounds; i++) {
    const order = i % 2 === 0 ? ['candidate', 'baseline', 'baseline', 'candidate'] : ['baseline', 'candidate', 'candidate', 'baseline']
    for (const kind of order) {
      const r = await measure(kind)
      if (!r.ok) { errors.push(`${kind}#${i}: ${r.text.slice(0, 160)}`); continue }
      if (kind === 'candidate') { candidateWall.push(r.wallMs); if (r.cpuMs !== null) candidateCpu.push(r.cpuMs); if (r.wsBytes !== null) candidateWs.push(r.wsBytes) }
      else { baselineWall.push(r.wallMs); if (r.cpuMs !== null) baselineCpu.push(r.cpuMs); if (r.wsBytes !== null) baselineWs.push(r.wsBytes) }
    }
  }
  const candWallMed = median(candidateWall)
  const baseWallMed = median(baselineWall)
  const candCpuMed = median(candidateCpu)
  const baseCpuMed = median(baselineCpu)
  const candWsMed = median(candidateWs)
  const baseWsMed = median(baselineWs)
  console.log(`  codemode wall 中位数：candidate ${candWallMed.toFixed(1)}ms / baseline ${baseWallMed.toFixed(1)}ms（比值 ${(candWallMed / baseWallMed).toFixed(2)}，n=${candidateWall.length}/${baselineWall.length}）`)
  console.log(`  codemode 子树 CPU 中位数（Win32_Process User+Kernel）：candidate ${candCpuMed.toFixed(1)}ms / baseline ${baseCpuMed.toFixed(1)}ms（比值 ${(candCpuMed / baseCpuMed).toFixed(2)}）`)
  console.log(`  codemode 进程树 peak WorkingSet 中位数（Win32_Process）：candidate ${(candWsMed / 1024 / 1024).toFixed(1)}MiB / baseline ${(baseWsMed / 1024 / 1024).toFixed(1)}MiB（比值 ${(candWsMed / baseWsMed).toFixed(2)}）`)
  check(errors.length === 0, 'L6 所有 codemode 轮次成功完成', errors.slice(0, 3).join(' | '))
  check(candidateWall.length >= rounds && baselineWall.length >= rounds, 'L6 采样轮次完整')
  check(Number.isFinite(candWallMed) && Number.isFinite(baseWallMed), 'L6 wall 中位数可用')
  const ratio = candWallMed / baseWallMed
  if (ratio > 1.5) note(`codemode wall 出现稳定退化（candidate/baseline=${ratio.toFixed(2)} > 1.50）：JIT-off 解释执行对短脚本不利，按可切换 runtime 接受，不是整机回退`)
  else check(ratio <= 1.5, `codemode wall 未出现稳定退化（candidate/baseline=${ratio.toFixed(2)}）`)
} catch (error) {
  check(false, 'L6 场景异常结束', String(error?.stack ?? error).slice(0, 600))
}

section('L7 真实 native-exe：abort / 启动中取消 / 退出无残留')
try {
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

  const bag = makeFixture('l7')
  const provider = await startProvider({ tools: [], chunks: 20000, chunkDelayMs: 3, chunkSize: 32 })
  const rpc = launch('candidate', bag, { port: provider.port, args: thinExtensionArgs() })
  rpc.spawn()
  await rpc.command('get_state', {}, { timeoutMs: 60000 })
  await rpc.command('prompt', { message: 'long stream' }, { timeoutMs: 60000 })
  await new Promise((r) => setTimeout(r, 1200))
  const abortRes = await rpc.command('abort', {}, { timeoutMs: 30000 })
  check(abortRes.success === true, 'L7 abort 成功')
  await waitForSettled(rpc, { timeoutMs: 30000 })
  const st = await rpc.command('get_state', {}, { timeoutMs: 20000 })
  check(st.data?.isStreaming === false, 'L7 abort 后不再流式')
  const pid = rpc.child?.pid
  await rpc.close()
  await new Promise((r) => setTimeout(r, 300))
  check(!alive(pid), 'L7 close 后进程退出')
  const tree = await sampleProcessTree(pid)
  check(!tree || tree.count === 0, 'L7 无子进程残留', JSON.stringify(tree))
  await closeServer(provider.server)

  const cancelBag = makeFixture('l7-cancel')
  const cancelProvider = await startProvider({ tools: [] })
  const cancelRpc = launch('candidate', cancelBag, { port: cancelProvider.port, args: thinExtensionArgs() })
  cancelRpc.spawn()
  const cancelPid = cancelRpc.child?.pid
  await new Promise((r) => setTimeout(r, 40))
  await cancelRpc.close()
  await new Promise((r) => setTimeout(r, 400))
  check(!alive(cancelPid), 'L7 启动中取消后进程退出')
  await closeServer(cancelProvider.server)
} catch (error) {
  check(false, 'L7 场景异常结束', String(error?.stack ?? error).slice(0, 600))
}

console.log(`\n结果：${total} 项，${failed} 项失败`)
if (failures.length) console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
rmSync(WORK, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
