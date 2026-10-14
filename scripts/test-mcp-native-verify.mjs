/**
 * 旧宿主 MCP 导入 pi 原生：校验器 + 能力页 IPC。
 *
 * 覆盖：
 *   · `parseNativeMcpListOutput` 对假 CLI 输出/超时的严格解析（非空 errors、额外服务、
 *     重复名字、坏 tools 形状都判未通过）；
 *   · `createNativeMcpVerifier` 的隔离运行：指纹核对（校验前被外部改成新 command 时
 *     拒绝且不 spawn）、假 CLI 的 connected / needs-auth / 名字不符 / 非法 JSON /
 *     退出码非零 / 超时；
 *   · 真实随包 pi + `scripts/lib/mcp-stdio-fixture.mjs` 的单条 stdio 校验；真 `PI_CODING_AGENT_DIR`
 *     （诱饵配置）与目标文件里的第二条服务都不会被连接；
 *   · commit → verifier 端到端：写入后目标被外部改动时旧条目不停用、未确认命令不执行；
 *   · IPC：prepare/commit 的 runner 切换、控制器对象变化、项目身份变化、settings await
 *     后实例变化、不可见服务、windows-mcp、令牌边界、重载失败仍回分步结果；
 *   · `runPiList`（AST 提取真实函数）在假 child 永不 close / kill 失败时仍有限返回。
 *
 * 不调用真实模型、不碰用户数据；真实 pi 只连仓库里的 `scripts/lib/mcp-stdio-fixture.mjs`。
 * 用法：node scripts/test-mcp-native-verify.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-native-verify-'))
process.env.YAN_PI_DIR = join(root, 'pi-agent')
process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_MCP_SERVERS_FILE = join(root, 'yan', 'mcp-servers.json')

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail !== undefined ? `（${detail}）` : ''}`)
  checks++
  console.log(`✓ ${message}`)
}

const outfile = join(root, 'native-verify.mjs')
await build({
  stdin: {
    contents:
      "export * from './src/main/mcp/native-import';" +
      "export * from './src/main/mcp/native-verify';" +
      "export * from './src/main/ipc/capabilities-ipc';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const m = await import(pathToFileURL(outfile).href)

const hostConfigFile = process.env.YAN_MCP_SERVERS_FILE
const projectCwd = join(root, 'project')
const fixturePath = join(process.cwd(), 'scripts', 'lib', 'mcp-stdio-fixture.mjs')
await Promise.all([
  mkdir(projectCwd, { recursive: true }),
  mkdir(join(root, 'yan'), { recursive: true }),
  mkdir(join(root, 'pi-agent'), { recursive: true })
])

const writeJson = async (path, value) => {
  await mkdir(path.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const fingerprintText = (text) => createHash('sha256').update(text).digest('hex')
const fingerprintFile = async (path) => fingerprintText(await readFile(path, 'utf8'))

try {
  /* ------------------------------------------------- 输出解析（纯函数，不起进程） */

  const connectedOut = JSON.stringify({ servers: [{ name: 's1', state: 'connected', tools: ['a', 'b'] }] })
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: connectedOut, stderr: '', timedOut: false }, 's1').ok === true,
    '解析：connected 且名字正确时通过'
  )
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: connectedOut, stderr: '', timedOut: false }, 'other').ok === false,
    '解析：名字不符时不通过'
  )
  ok(
    m.parseNativeMcpListOutput(
      { code: 0, stdout: JSON.stringify({ servers: [{ name: 's1', state: 'needs-auth', tools: [] }] }), stderr: '', timedOut: false },
      's1'
    ).detail.includes('重新登录'),
    '解析：needs-auth 报告需要重新登录'
  )
  ok(
    m.parseNativeMcpListOutput({ code: 1, stdout: connectedOut, stderr: '', timedOut: false }, 's1').ok === false,
    '解析：退出码非零时即使 connected 也不通过'
  )
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: 'not json', stderr: 'boom', timedOut: false }, 's1').ok === false,
    '解析：非法 JSON 不通过'
  )
  ok(
    m.parseNativeMcpListOutput({ code: null, stdout: '', stderr: '', timedOut: true }, 's1').detail.includes('超时'),
    '解析：超时明确报未完成'
  )

  /* 严格解析：非空 errors、额外服务、重复名字、坏 tools 形状都必须拒绝。 */
  const withErrors = JSON.stringify({ servers: [{ name: 's1', state: 'connected', tools: [] }], errors: ['bad config'] })
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: withErrors, stderr: '', timedOut: false }, 's1').ok === false,
    '解析：非空 errors 判未通过'
  )
  const extraServer = JSON.stringify({
    servers: [{ name: 's1', state: 'connected', tools: [] }, { name: 'decoy', state: 'connected', tools: [] }]
  })
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: extraServer, stderr: '', timedOut: false }, 's1').ok === false,
    '解析：出现本次导入之外的服务判未通过（隔离不成立）'
  )
  const dupServer = JSON.stringify({
    servers: [{ name: 's1', state: 'connected', tools: [] }, { name: 's1', state: 'connected', tools: [] }]
  })
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: dupServer, stderr: '', timedOut: false }, 's1').ok === false,
    '解析：重复同名服务判未通过'
  )
  const badTools = JSON.stringify({ servers: [{ name: 's1', state: 'connected', tools: [{ name: 'x' }] }] })
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: badTools, stderr: '', timedOut: false }, 's1').ok === false,
    '解析：tools 非字符串数组判未通过（不默认 0 工具）'
  )
  const missingTools = JSON.stringify({ servers: [{ name: 's1', state: 'connected' }] })
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: missingTools, stderr: '', timedOut: false }, 's1').ok === false,
    '解析：缺少 tools 字段判未通过'
  )
  const nonObjectServer = JSON.stringify({ servers: ['s1'] })
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: nonObjectServer, stderr: '', timedOut: false }, 's1').ok === false,
    '解析：servers 含非对象条目判未通过'
  )
  const errorsNotArray = JSON.stringify({ servers: [{ name: 's1', state: 'connected', tools: [] }], errors: 'oops' })
  ok(
    m.parseNativeMcpListOutput({ code: 0, stdout: errorsNotArray, stderr: '', timedOut: false }, 's1').ok === false,
    '解析：errors 不是数组判未通过'
  )

  /* ----------------------------------------------------- 假 CLI：隔离运行与超时 */

  const fakePi = join(root, 'fake-pi.mjs')
  await writeFile(
    fakePi,
    [
      "const mode = process.env.YAN_FAKE_MCP_MODE",
      "const name = process.env.YAN_FAKE_MCP_NAME ?? 'fixture-svc'",
      "if (mode === 'hang') { setTimeout(() => {}, 60000); process.stdin.resume() }",
      "else if (mode === 'invalid') process.stdout.write('not json')",
      "else if (mode === 'connected') process.stdout.write(JSON.stringify({ servers: [{ name, state: 'connected', tools: ['a','b','c'] }] }))",
      "else if (mode === 'needs-auth') process.stdout.write(JSON.stringify({ servers: [{ name, state: 'needs-auth', tools: [] }] }))",
      "else if (mode === 'connected-exit1') { process.stdout.write(JSON.stringify({ servers: [{ name, state: 'connected', tools: [] }] })); process.exitCode = 1 }",
      ''
    ].join('\n')
  )

  const targetPath = join(root, 'pi-agent', 'mcp.json')
  const writeTarget = (name) =>
    writeJson(targetPath, { mcpServers: { [name]: { command: process.execPath, args: ['fixture.js'] } } })
  const verifier = (extra = {}) =>
    m.createNativeMcpVerifier({ piBin: fakePi, runnerCwd: projectCwd, timeoutMs: 10_000, ...extra })
  /* 校验输入必须带真实算出的指纹（commit 会带；直接调 verifier 的测试也要自己算）。 */
  const verifyTarget = async (v, extraInput = {}) =>
    v({
      serverId: 'fixture-svc',
      nativeName: 'fixture-svc',
      scope: 'global',
      targetPath,
      expectedFingerprint: await fingerprintFile(targetPath),
      ...extraInput
    })

  await writeTarget('fixture-svc')
  process.env.YAN_FAKE_MCP_MODE = 'connected'
  const fakeConnected = await verifyTarget(verifier())
  ok(fakeConnected.ok && fakeConnected.toolCount === 3, '假 CLI：connected 时通过并给出工具数', String(fakeConnected.toolCount))

  process.env.YAN_FAKE_MCP_MODE = 'needs-auth'
  const fakeAuth = await verifyTarget(verifier())
  ok(!fakeAuth.ok && fakeAuth.detail.includes('重新登录'), '假 CLI：needs-auth 判未通过并提示重新登录')

  process.env.YAN_FAKE_MCP_MODE = 'connected'
  process.env.YAN_FAKE_MCP_NAME = 'other'
  const fakeWrongName = await verifyTarget(verifier())
  ok(!fakeWrongName.ok, '假 CLI：返回的服务名不符时不通过')
  delete process.env.YAN_FAKE_MCP_NAME

  process.env.YAN_FAKE_MCP_MODE = 'invalid'
  const fakeInvalid = await verifyTarget(verifier())
  ok(!fakeInvalid.ok, '假 CLI：非法 JSON 不通过')

  process.env.YAN_FAKE_MCP_MODE = 'connected-exit1'
  const fakeExit = await verifyTarget(verifier())
  ok(!fakeExit.ok, '假 CLI：connected 但退出码非零不通过')

  process.env.YAN_FAKE_MCP_MODE = 'hang'
  const started = Date.now()
  const fakeTimeout = await verifyTarget(verifier({ timeoutMs: 1200 }))
  ok(!fakeTimeout.ok && fakeTimeout.detail.includes('超时'), '假 CLI：超时判未通过')
  ok(Date.now() - started < 9000, '假 CLI：超时后杀掉本次子进程而非一直等', `${Date.now() - started}ms`)
  delete process.env.YAN_FAKE_MCP_MODE

  /* --------- A：校验开始前目标被外部改成未确认 command —— 不 spawn、旧条目不停用 --------- */

  const spyPi = join(root, 'spy-pi.mjs')
  const spyMarker = join(root, 'spy-marker.txt')
  await rm(spyMarker, { force: true })
  await writeFile(
    spyPi,
    [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.env.YAN_SPY_MARKER, 'spawned')",
      "process.stdout.write(JSON.stringify({ servers: [{ name: 'fixture-svc', state: 'connected', tools: [] }] }))",
      ''
    ].join('\n')
  )
  process.env.YAN_SPY_MARKER = spyMarker
  /* 先写「已确认」的内容并记指纹，再把文件改成未确认的新 command。 */
  await writeJson(targetPath, { mcpServers: { 'fixture-svc': { command: process.execPath, args: [fakePi] } } })
  const approvedFp = await fingerprintFile(targetPath)
  await writeJson(targetPath, { mcpServers: { 'fixture-svc': { command: process.execPath, args: [spyPi] } } })
  const tampered = await m.createNativeMcpVerifier({ runnerCwd: process.cwd(), timeoutMs: 60_000 })({
    serverId: 'fixture-svc',
    nativeName: 'fixture-svc',
    scope: 'global',
    targetPath,
    expectedFingerprint: approvedFp
  })
  ok(!tampered.ok && tampered.detail.includes('已确认'), 'A：目标在校验前被改成未确认 command 时判未通过', tampered.detail)
  let spyRan = false
  try {
    await readFile(spyMarker, 'utf8')
    spyRan = true
  } catch {
    spyRan = false
  }
  ok(!spyRan, 'A：未确认的新 command 没有被 spawn')

  const noFp = await m.createNativeMcpVerifier({ runnerCwd: process.cwd() })({
    serverId: 'fixture-svc',
    nativeName: 'fixture-svc',
    scope: 'global',
    targetPath,
    expectedFingerprint: ''
  })
  ok(!noFp.ok, 'A：缺少已确认指纹时判未通过')

  /* ------------------------------- 真实 pi + 本机 stdio 夹具，且不读其它 MCP 配置 */

  const decoyDir = join(root, 'decoy-agent')
  const decoyMarker = join(root, 'decoy-started.marker')
  const decoyServer = join(root, 'decoy-server.mjs')
  await writeFile(
    decoyServer,
    ["import { writeFileSync } from 'node:fs'", "writeFileSync(process.env.YAN_DECOY_MARKER, 'started')", ''].join('\n')
  )
  await writeJson(join(decoyDir, 'mcp.json'), {
    mcpServers: { decoy: { command: process.execPath, args: [decoyServer] } }
  })
  process.env.PI_CODING_AGENT_DIR = decoyDir
  process.env.YAN_DECOY_MARKER = decoyMarker

  await writeJson(targetPath, {
    mcpServers: {
      'fixture-echo': { command: process.execPath, args: [fixturePath] },
      /* 目标文件里的第二条服务绝不能因为校验一条而被启动。 */
      'target-decoy': { command: process.execPath, args: [decoyServer] }
    }
  })
  const realVerifier = m.createNativeMcpVerifier({ runnerCwd: process.cwd(), timeoutMs: 60_000 })
  const realResult = await realVerifier({
    serverId: 'fixture-echo',
    nativeName: 'fixture-echo',
    scope: 'global',
    targetPath,
    expectedFingerprint: await fingerprintFile(targetPath)
  })
  ok(realResult.ok && (realResult.toolCount ?? 0) >= 6, '真实 pi + 夹具：单条 stdio 服务校验通过并列出工具', realResult.detail ?? String(realResult.toolCount))
  let decoyRead = true
  try {
    await readFile(decoyMarker, 'utf8')
  } catch {
    decoyRead = false
  }
  ok(!decoyRead, '隔离：诱饵 PI_CODING_AGENT_DIR 里的其它 MCP 服务没有被启动')

  /* 目标文件里的第二条服务同样不能被启动：只校验本次确认的这一条。 */
  let targetDecoyRead = true
  try {
    await readFile(decoyMarker, 'utf8')
  } catch {
    targetDecoyRead = false
  }
  ok(!targetDecoyRead, '隔离：目标 mcp.json 里的其它服务没有被本次校验连接')

  /* 项目范围：连通但真实项目未被信任时不停用。 */
  const projectVerifier = m.createNativeMcpVerifier({
    runnerCwd: process.cwd(),
    timeoutMs: 60_000,
    isProjectTrusted: async () => false
  })
  const projectResult = await projectVerifier({
    serverId: 'fixture-echo',
    nativeName: 'fixture-echo',
    scope: 'project',
    targetPath,
    expectedFingerprint: await fingerprintFile(targetPath),
    projectId: 'p-main',
    projectCwd
  })
  ok(!projectResult.ok && projectResult.detail.includes('信任'), '项目范围：真实项目未受信时判未通过，不假称已加载生效')

  /* --------- A（端到端）：commit 写入后目标被外部改，verifier 判未通过 → 旧条目仍启用 --------- */

  await rm(spyMarker, { force: true })
  await writeJson(hostConfigFile, { servers: [{ id: 'svc-a', transport: 'stdio', command: 'node' }] })
  await writeJson(targetPath, { mcpServers: {} })
  const hostA = { agentDir: process.env.YAN_PI_DIR, hostConfigFile, projects: [] }
  const prepA = await m.prepareNativeMcpImport({ host: hostA, serverId: 'svc-a', owner: { id: 'r' } })
  const commitA = await m.commitNativeMcpImport({
    host: {
      ...hostA,
      verify: m.createNativeMcpVerifier({ runnerCwd: projectCwd, timeoutMs: 60_000 }),
      writeText: async (path, text, expected) => {
        await m.atomicWrite(path, text, expected)
        /* 写入后、校验前被外部改成未确认的 command。 */
        if (path === targetPath) {
          await writeJson(targetPath, { mcpServers: { 'svc-a': { command: process.execPath, args: [spyPi] } } })
        }
      }
    },
    token: prepA.token,
    owner: { id: 'r' }
  })
  ok(
    !commitA.ok && commitA.nativeWritten && commitA.steps.verify === 'failed' && commitA.steps.hostDisable === 'skipped',
    'A：写入后校验前被改，判未通过且不停用旧条目',
    commitA.notice
  )
  const hostAfterA = await readJson(hostConfigFile)
  ok(hostAfterA.servers[0].enabled === undefined, 'A：旧条目仍启用')
  let spyRan2 = false
  try {
    await readFile(spyMarker, 'utf8')
    spyRan2 = true
  } catch {
    spyRan2 = false
  }
  ok(!spyRan2, 'A：端到端下未确认的新命令没有被执行')

  /* ---------------------------------------------------------- IPC：身份与边界 */

  await writeJson(hostConfigFile, {
    servers: [
      { id: 'svc-global', transport: 'stdio', command: 'node', args: ['x'] },
      { id: 'svc-proj', transport: 'stdio', command: 'node', projectScope: 'p-other' }
    ]
  })
  await writeJson(targetPath, { mcpServers: {} })

  const makeAgent = (projectId) => ({
    capabilityProjectId: projectId,
    verifyCapabilityMcp: async () => ({ status: 'ready', toolCount: 0 }),
    disconnectCapabilityMcp: async () => true
  })
  let activeRunner = { id: 'runner-1', cwd: projectCwd }
  let runtimeGeneration = 1
  let currentAgentObj = makeAgent(null)
  let reloads = 0
  const registry = {
    activeRunner: () => activeRunner,
    runtimeOf: (id) => (id === activeRunner.id ? { sessionId: 's1', runId: id, generation: runtimeGeneration } : null),
    agentOf: (id) => (id === activeRunner.id ? currentAgentObj : null),
    reloadMcpServers: async () => {
      reloads++
    }
  }
  /* settings 可被测试替换：用来模拟 await 期间运行实例切换。 */
  let settingsImpl = async () => ({ projects: [{ id: 'p-main', cwd: projectCwd }], piBin: fakePi })
  const handlers = new Map()
  m.registerCapabilitiesIpc(
    { handle: (channel, fn) => handlers.set(channel, fn) },
    {
      currentAgent: () => currentAgentObj,
      registry: () => registry,
      thinExtensionPaths: () => [],
      settings: () => settingsImpl(),
      isProjectTrusted: async () => true
    }
  )
  const call = (channel, value) => handlers.get(channel)(value)

  const prepared = await call('yan:capabilities:prepareNativeImport', 'svc-global')
  ok(prepared.ok === true && prepared.preview?.serverId === 'svc-global', 'IPC prepare：返回预览与令牌', prepared.code ?? prepared.error)

  activeRunner = { id: 'runner-2', cwd: projectCwd }
  currentAgentObj = makeAgent(null)
  const switched = await call('yan:capabilities:commitNativeImport', prepared.preview.token)
  ok(switched.ok === false && switched.code === 'runner_changed', 'IPC commit：切 runner 后拒绝提交', switched.code)

  activeRunner = { id: 'runner-1', cwd: projectCwd }
  runtimeGeneration = 1
  currentAgentObj = makeAgent(null)
  const preparedOwner = await call('yan:capabilities:prepareNativeImport', 'svc-global')
  currentAgentObj = makeAgent(null)
  const crossOwner = await call('yan:capabilities:commitNativeImport', preparedOwner.preview.token)
  ok(crossOwner.ok === false && crossOwner.code === 'runner_changed', 'IPC commit：控制器对象被替换后拒绝提交', crossOwner.code)

  currentAgentObj = makeAgent('p-main')
  const preparedProject = await call('yan:capabilities:prepareNativeImport', 'svc-global')
  currentAgentObj.capabilityProjectId = 'p-other'
  const projectSwitched = await call('yan:capabilities:commitNativeImport', preparedProject.preview.token)
  ok(projectSwitched.ok === false && projectSwitched.code === 'runner_changed', 'IPC commit：项目身份变化后拒绝提交', projectSwitched.code)

  currentAgentObj = makeAgent('p-main')
  const hidden = await call('yan:capabilities:prepareNativeImport', 'svc-proj')
  ok(hidden.ok === false && hidden.code === 'server_not_visible', 'IPC prepare：非本 runner 可见的项目服务被拒', hidden.code)

  const windows = await call('yan:capabilities:prepareNativeImport', 'windows-mcp')
  ok(windows.ok === false && windows.code === 'windows_mcp_preserved', 'IPC prepare：windows-mcp 保留在砚，不导入', windows.code)

  ok((await call('yan:capabilities:commitNativeImport', '')).code === 'token_required', 'IPC commit：缺少令牌被拒')
  ok((await call('yan:capabilities:commitNativeImport', 'nope')).code === 'token_invalid', 'IPC commit：未知令牌被拒')
  ok(reloads === 0, 'IPC：未发生成功提交时不触发 reloadMcpServers')

  /* settings await 期间运行实例被切换：commit 前重核，拒绝提交。 */
  currentAgentObj = makeAgent(null)
  activeRunner = { id: 'runner-1', cwd: projectCwd }
  runtimeGeneration = 1
  const preparedRace = await call('yan:capabilities:prepareNativeImport', 'svc-global')
  ok(preparedRace.ok === true, 'IPC race：准备成功', preparedRace.code ?? preparedRace.error)
  settingsImpl = async () => {
    currentAgentObj = makeAgent(null)
    return { projects: [{ id: 'p-main', cwd: projectCwd }], piBin: fakePi }
  }
  const raced = await call('yan:capabilities:commitNativeImport', preparedRace.preview.token)
  ok(raced.ok === false && raced.code === 'runner_changed', 'IPC race：settings await 后实例变化，提交前重核并拒绝', raced.code)
  settingsImpl = async () => ({ projects: [{ id: 'p-main', cwd: projectCwd }], piBin: fakePi })

  /* 提交成功但重载旧连接抛错：仍回 ok:true + 已写入/已停用的分步结果 + 警告。 */
  process.env.YAN_FAKE_MCP_MODE = 'connected'
  process.env.YAN_FAKE_MCP_NAME = 'svc-global'
  currentAgentObj = makeAgent(null)
  activeRunner = { id: 'runner-1', cwd: projectCwd }
  runtimeGeneration = 1
  const preparedReload = await call('yan:capabilities:prepareNativeImport', 'svc-global')
  ok(preparedReload.ok === true, 'IPC reload：准备成功', preparedReload.code ?? preparedReload.error)
  let reloadThrew = false
  registry.reloadMcpServers = async () => {
    reloadThrew = true
    throw new Error('fixture reload failure')
  }
  const committedReload = await call('yan:capabilities:commitNativeImport', preparedReload.preview.token)
  ok(
    committedReload.ok === true && committedReload.result?.ok === true,
    'IPC reload：重载抛错仍回 ok:true（不误导为导入失败）',
    JSON.stringify(committedReload.result?.steps)
  )
  ok(
    committedReload.result?.nativeWritten === true && committedReload.result?.deactivated === true,
    'IPC reload：原生已写入且旧条目已停用'
  )
  ok(
    (committedReload.result?.warnings ?? []).some((warning) => warning.includes('刷新失败')),
    'IPC reload：警告说明旧连接刷新失败且不自动重启'
  )
  ok(reloadThrew === true, 'IPC reload：确实调用了 reloadMcpServers 并捕获其异常')
  delete process.env.YAN_FAKE_MCP_MODE
  delete process.env.YAN_FAKE_MCP_NAME

  /* --------- B：真实 runPiList（AST 提取）在假 child 永不 close / kill 失败时有限返回 --------- */

  const verifySource = await readFile(join(process.cwd(), 'src/main/mcp/native-verify.ts'), 'utf8')
  const sourceFile = ts.createSourceFile('native-verify.ts', verifySource, ts.ScriptTarget.Latest, true)
  const extractFunction = (name) => {
    let text
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(sourceFile)
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return text
  }
  const runPiListText = extractFunction('runPiList')
  ok(typeof runPiListText === 'string' && runPiListText.startsWith('function runPiList'), 'B：从生产源码提取到 runPiList')
  const extractVariable = (name) => {
    let text
    const visit = (node) => {
      if (
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)
      ) {
        text = node.getText(sourceFile)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return text
  }
  const graceText = extractVariable('RUN_PI_LIST_TIMEOUT_GRACE_MS')
  ok(typeof graceText === 'string' && graceText.includes('RUN_PI_LIST_TIMEOUT_GRACE_MS'), 'B：提取到生产超时宽限常量')

  const deps = {
    spawnImpl: () => {
      throw new Error('spawnImpl not configured')
    },
    killTree: () => {}
  }
  globalThis.__RUNPI_DEPS__ = deps
  const harnessSource = [
    "import { StringDecoder } from 'node:string_decoder'",
    'const __deps = globalThis.__RUNPI_DEPS__',
    'const spawn = (...args) => __deps.spawnImpl(...args)',
    'const killProcessTree = (child) => __deps.killTree(child)',
    'function messageOf(error) { return error instanceof Error ? error.message : String(error) }',
    graceText,
    runPiListText,
    'export { runPiList }'
  ].join('\n')
  const harnessFile = join(root, 'runpi-harness.mjs')
  await build({
    stdin: { contents: harnessSource, resolveDir: process.cwd(), loader: 'ts' },
    outfile: harnessFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const harness = await import(pathToFileURL(harnessFile).href)

  const makeFakeChild = () => {
    const child = new EventEmitter()
    child.pid = 4242
    child.kill = () => true
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdout.destroy = () => {}
    child.stderr.destroy = () => {}
    return child
  }

  /* 1) kill 什么都不做、child 永不 close：仍须有限返回超时。 */
  deps.spawnImpl = () => makeFakeChild()
  deps.killTree = () => {}
  const hangStart = Date.now()
  const hangOutcome = await harness.runPiList({ cmd: 'x', args: [], cwd: root, agentDir: root, timeoutMs: 120 })
  const hangElapsed = Date.now() - hangStart
  ok(hangOutcome.timedOut === true, 'B：kill 失败且 child 永不 close 时仍按超时结算')
  ok(hangElapsed < 3000, 'B：超时后有界返回而非永久等待', `${hangElapsed}ms`)

  /* 2) kill 直接抛错：错误不能吞掉超时结果。 */
  deps.killTree = () => {
    throw new Error('taskkill failed')
  }
  const throwOutcome = await harness.runPiList({ cmd: 'x', args: [], cwd: root, agentDir: root, timeoutMs: 120 })
  ok(throwOutcome.timedOut === true, 'B：kill 抛错时仍返回超时结果')

  /* 3) 正常 close：不该被超时机制误伤。 */
  deps.spawnImpl = () => {
    const child = makeFakeChild()
    setTimeout(() => child.emit('close', 0), 10)
    return child
  }
  deps.killTree = () => {}
  const normalOutcome = await harness.runPiList({ cmd: 'x', args: [], cwd: root, agentDir: root, timeoutMs: 2000 })
  ok(normalOutcome.code === 0 && normalOutcome.timedOut === false, 'B：正常 close 时按退出码返回', String(normalOutcome.code))

  /* 4) 生产 killProcessTree：taskkill 退出码非零时回退 child.kill；POSIX 直接 child.kill。 */
  const killProcessTreeText = extractFunction('killProcessTree')
  ok(typeof killProcessTreeText === 'string', 'B：从生产源码提取到 killProcessTree')
  const killDeps = { closeCode: 1 }
  globalThis.__KILL_DEPS__ = {
    spawnImpl: () => {
      const killer = new EventEmitter()
      setTimeout(() => killer.emit('close', killDeps.closeCode), 5)
      return killer
    }
  }
  const killHarnessSource = [
    'const __deps = globalThis.__KILL_DEPS__',
    'const spawn = (...args) => __deps.spawnImpl(...args)',
    killProcessTreeText,
    'export { killProcessTree }'
  ].join('\n')
  const killHarnessFile = join(root, 'kill-harness.mjs')
  await build({
    stdin: { contents: killHarnessSource, resolveDir: process.cwd(), loader: 'ts' },
    outfile: killHarnessFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  const killHarness = await import(pathToFileURL(killHarnessFile).href)
  const killChild = {
    pid: 7,
    killed: [],
    kill(signal) {
      this.killed.push(signal)
      return true
    }
  }
  killHarness.killProcessTree(killChild)
  await new Promise((resolve) => setTimeout(resolve, 40))
  if (process.platform === 'win32') {
    ok(killChild.killed.includes('SIGKILL'), 'B：Windows taskkill 退出码非零时回退直接 child.kill')
  } else {
    ok(killChild.killed.includes('SIGKILL'), 'B：POSIX 直接 child.kill（未声称已跨平台杀树）')
  }
  const killThrowChild = {
    pid: 8,
    killed: [],
    kill(signal) {
      this.killed.push(signal)
      throw new Error('kill failed')
    }
  }
  globalThis.__KILL_DEPS__.spawnImpl = () => {
    throw new Error('taskkill spawn failed')
  }
  let killThrew = false
  try {
    killHarness.killProcessTree(killThrowChild)
  } catch {
    killThrew = true
  }
  ok(!killThrew && killThrowChild.killed.includes('SIGKILL'), 'B：taskkill 启动失败时回退 child.kill 且不向上抛错')

  console.log(`\n${checks} 项检查通过`)
} finally {
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.YAN_DECOY_MARKER
  delete process.env.YAN_SPY_MARKER
  delete globalThis.__RUNPI_DEPS__
  delete globalThis.__KILL_DEPS__
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
