/**
 * 托管 MCP 工具的**模型代理通道**（设计 A2）合成验收。
 *
 * 覆盖：
 *   1. `McpAppProxyService.refresh()`：只连托管服务、只收 `modelVisible`、
 *      快照只放 name/描述/schema/注解（无 token / 命令 / URL / 凭证）；
 *   2. `call()`：参数转发、`structuredContent` / 原始 `_meta` 只留宿主、
 *      回给模型的只有 content 文本、32KB 超限受控落盘且不泄露原始 Meta；
 *   3. app-only / 未托管 / 未知道具 / 非法 owner / 非法 callId 明确失败；
 *   4. 每调用取消把 `AbortSignal` 透传到后端；
 *   5. 名字规范化碰撞整体拒绝（不静默覆盖）；旧入口 `yan mcp call` 同口径拦截；
 *   6. 快照过期 / 缺失 → 待用户刷新，不默认连接服务器；
 *   7. 薄扩展 `mcp-app-proxy.js`：注册名、注解保留、schema 刷新需 reload、
 *      schema/描述解析、`mcp.app.call` 转发；
 *   8. 真实随包 pi 1.2.0：`registerTool()` 的 annotations 能被 `getAllTools()` 看见
 *      （这是「审批同口径成立」的硬前提，验不过就如实失败）。
 *
 * 全程隔离：临时 `YAN_DATA_DIR` / `YAN_MCP_SERVERS_FILE` / `PI_*`，本机 stdio 夹具
 * 与回环假端点；不联网、不碰用户配置 / 凭证、不启动砚窗口。
 *
 * 运行：node scripts/test-mcp-app-proxy.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const root = await mkdtemp(join(tmpdir(), 'yan-mcp-app-proxy-'))
const yanDir = join(root, 'yan')
process.env.YAN_DATA_DIR = yanDir
process.env.YAN_MCP_SERVERS_FILE = join(yanDir, 'mcp-servers.json')

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail !== undefined ? `（${detail}）` : ''}`)
  checks += 1
  console.log(`✓ ${message}`)
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

const fixture = resolve('scripts/fixtures/mcp-app-server.mjs')
const proxyExtension = resolve('resources/pi-extensions/mcp-app-proxy.js')

/* 合成夹具与代理服务各自打一份；SDK 保持 external。 */
const specOutfile = join(root, 'app-spec.mjs')
await build({
  entryPoints: [resolve('src/main/mcp/app-spec.ts')],
  outfile: specOutfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent'
})
/* 现场编译到任务临时目录（仓库内、被忽略），不写共享 out/。 */
const bundleDir = join(process.cwd(), '.tmp', 'MA2-proxy')
await mkdir(bundleDir, { recursive: true })
const proxyOutfile = join(bundleDir, 'mcp-app-proxy-bundle.mjs')
await build({
  stdin: {
    contents:
      "export * from './src/main/mcp/app-spec';" +
      "export * from './src/main/mcp/app-host';" +
      "export * from './src/main/mcp/app-proxy-service';" +
      "export * from './src/main/mcp/config';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile: proxyOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  logLevel: 'silent'
})
const proxy = await import(pathToFileURL(proxyOutfile).href)
const extension = await import(pathToFileURL(proxyExtension).href)

/* 归属守卫缺省 fail-closed；测试显式注入 stub 事实（pi 侧无条目、无旧 runner）。 */
const ownershipDir = join(root, 'pi-agent')
await mkdir(ownershipDir, { recursive: true })
proxy.configureMcpAppHostOwnership({
  agentDir: ownershipDir,
  projects: [],
  holdersFor: async () => [],
  readNativeConfig: async () => null
})

/* 隔离 stdio 夹具：直接用仓库里的合成服务器，SDK 从仓库 node_modules 解析。 */

const configFile = join(yanDir, 'mcp-servers.json')
await mkdir(yanDir, { recursive: true })
const appHostMark = (name) => ({ at: '2026-10-16T00:00:00.000Z', natives: [{ path: join(root, 'pi', 'mcp.json'), name, entry: {}, fingerprint: 'fp' }] })
await writeFile(
  configFile,
  JSON.stringify({
    servers: [
      {
        id: 'app-stdio',
        title: '合成 App（stdio）',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: { YAN_MCP_APP_SPEC_MODULE: specOutfile, SECRET_FIXTURE_TOKEN: 'do-not-persist' },
        ownedBy: 'inkstone',
        appHost: appHostMark('app-stdio')
      },
      { id: 'native-stdio', transport: 'stdio', command: process.execPath, args: [fixture], ownedBy: 'pi' }
    ]
  }),
  'utf8'
)
const env = { ...process.env, YAN_MCP_SERVERS_FILE: configFile, YAN_DATA_DIR: yanDir }
const serviceDir = join(yanDir, 'mcp-app')
const owner = { sessionId: 's-runner-1', projectId: 'p-project-1' }
const service = new proxy.McpAppProxyService({ env, dir: serviceDir, timeoutMs: 20_000 })

try {
  /* ============================ 1. 快照只来自显式刷新 ============================ */

  {
    ok(service.snapshotStatus().needsRefresh === true, '刷新前：没有快照 → 待用户刷新')
    ok(service.registrableTools().length === 0, '刷新前：没有可注册工具，不默认连接任何服务器')

    const refreshed = await service.refresh()
    ok(refreshed.written && refreshed.ok, 'refresh：写出快照且无服务器错误', refreshed.errors.map((e) => e.error).join('；'))
    const names = refreshed.servers.map((server) => server.id).sort().join(',')
    ok(names === 'app-stdio', 'refresh：只连托管服务（native-stdio 不在内）', names)
    ok(refreshed.toolCount === 4, 'refresh：4 个模型可见工具（app-only 被排除）', String(refreshed.toolCount))
    ok(
      refreshed.excluded.some((entry) => entry.toolName === 'app_only_refresh' && entry.reason === 'not-model-visible'),
      'refresh：app-only 工具被明确排除并记原因'
    )

    const toolNames = refreshed.tools.map((tool) => tool.name).sort()
    ok(toolNames.includes('mcp__app_stdio__read_only_note'), '注册名：mcp__<server>__<tool>（- 归一成 _）', toolNames.join(','))
    ok(toolNames.includes('mcp__app_stdio__no_visibility_note'), '注册名：缺 visibility 的工具默认只给模型')
    ok(!toolNames.some((name) => name.includes('app_only_refresh')), '注册名：app-only 工具不注册')

    const readOnly = refreshed.tools.find((tool) => tool.toolName === 'read_only_note')
    ok(
      JSON.stringify(readOnly?.annotations) === '{"readOnlyHint":true,"destructiveHint":false}',
      '快照：annotations 逐字保留'
    )
    ok(readOnly?.inputSchema?.type === 'object' && readOnly?.inputSchema?.properties?.text?.type === 'string', '快照：schema 保留')

    const snapshotText = await readFile(service.snapshotPath(), 'utf8')
    ok(!snapshotText.includes('do-not-persist') && !snapshotText.includes('SECRET_FIXTURE_TOKEN'), '快照：不含服务配置里的密钥')
    ok(!snapshotText.includes('YAN_MCP_APP_SPEC_MODULE') && !snapshotText.includes('mcp-app-proxy-fixture-stdio'), '快照：不含 command / args / env')
    ok(!snapshotText.includes('"url"') && !snapshotText.includes('authRef'), '快照：不含 URL / 认证引用')
    ok(!snapshotText.includes('"_meta"') && !snapshotText.includes('structuredContent'), '快照：不含原始 _meta / structuredContent')

    const status = service.snapshotStatus()
    ok(status.present && !status.stale && status.needsRefresh === false, '刷新后：快照新鲜，可用')
    ok(proxy.mcpAppProxyToolsEnv(env).YAN_MCP_APP_TOOLS === service.snapshotPath(), 'env：新鲜快照注入 YAN_MCP_APP_TOOLS')
  }

  /* ============================ 2. 调用 / 转发 / Meta 留宿主 ============================ */

  {
    const record = await service.call({ owner, callId: 'call-1', serverId: 'app-stdio', toolName: 'read_only_note', args: { text: 'hi' } })
    ok(record.ok && record.text === 'note:hi', '调用：参数转发到后端并返回模型可见文本')
    ok(record.structuredContent?.note === 'hi' && record.structuredContent?.app === true, '调用：structuredContent 保留在宿主记录')
    ok(record.resourceUri === 'ui://mcp-app/dashboard.html', '调用：_meta.ui.resourceUri 保留在宿主记录')
    ok(record.uiCsp?.connectDomains?.[0] === 'https://api.example.invalid', '调用：_meta.ui.csp 保留在宿主记录')

    const fetched = service.getCallResult('call-1', owner)
    ok(fetched?.structuredContent?.note === 'hi', '只读结果接口：按 callId + owner 取回结构化结果')
    ok(service.getCallResult('call-1', { sessionId: 's-other', projectId: owner.projectId }) === null, '跨 owner 拒绝：别的 runner 读不到结果')
    ok(service.getCallResult('call-other', owner) === null, '只读结果接口：未知 callId 返回 null')

    let seen
    const off = service.onCallResult((event) => { seen = event })
    await service.call({ owner, callId: 'call-2', serverId: 'app-stdio', toolName: 'no_visibility_note', args: {} })
    off()
    ok(seen?.callId === 'call-2' && seen?.text === 'plain', '结构化结果回调：每次调用都会通知')

    /* 32KB 超限：完整 content 受控落盘，且不泄露原始 Meta。 */
    const huge = await service.call({ owner, callId: 'call-huge', serverId: 'app-stdio', toolName: 'read_only_note', args: { text: 'x'.repeat(40_000) } })
    ok(huge.truncated && huge.textBytes > 40_000, '32KB：超限调用标记 truncated 并如实回报字节数')
    ok(typeof huge.spilledPath === 'string' && huge.text.includes('完整 content 已受控落盘'), '32KB：超限 content 受控落盘并在文本里给出路径')
    const spilled = await readFile(huge.spilledPath, 'utf8')
    ok(spilled.length === 'note:'.length + 40_000, '32KB：落盘的是完整 content 文本')
    ok(!spilled.includes('structuredContent') && !spilled.includes('resourceUri'), '32KB：落盘不含原始 Meta / structuredContent')

    await assert.rejects(
      service.call({ owner, callId: 'call-3', serverId: 'app-stdio', toolName: 'app_only_refresh', args: {} }),
      (error) => error.code === 'mcp_app_only_tool',
      'app-only 绕过：模型代理通道拒绝'
    )
    await assert.rejects(
      service.call({ owner, callId: 'call-4', serverId: 'app-stdio', toolName: 'nope', args: {} }),
      (error) => error.code === 'mcp_app_unknown_tool',
      '未知工具：明确失败'
    )
    await assert.rejects(
      service.call({ owner, callId: 'call-5', serverId: 'native-stdio', toolName: 'read_only_note', args: {} }),
      (error) => error.code === 'not-managed',
      '未托管服务：拒绝代理调用'
    )
    await assert.rejects(
      service.call({ owner: { sessionId: '', projectId: '' }, callId: 'call-6', serverId: 'app-stdio', toolName: 'read_only_note', args: {} }),
      (error) => error.code === 'owner_invalid',
      '非法 owner：拒绝代理调用'
    )
    await assert.rejects(
      service.call({ owner, callId: '../escape', serverId: 'app-stdio', toolName: 'read_only_note', args: {} }),
      (error) => error.code === 'call_id_invalid',
      '非法 callId：拒绝（路径不落盘）'
    )
  }

  /* ============================ 3. 取消透传 ============================ */

  {
    const controller = new AbortController()
    const pending = service.call({ owner, callId: 'call-cancel', serverId: 'app-stdio', toolName: 'slow', args: {}, signal: controller.signal })
    await delay(200)
    controller.abort()
    const error = await pending.then(() => null, (thrown) => thrown)
    ok(error?.code === 'cancelled', '取消：挂起调用以明确取消失败，不返回成功', error?.code)
  }

  /* ============================ 4. 旧入口托管拦截 ============================ */

  {
    proxy.assertLegacyMcpAccessBlocked({ env, serverId: 'native-stdio', toolName: 'read_only_note', action: 'call' })
    ok(true, '旧入口：非托管服务保持原样放行')
    assert.throws(
      () => proxy.assertLegacyMcpAccessBlocked({ env, serverId: 'app-stdio', toolName: 'read_only_note', action: 'call' }),
      (error) => error.code === 'mcp_app_use_proxy',
      '旧入口：托管服务模型可见工具也拒绝，不建第二持有者'
    )
    assert.throws(
      () => proxy.assertLegacyMcpAccessBlocked({ env, serverId: 'app-stdio', toolName: 'read_only_note', action: 'describe' }),
      (error) => error.code === 'mcp_app_use_proxy',
      '旧入口：describe 同样拒绝（MA2 遗留的 describe 走 legacy 风险已收口）'
    )
    assert.throws(
      () => proxy.assertLegacyMcpAccessBlocked({ env, serverId: 'app-stdio', toolName: 'app_only_refresh', action: 'call' }),
      (error) => error.code === 'mcp_app_only_tool',
      '旧入口：app-only 工具被拦截'
    )
    ok(true, '旧入口：app-only 工具被拦截（yan mcp call 不能绕过）')
    assert.throws(
      () => proxy.assertLegacyMcpAccessBlocked({ env, serverId: 'app-stdio', toolName: 'unknown', action: 'call' }),
      (error) => error.code === 'mcp_app_use_proxy',
      '旧入口：快照外的工具同样 fail closed'
    )
    ok(true, '旧入口：快照外的工具 fail closed')
  }

  /* ============================ 5. 名字碰撞整体拒绝 ============================ */

  {
    const collisionDir = join(root, 'collision')
    const collisionHost = {
      listManagedServers: () => [
        { id: 's-1', transport: 'stdio', command: 'x', enabled: true, ownedBy: 'inkstone', appHost: appHostMark('s-1') },
        { id: 's_1', transport: 'stdio', command: 'x', enabled: true, ownedBy: 'inkstone', appHost: appHostMark('s_1') }
      ],
      listToolsWithMeta: async () => [
        { name: 'x', modelVisible: true, appVisible: false, visibility: ['model'], resourceUri: null }
      ],
      callToolWithMeta: async () => { throw new Error('unused') },
      statusOf: () => ({ status: 'ready' })
    }
    const collisionService = new proxy.McpAppProxyService({ env, dir: collisionDir, host: collisionHost })
    const result = await collisionService.refresh()
    ok(result.ok === false && result.written === false && result.error === proxy.MCP_APP_PROXY_COLLISION, '碰撞：刷新被整体拒绝，不写出')
    ok(result.collisions.length === 1 && result.collisions[0].name === 'mcp__s_1__x', '碰撞：指出规范化后的名字', JSON.stringify(result.collisions))
    await assert.rejects(
      readFile(collisionService.snapshotPath(), 'utf8'),
      '碰撞：没有留下半份快照'
    )
  }

  /* ================== 5b. 跨项目快照：按 runner 项目注入可见子集 ================== */

  {
    const scopedDir = join(root, 'scoped')
    const listCalls = []
    const scopedHost = {
      listManagedServers: () => [
        { id: 'global-app', transport: 'stdio', command: 'x', enabled: true, ownedBy: 'inkstone', appHost: appHostMark('global-app') },
        { id: 'proj-a-app', transport: 'stdio', command: 'x', enabled: true, ownedBy: 'inkstone', projectScope: 'p-a', appHost: appHostMark('proj-a-app') },
        { id: 'proj-b-app', transport: 'stdio', command: 'x', enabled: true, ownedBy: 'inkstone', projectScope: 'p-b', appHost: appHostMark('proj-b-app') }
      ],
      listToolsWithMeta: async (serverId, options) => {
        listCalls.push({ serverId, projectId: options?.projectId })
        return [
          { name: 'note', modelVisible: true, appVisible: false, visibility: ['model'], resourceUri: null, description: `desc-${serverId}` }
        ]
      },
      callToolWithMeta: async () => {
        throw new Error('unused')
      },
      statusOf: () => ({ status: 'ready' })
    }
    const scopedService = new proxy.McpAppProxyService({ env, dir: scopedDir, host: scopedHost })

    /* 无 caller 项目：项目 A/B 一律不连；全局可见。 */
    const noCaller = await scopedService.refresh()
    ok(noCaller.written && noCaller.tools.length === 1, '无项目事实：只刷新全局，不连项目服务', String(noCaller.tools.length))
    ok(listCalls.length === 1 && listCalls[0].serverId === 'global-app', '无项目事实：listTools 只发生在全局服务', JSON.stringify(listCalls))
    ok(!listCalls.some((call) => call.projectId === 'p-b'), '无项目事实：绝不用目标 projectScope 当 caller 连 B')

    /* 项目 A 前台：只连全局 + A，且 caller projectId 是 A（不是目标 scope 自证）。 */
    listCalls.length = 0
    const forA = await scopedService.refresh({ callerProjectId: 'p-a' })
    const ids = forA.tools.map((tool) => tool.serverId).sort().join(',')
    ok(forA.written && ids === 'global-app,proj-a-app', '项目 A 刷新：只收全局 + A', ids)
    ok(!forA.tools.some((tool) => tool.serverId === 'proj-b-app'), '项目 A 刷新：不收 B')
    ok(
      listCalls.every((call) => call.projectId === 'p-a') && listCalls.some((call) => call.serverId === 'proj-a-app'),
      '项目 A 刷新：caller projectId 由参数透传，不从目标 scope 猜',
      JSON.stringify(listCalls)
    )

    /* 显式空白名单 = 0 目标：不启动任何服务，不写快照。 */
    listCalls.length = 0
    const beforeEmpty = await readFile(scopedService.snapshotPath(), 'utf8')
    const empty = await scopedService.refresh({ serverIds: [], callerProjectId: 'p-a' })
    ok(empty.written === false && listCalls.length === 0, '显式空 serverIds：0 目标、不启动任何服务')
    ok(empty.error === proxy.MCP_APP_PROXY_NO_TARGETS, '显式空 serverIds：明确 no_targets', empty.error)
    const afterEmpty = await readFile(scopedService.snapshotPath(), 'utf8')
    ok(afterEmpty === beforeEmpty, '显式空 serverIds：不覆盖旧快照')

    const projTool = forA.tools.find((tool) => tool.serverId === 'proj-a-app')
    ok(projTool?.projectScope === 'p-a', '跨项目快照：条目带各自 projectScope，供薄层按 runner 项目筛选')
    ok(proxy.MCP_APP_PROXY_PROJECT_ENV === 'YAN_MCP_APP_PROJECT_ID', '跨项目快照：项目身份环境变量名固定')
  }

  /* ============ 5c. 配置读取失败 / 无可信 caller：默认拒绝，不写半份 ============ */

  {
    const failDir = join(root, 'config-fail')
    const failHost = {
      listManagedServers: () => {
        throw new Error('mcp-servers.json 损坏')
      },
      listToolsWithMeta: async () => [],
      callToolWithMeta: async () => {
        throw new Error('unused')
      },
      statusOf: () => ({ status: 'disconnected' })
    }
    const failService = new proxy.McpAppProxyService({ env, dir: failDir, host: failHost })
    await assert.rejects(failService.refresh({ callerProjectId: 'p-a' }), /mcp-servers\.json/, '配置读取失败：刷新抛出，不写出')
    await assert.rejects(readFile(failService.snapshotPath(), 'utf8'), '配置读取失败：没有留下快照')
  }

  /* ============================ 6. 过期快照 ============================ */

  {
    const staleDir = join(root, 'stale')
    await mkdir(staleDir, { recursive: true })
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    await writeFile(
      join(staleDir, 'tools.json'),
      JSON.stringify({ version: 1, generatedAt: old, source: 'x', tools: [], servers: [], excluded: [] }),
      'utf8'
    )
    const stale = new proxy.McpAppProxyService({ env, dir: staleDir })
    const status = stale.snapshotStatus()
    ok(status.present && status.stale && status.needsRefresh === true, '过期快照：视为待用户刷新')
    ok(stale.registrableTools().length === 0, '过期快照：不拿旧表注册工具')
  }

  /* ============================ 7. 薄扩展（假 pi） ============================ */

  {
    const makePi = () => {
      const registered = new Map()
      return { registered, registerTool: (definition) => registered.set(definition.name, definition) }
    }
    const writeSnapshot = async (file, tools, generatedAt = new Date().toISOString()) => {
      await writeFile(file, JSON.stringify({ version: 1, generatedAt, source: 'x', tools, servers: [], excluded: [] }), 'utf8')
    }

    const savedFile = process.env.YAN_MCP_APP_TOOLS
    const savedEnv = {
      url: process.env.YAN_CLI_URL,
      token: process.env.YAN_CLI_TOKEN,
      session: process.env.YAN_SESSION_ID,
      project: process.env.YAN_PROJECT_ID,
      appProject: process.env.YAN_MCP_APP_PROJECT_ID
    }

    delete process.env.YAN_MCP_APP_TOOLS
    const nonePi = makePi()
    extension.default(nonePi)
    ok(nonePi.registered.size === 0, '扩展：没有快照 → 不注册任何工具')

    const snapshotA = join(root, 'ext-a.json')
    await writeSnapshot(snapshotA, [
      { name: 'mcp__app_stdio__read_only_note', serverId: 'app-stdio', toolName: 'read_only_note', description: '只读', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } },
      { name: 'mcp__app_stdio__no_visibility_note', serverId: 'app-stdio', toolName: 'no_visibility_note' }
    ])
    process.env.YAN_MCP_APP_TOOLS = snapshotA
    const piA = makePi()
    extension.default(piA)
    ok(piA.registered.size === 2, '扩展：按快照注册 2 个工具', [...piA.registered.keys()].join(','))
    const readOnlyDef = piA.registered.get('mcp__app_stdio__read_only_note')
    ok(readOnlyDef?.annotations?.readOnlyHint === true && readOnlyDef?.annotations?.destructiveHint === false, '扩展：annotations 逐字保留（供 danger-guard 同口径）')
    ok(readOnlyDef?.parameters?.properties?.text?.type === 'string', '扩展：schema 逐字保留')
    ok(typeof readOnlyDef?.execute === 'function', '扩展：注册了 execute')

    /* 空 schema / 缺注解：按最严补齐，仍然注册。 */
    const fallbackDef = piA.registered.get('mcp__app_stdio__no_visibility_note')
    ok(fallbackDef?.parameters?.type === 'object' && fallbackDef?.annotations === undefined, '扩展：缺 schema 补成空对象；缺注解不臆造')

    /* 参数转发：执行时只打宿主能力端点。 */
    const calls = []
    const hostServer = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let payload = {}
        try { payload = JSON.parse(body) } catch { /* 记录原文 */ }
        calls.push(payload)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, summary: { kind: 'mcp-app-call', text: 'proxied', isError: false } }))
      })
    })
    await new Promise((done) => hostServer.listen(0, '127.0.0.1', done))
    process.env.YAN_CLI_URL = `http://127.0.0.1:${hostServer.address().port}/rpc`
    process.env.YAN_CLI_TOKEN = 'fixture-token'
    process.env.YAN_SESSION_ID = 's-runner-1'
    process.env.YAN_PROJECT_ID = 'p-project-1'
    const result = await readOnlyDef.execute('call-9', { text: 'forwarded' }, undefined)
    ok(result?.content?.[0]?.text === 'proxied' && result?.isError !== true, '扩展：执行结果取 summary.text')
    const sent = calls.at(-1)
    ok(sent?.command === 'mcp.app.call' && sent?.params?.callId === 'call-9', '扩展：请求走 mcp.app.call 并带 callId')
    ok(sent?.params?.serverId === 'app-stdio' && sent?.params?.toolName === 'read_only_note', '扩展：带原始 serverId / toolName')
    ok(sent?.params?.arguments?.text === 'forwarded', '扩展：参数原样转发')
    ok(sent?.sessionId === 's-runner-1' && sent?.projectId === 'p-project-1', '扩展：身份按环境值回传（宿主逐一比对）')

    /* 端点不可用：明确失败，不 fallback。 */
    const closedPort = await new Promise((done) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const port = probe.address().port
        probe.close(() => done(port))
      })
    })
    process.env.YAN_CLI_URL = `http://127.0.0.1:${closedPort}/rpc`
    const failed = await readOnlyDef.execute('call-10', {}, undefined)
    ok(failed?.isError === true && /调用失败|未获放行/.test(failed.content[0].text), '扩展：端点不可用明确失败，不降级')
    process.env.YAN_CLI_URL = `http://127.0.0.1:${hostServer.address().port}/rpc`

    /* schema 刷新需 reload：文件变了，已注册的工具表不变。 */
    const snapshotB = join(root, 'ext-b.json')
    await writeSnapshot(snapshotB, [
      { name: 'mcp__app_stdio__client_capabilities', serverId: 'app-stdio', toolName: 'client_capabilities' }
    ])
    await writeSnapshot(snapshotA, [
      { name: 'mcp__app_stdio__client_capabilities', serverId: 'app-stdio', toolName: 'client_capabilities' }
    ])
    ok(piA.registered.has('mcp__app_stdio__read_only_note'), '刷新需 reload：已运行扩展的工具表不变')
    process.env.YAN_MCP_APP_TOOLS = snapshotB
    const piB = makePi()
    extension.default(piB)
    ok(piB.registered.has('mcp__app_stdio__client_capabilities') && !piB.registered.has('mcp__app_stdio__read_only_note'), '刷新需 reload：新启动才读到新快照')

    /* 跨项目筛选：只注册「全局 + 当前项目」，别的项目连 schema / 描述都不注册。 */
    const scopedSnap = join(root, 'ext-scoped.json')
    await writeSnapshot(scopedSnap, [
      { name: 'mcp__g__a', serverId: 'g', toolName: 'a' },
      { name: 'mcp__p_a__b', serverId: 'p-a', toolName: 'b', projectScope: 'project-alpha' },
      { name: 'mcp__p_b__c', serverId: 'p-b', toolName: 'c', projectScope: 'project-beta' }
    ])
    process.env.YAN_MCP_APP_TOOLS = scopedSnap
    delete process.env.YAN_MCP_APP_PROJECT_ID
    const piNoProject = makePi()
    extension.default(piNoProject)
    ok(piNoProject.registered.has('mcp__g__a') && piNoProject.registered.size === 1, '扩展：无项目身份只注册全局工具')
    process.env.YAN_MCP_APP_PROJECT_ID = 'project-alpha'
    const piAlpha = makePi()
    extension.default(piAlpha)
    ok(
      piAlpha.registered.has('mcp__g__a') && piAlpha.registered.has('mcp__p_a__b') && !piAlpha.registered.has('mcp__p_b__c'),
      '扩展：只注册全局 + 本项目，别的项目 schema / 描述不注册'
    )

    /* 碰撞 / 坏快照：整体不注册，fail closed。 */
    const collisionSnap = join(root, 'ext-collision.json')
    await writeSnapshot(collisionSnap, [
      { serverId: 's-1', toolName: 'x' },
      { serverId: 's_1', toolName: 'x' }
    ])
    process.env.YAN_MCP_APP_TOOLS = collisionSnap
    const piCollision = makePi()
    extension.default(piCollision)
    ok(piCollision.registered.size === 0, '扩展：名字碰撞整体拒绝注册')

    const badSnap = join(root, 'ext-bad.json')
    await writeFile(badSnap, '{not json', 'utf8')
    process.env.YAN_MCP_APP_TOOLS = badSnap
    const piBad = makePi()
    extension.default(piBad)
    ok(piBad.registered.size === 0, '扩展：坏 JSON 不注册')

    /* 还原环境 */
    await new Promise((done) => hostServer.close(done))
    if (savedFile === undefined) delete process.env.YAN_MCP_APP_TOOLS
    else process.env.YAN_MCP_APP_TOOLS = savedFile
    if (savedEnv.url === undefined) delete process.env.YAN_CLI_URL
    else process.env.YAN_CLI_URL = savedEnv.url
    if (savedEnv.token === undefined) delete process.env.YAN_CLI_TOKEN
    else process.env.YAN_CLI_TOKEN = savedEnv.token
    if (savedEnv.session === undefined) delete process.env.YAN_SESSION_ID
    else process.env.YAN_SESSION_ID = savedEnv.session
    if (savedEnv.project === undefined) delete process.env.YAN_PROJECT_ID
    else process.env.YAN_PROJECT_ID = savedEnv.project
    if (savedEnv.appProject === undefined) delete process.env.YAN_MCP_APP_PROJECT_ID
    else process.env.YAN_MCP_APP_PROJECT_ID = savedEnv.appProject
  }

  /* ============ 8. 真实随包 pi：registerTool 注解能被 getAllTools 看见 ============ */

  {
    const runtimeDir = selectedPiRuntime(resolve('resources/pi-runtime'))
    const cli = join(runtimeDir, 'dist/bundle/cli.js')
    const piDir = join(root, 'pi')
    const extDir = join(piDir, 'extensions')
    const sessionsDir = join(root, 'sessions')
    const probeLog = join(root, 'proxy-probe.jsonl')
    for (const dir of [piDir, extDir, sessionsDir]) await mkdir(dir, { recursive: true })

    /* 本机回环假 provider：只回一条普通助手消息，不需要真实凭据 / 外网。 */
    const providerRequests = []
    const providerServer = createServer((req, res) => {
      let body = ''
      req.on('data', (part) => { body += part })
      req.on('end', () => {
        try { providerRequests.push(JSON.parse(body)) } catch { /* 仍应答 */ }
        const sse = (delta, finish) => `data: ${JSON.stringify({ id: 'proxy-fix', object: 'chat.completion.chunk', created: 0, model: 'proxy-physical', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(sse({ role: 'assistant', content: 'PROXY-BOOT-OK' }))
        res.write(sse({}, 'stop'))
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise((done) => providerServer.listen(0, '127.0.0.1', done))
    const providerPort = providerServer.address().port

    await writeFile(join(piDir, 'auth.json'), '{}')
    await writeFile(
      join(piDir, 'models.json'),
      JSON.stringify({
        providers: {
          'proxy-fixture': {
            baseUrl: `http://127.0.0.1:${providerPort}/v1`,
            api: 'openai-completions',
            apiKey: 'fixture-only',
            models: [{ id: 'proxy-physical', name: 'proxy fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }]
          }
        }
      })
    )
    await writeFile(
      join(piDir, 'settings.json'),
      JSON.stringify({ packages: [], defaultProvider: 'proxy-fixture', defaultModel: 'proxy-fixture/proxy-physical', defaultTools: ['read'], compaction: { enabled: false } })
    )
    await copyFile(proxyExtension, join(extDir, 'mcp-app-proxy.js'))
    await copyFile(resolve('scripts/fixtures/mcp-app-proxy-probe.mjs'), join(extDir, '0-mcp-app-proxy-probe.js'))

    const cleanEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|_TOKEN$|^ANTHROPIC_|^OPENAI_|^GEMINI_|^GOOGLE_|^XAI_|^GROK_|^DEEPSEEK_|^OPENROUTER_|^AWS_|^AZURE_|^MISTRAL_|^COHERE_)/i.test(key)) continue
      cleanEnv[key] = value
    }
    const piEnv = {
      ...cleanEnv,
      PI_CODING_AGENT_DIR: piDir,
      YAN_PI_DIR: piDir,
      YAN_DATA_DIR: yanDir,
      YAN_SESSIONS_DIR: sessionsDir,
      PI_OFFLINE: '1',
      YAN_MCP_APP_TOOLS: service.snapshotPath(),
      MCP_APP_PROXY_PROBE_LOG: probeLog
    }

    const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--session-dir', sessionsDir], {
      cwd: root,
      env: piEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buffer = ''
    let stderr = ''
    const frames = []
    const pending = new Map()
    let seq = 0
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (part) => {
      buffer += part
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        frames.push(frame)
        if (frame.type === 'response' && pending.has(String(frame.id))) {
          const entry = pending.get(String(frame.id))
          pending.delete(String(frame.id))
          clearTimeout(entry.timer)
          entry.resolve(frame)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (part) => { stderr += part })
    const command = (type, params = {}, timeoutMs = 30000) =>
      new Promise((resolveCommand, rejectCommand) => {
        const id = String(++seq)
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectCommand(new Error(`RPC 超时 ${type}：${stderr.slice(-800)}`))
        }, timeoutMs)
        pending.set(id, { timer, resolve: (value) => { clearTimeout(timer); resolveCommand(value) }, reject: rejectCommand })
        child.stdin.write(`${JSON.stringify({ id, type, ...params })}\n`)
      })

    try {
      const ready = await command('get_state')
      ok(ready.success === true, '真实 pi：get_state 成功（随包 1.2.0 + 本机隔离目录）', ready.error)
      await command('set_model', { provider: 'proxy-fixture', modelId: 'proxy-physical' }).catch(() => undefined)
      const before = frames.length
      await command('prompt', { message: 'MCP_APP_PROXY_BOOT' }, 60000)
      const settled = Date.now() + 60000
      while (Date.now() < settled && !frames.slice(before).some((frame) => frame.type === 'agent_settled')) await delay(20)
      let probe = []
      try {
        probe = (await readFile(probeLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      } catch { /* 探针没写出 */ }
      const session = probe.find((record) => record.kind === 'session_start')
      ok(Boolean(session), '真实 pi：session_start 探针记录了 getAllTools()')
      const tools = Array.isArray(session?.tools) ? session.tools : []
      const readOnly = tools.find((tool) => tool.name === 'mcp__app_stdio__read_only_note')
      ok(Boolean(readOnly), '真实 pi：注册的代理工具出现在 getAllTools() 里', tools.map((tool) => tool.name).join(','))
      ok(
        JSON.stringify(readOnly?.annotations) === '{"readOnlyHint":true,"destructiveHint":false}',
        '真实 pi：getAllTools() 能看见 registerTool 的 annotations（审批同口径成立）',
        JSON.stringify(readOnly?.annotations)
      )
      ok(readOnly?.parameters?.properties?.text?.type === 'string', '真实 pi：getAllTools() 保留 parameters schema')
      ok(readOnly?.description === '只读工具（fixture）：返回文本并声明 App 页面。', '真实 pi：getAllTools() 保留描述')
      ok(!tools.some((tool) => tool.name.includes('app_only_refresh')), '真实 pi：app-only 工具没有注册')
      ok(tools.some((tool) => tool.name === 'mcp__app_stdio__slow'), '真实 pi：缺 visibility 的工具按最严仍给模型')
    } finally {
      try { child.stdin.end() } catch { /* already closed */ }
      const exited = new Promise((done) => child.once('exit', done))
      const killTimer = setTimeout(() => child.kill(), 3000)
      await exited
      clearTimeout(killTimer)
      providerServer.closeAllConnections?.()
      await new Promise((done) => providerServer.close(done))
    }
  }

  console.log(`\n托管 MCP 代理通道：${checks} 项检查通过`)
} finally {
  await service.close()
  await proxy.closeMcpAppProxyService().catch(() => undefined)
  await proxy.closeMcpAppHost().catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await rm(bundleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
}
