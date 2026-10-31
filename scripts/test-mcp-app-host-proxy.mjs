import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'
import { createAccess, createFakeAppHost, createFakeLegacyManager, managedConfig, piConfig } from './fixtures/mcp-app-settings-boundary-fixture.mjs'

async function isolated(run) {
  const savedEnv = { ...process.env }
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
    Object.assign(process.env, savedEnv)
  }
}

async function hostSuite() {
const root = await mkdtemp(join(tmpdir(), 'yan-mcp-app-host-'))
process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_MCP_SERVERS_FILE = join(root, 'yan', 'mcp-servers.json')

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail !== undefined ? `（${detail}）` : ''}`)
  checks++
  console.log(`✓ ${message}`)
}
const fails = async (work, code, message) => {
  let thrown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  ok(
    Boolean(thrown) && thrown.code === code,
    message,
    thrown ? `${thrown.code}: ${thrown.message}` : '没有抛错'
  )
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

const fixture = resolve('scripts/fixtures/mcp-app-server.mjs')

const specOutfile = join(root, 'app-spec.mjs')
await build({
  entryPoints: [resolve('src/main/mcp/app-spec.ts')],
  outfile: specOutfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})

const hostOutfile = join(process.cwd(), 'out', 'test', 'mcp-app-host-bundle.mjs')
await build({
  stdin: {
    contents:
      "export * from './src/main/mcp/app-spec';" +
      "export * from './src/main/mcp/app-host';" +
      "export * from './src/main/mcp/config';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile: hostOutfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  logLevel: 'silent'
})
const host = await import(pathToFileURL(hostOutfile).href)

{
  ok(host.isMcpAppMimeType(host.MCP_APP_MIME_TYPE), '规范：标准 App MIME 被接受')
  ok(host.isMcpAppMimeType('text/html;profile=mcp-app;charset=utf-8'), '规范：带参数的 App MIME 被接受')
  ok(!host.isMcpAppMimeType('text/html'), '规范：缺 profile 参数的 text/html 被拒')
  ok(!host.isMcpAppMimeType('text/plain'), '规范：非 App MIME 被拒')
  ok(!host.isMcpAppMimeType(undefined), '规范：缺 MIME 被拒')

  const strict = host.mcpAppVisibilityOf(undefined)
  ok(strict.join(',') === 'model,app', '规范：缺 _meta.ui 同时向模型和 App 开放，调用仍走审批')
  ok(host.mcpAppVisibilityOf({ ui: { visibility: 'app' } })[0] === 'model', '缺省最严：visibility 不是数组时退回只给模型')
  ok(host.mcpAppVisibilityOf({ ui: { visibility: [] } }).length === 0, '规范：空 visibility 不向任何调用方开放')
  const appOnly = host.mcpAppVisibilityOf({ ui: { visibility: ['app'] } })
  ok(appOnly.length === 1 && appOnly[0] === 'app', 'visible：声明 app 才给 App')

  const csp = host.mcpAppCspOf({ ui: { csp: { connectDomains: ['https://a.invalid'], frameDomains: ['https://b.invalid'] } } })
  ok(csp?.connectDomains?.[0] === 'https://a.invalid' && csp?.frameDomains?.[0] === 'https://b.invalid', 'csp：从 _meta.ui.csp 读出域名列表')
  ok(host.mcpAppCspOf({ ui: {} }) === null, 'csp：未声明时是 null（推导走严格默认档）')

  ok(
    host.isInkstoneManaged({ ownedBy: 'inkstone', appHost: { at: 'x', natives: [] } }),
    '归属：ownedBy inkstone + appHost 才托管'
  )
  ok(!host.isInkstoneManaged({ ownedBy: 'inkstone' }), '归属：ownedBy inkstone 但缺 appHost 不算托管')
  ok(!host.isInkstoneManaged({ ownedBy: 'pi', appHost: { at: 'x', natives: [] } }), '归属：ownedBy pi 不算托管')
  ok(
    !host.isInkstoneManaged({ ownedBy: 'inkstone', appHost: { at: 'x', natives: [] }, enabled: false }),
    '归属：被禁用不算托管'
  )
}

const net = await import('node:net')
const port = 39400 + Math.floor(Math.random() * 500)
const httpChild = spawn(process.execPath, [fixture, '--http'], {
  stdio: 'ignore',
  env: { ...process.env, YAN_MCP_APP_SPEC_MODULE: specOutfile, YAN_MCP_APP_HTTP_PORT: String(port) }
})
{
  let up = false
  for (let i = 0; i < 80; i++) {
    up = await new Promise((done) => {
      const socket = net.connect({ port, host: '127.0.0.1' })
      socket.once('connect', () => { socket.destroy(); done(true) })
      socket.once('error', () => { socket.destroy(); done(false) })
    })
    if (up) break
    await delay(100)
  }
  ok(up, 'HTTP：合成服务器真监听上了')
}

const hostEntry = { command: 'original-node', args: ['orig.js'], custom: { keep: 'entry' } }
const configFile = join(root, 'yan', 'mcp-servers.json')
await mkdir(dirname(configFile), { recursive: true })
const appHostMark = (name) => ({
  at: '2026-10-16T00:00:00.000Z',
  natives: [{ path: join(root, 'pi-agent', 'mcp.json'), name, entry: hostEntry, fingerprint: 'fp-' + name, extraNativeField: { keep: true } }]
})
await writeFile(
  configFile,
  JSON.stringify({
    unknownTop: { keep: true },
    servers: [
      {
        id: 'app-stdio',
        title: '合成 App（stdio）',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        env: { YAN_MCP_APP_SPEC_MODULE: specOutfile },
        ownedBy: 'inkstone',
        appHost: appHostMark('app-stdio'),
        customField: { keep: true }
      },
      {
        id: 'app-http',
        transport: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        ownedBy: 'inkstone',
        appHost: appHostMark('app-http')
      },
      { id: 'native-stdio', transport: 'stdio', command: process.execPath, args: [fixture], ownedBy: 'pi' },
      { id: 'missing-mark', transport: 'stdio', command: process.execPath, args: [fixture], ownedBy: 'inkstone' }
    ]
  }),
  'utf8'
)

const ownership = new host.McpAppOwnershipGuard({
  agentDir: join(root, 'pi-agent'),
  projects: [],
  readNativeConfig: async () => null,
  holdersFor: async () => []
})
const env = { YAN_MCP_SERVERS_FILE: configFile }
const appHost = new host.McpAppHost({ env, timeoutMs: 20_000, ownership })

try {

  {
    const loaded = host.loadMcpServers(env)
    const stdio = loaded.servers.find((server) => server.id === 'app-stdio')
    ok(stdio?.ownedBy === 'inkstone' && stdio?.appHost?.natives?.[0]?.entry?.command === 'original-node', '配置：解析 ownedBy 与 appHost.natives[].entry')
    ok(stdio?.appHost?.at === '2026-10-16T00:00:00.000Z', '配置：解析 appHost.at')
    ok(JSON.stringify(stdio?.customField) === '{"keep":true}', '配置：顶层未知字段保留')
    ok(JSON.stringify(stdio?.appHost?.natives?.[0]?.extraNativeField) === '{"keep":true}', '配置：appHost 内的未知字段保留')
    ok(JSON.stringify(loaded.document?.unknownTop) === '{"keep":true}', '配置：文档级未知字段保留（导入/回写不抹）')
    const missing = loaded.servers.find((server) => server.id === 'missing-mark')
    ok(missing?.ownedBy === 'inkstone' && missing?.appHost === undefined, '配置：ownedBy inkstone 但缺 appHost 被如实解析为未托管')
    ok(host.isInkstoneManaged(stdio) && !host.isInkstoneManaged(missing), '配置：托管资格与解析一致')
    ok(appHost.listManagedServers().map((server) => server.id).join(',') === 'app-stdio,app-http', '连接前重读配置：只列托管服务')
  }

  {
    const tools = await appHost.listToolsWithMeta('app-stdio')
    ok(tools.length === 5, 'stdio：listToolsWithMeta 拿到全部工具', tools.map((tool) => tool.name).join(','))
    const readOnly = tools.find((tool) => tool.name === 'read_only_note')
    ok(readOnly?.modelVisible === true && readOnly?.appVisible === true, 'stdio：只读工具对模型与 App 都可见')
    ok(readOnly?.resourceUri === 'ui://mcp-app/dashboard.html', 'stdio：工具 _meta.ui.resourceUri 保真')
    ok(JSON.stringify(readOnly?.annotations) === '{"readOnlyHint":true,"destructiveHint":false}', 'stdio：原始 annotations 保真')
    const appOnly = tools.find((tool) => tool.name === 'app_only_refresh')
    ok(appOnly?.appVisible === true && appOnly?.modelVisible === false, 'stdio：app-only 工具对模型不可见')
    const noVisibility = tools.find((tool) => tool.name === 'no_visibility_note')
    ok(noVisibility?.modelVisible === true && noVisibility?.appVisible === true, 'stdio：缺 visibility 按规范同时向模型和 App 开放，调用仍走审批')

    const call = await appHost.callToolWithMeta('app-stdio', 'read_only_note', { text: 'hi' })
    ok(call.text === 'note:hi' && call.isError === false, 'stdio：callToolWithMeta 返回模型可见文本')
    ok(call.resourceUri === 'ui://mcp-app/dashboard.html', 'stdio：调用结果 _meta.ui.resourceUri 保真')
    ok(call.structuredContent?.note === 'hi' && call.structuredContent?.app === true, 'stdio：structuredContent 保真（只给界面）')
    ok(JSON.stringify(call.meta?.ui?.csp) === JSON.stringify({ connectDomains: ['https://api.example.invalid'], resourceDomains: ['https://cdn.example.invalid'], frameDomains: ['https://evil.invalid'], baseUriDomains: ['https://app.example.invalid'] }), 'stdio：原始 _meta 保真（含 csp）')

    const caps = await appHost.callToolWithMeta('app-stdio', 'client_capabilities', {})
    const declared = caps.structuredContent?.clientCapabilities
    ok(
      declared?.extensions?.[host.MCP_APP_EXTENSION_ID]?.mimeTypes?.includes(host.MCP_APP_MIME_TYPE) === true,
      'stdio：initialize 声明了 MCP Apps 的 ui 能力',
      JSON.stringify(declared)
    )

    const resource = await appHost.readResource('app-stdio', 'ui://mcp-app/dashboard.html')
    ok(resource.mimeType === host.MCP_APP_MIME_TYPE && resource.text.includes('合成 App'), 'stdio：资源读取成功且 MIME 正确')
    ok(resource.bytes === Buffer.byteLength(resource.text, 'utf8') && resource.bytes > 0, 'stdio：资源体积按字节如实回报')
    ok(resource.uiCsp?.connectDomains?.[0] === 'https://api.example.invalid', 'stdio：资源 _meta.ui.csp 保真')

    await fails(() => appHost.readResource('app-stdio', 'ui://mcp-app/plain.txt'), 'resource-invalid', 'stdio：MIME 不对的资源被拒')

    const smallHost = new host.McpAppHost({ env, timeoutMs: 20_000, maxResourceBytes: 1024, ownership })
    try {
      await fails(() => smallHost.readResource('app-stdio', 'ui://mcp-app/huge.html'), 'resource-too-large', 'stdio：超过体积上限的资源被拒')
      ok(smallHost.statusOf('app-stdio').status === 'ready', 'stdio：体积拒绝后连接仍可用（不是断线）')
    } finally {
      await smallHost.close()
    }

    await fails(() => appHost.callToolWithMeta('native-stdio', 'read_only_note', {}), 'not-managed', '拒绝连接：ownedBy pi 的服务')
    await fails(() => appHost.listToolsWithMeta('missing-mark'), 'not-managed', '拒绝连接：ownedBy inkstone 但缺 appHost 声明')
    await fails(() => appHost.listToolsWithMeta('nope'), 'not-managed', '拒绝连接：配置里没有的服务')
    ok(appHost.statusOf('native-stdio').status === 'disconnected', '拒绝连接后不留连接状态')

    const controller = new AbortController()
    const pending = appHost.callToolWithMeta('app-stdio', 'slow', {}, { signal: controller.signal })
    await delay(150)
    ok(appHost.statusOf('app-stdio').status === 'ready', '取消：挂起调用期间连接是 ready')
    const concurrent = await appHost.callToolWithMeta('app-stdio', 'no_visibility_note', {})
    ok(concurrent.text === 'plain', '取消：A 挂起时同连接并发的 B 成功')
    controller.abort()
    const cancelled = await pending.then(() => null, (error) => error)
    ok(cancelled instanceof Error, '取消：挂起的调用以错误结束')
    ok(appHost.statusOf('app-stdio').status === 'ready', '取消：中止后共享连接仍 ready（没被拆掉）')
    const after = await appHost.callToolWithMeta('app-stdio', 'no_visibility_note', {})
    ok(after.text === 'plain', '取消：之后同一连接继续可用')
  }

  {
    const tools = await appHost.listToolsWithMeta('app-http')
    ok(tools.length === 5, 'HTTP：listToolsWithMeta 拿到全部工具', tools.map((tool) => tool.name).join(','))
    const readOnly = tools.find((tool) => tool.name === 'read_only_note')
    ok(readOnly?.resourceUri === 'ui://mcp-app/dashboard.html', 'HTTP：工具 _meta.ui.resourceUri 保真')
    ok(tools.find((tool) => tool.name === 'no_visibility_note')?.appVisible === true, 'HTTP：缺 visibility 按规范同时向模型和 App 开放')

    const call = await appHost.callToolWithMeta('app-http', 'read_only_note', { text: 'h2' })
    ok(call.resourceUri === 'ui://mcp-app/dashboard.html' && call.structuredContent?.note === 'h2', 'HTTP：调用结果 _meta 与 structuredContent 保真')

    const resource = await appHost.readResource('app-http', 'ui://mcp-app/dashboard.html')
    ok(resource.mimeType === host.MCP_APP_MIME_TYPE && resource.uiCsp?.resourceDomains?.[0] === 'https://cdn.example.invalid', 'HTTP：资源读取与 csp 保真')

    const smallHttp = new host.McpAppHost({ env, timeoutMs: 20_000, maxResourceBytes: 1024, ownership })
    try {
      await fails(() => smallHttp.readResource('app-http', 'ui://mcp-app/huge.html'), 'resource-too-large', 'HTTP：超过体积上限的资源被拒')
    } finally {
      await smallHttp.close()
    }
  }

  {
    const first = host.mcpAppHost()
    const second = host.mcpAppHost()
    ok(first === second, '单例：mcpAppHost() 返回同一进程级实例')
    ok(first.listManagedServers().length === 2, '单例：按当前配置列出托管服务')
    await host.closeMcpAppHost()
    ok(host.mcpAppHost() !== first, '单例：关闭后重新创建')
  }
} finally {
  await appHost.close()
  await host.closeMcpAppHost().catch(() => undefined)
  httpChild.kill('SIGTERM')
  await delay(200)
  await rm(root, { recursive: true, force: true })
}

console.log(`\nMCP Apps 宿主连接层：${checks} 项检查通过`)
}

async function proxySuite() {
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

const specOutfile = join(root, 'app-spec.mjs')
await build({
  entryPoints: [resolve('src/main/mcp/app-spec.ts')],
  outfile: specOutfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
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

const ownershipDir = join(root, 'pi-agent')
await mkdir(ownershipDir, { recursive: true })
proxy.configureMcpAppHostOwnership({
  agentDir: ownershipDir,
  projects: [],
  holdersFor: async () => [],
  readNativeConfig: async () => null
})

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
    ok(toolNames.includes('mcp__app_stdio__no_visibility_note'), '注册名：缺 visibility 的工具默认对模型可见')
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

  {
    const record = await service.call({ owner, callId: 'call-1', serverId: 'app-stdio', toolName: 'read_only_note', args: { text: 'hi' } })
    ok(record.ok && record.text === 'note:hi', '调用：参数转发到后端并返回模型可见文本')
    ok(record.structuredContent?.note === 'hi' && record.structuredContent?.app === true, '调用：structuredContent 保留在宿主记录')
    ok(record.resourceUri === 'ui://mcp-app/dashboard.html', '调用：_meta.ui.resourceUri 保留在宿主记录')
    ok(record.uiCsp?.connectDomains?.[0] === 'https://api.example.invalid', '调用：_meta.ui.csp 保留在宿主记录')

    const fetched = service.getCallResult('call-1', owner)
    ok(fetched?.structuredContent?.note === 'hi', '只读结果接口：按 callId + owner 取回结构化结果')
    ok(fetched?.arguments?.text === 'hi', '官方 tool-input：保留原始参数，不重跑工具')
    ok(fetched?.result?.content?.[0]?.text === 'note:hi' && fetched?.result?.structuredContent?.note === 'hi', '官方 tool-result：保留 content 与 structuredContent')
    ok(service.getCallResult('call-1', { sessionId: 's-other', projectId: owner.projectId }) === null, '跨 owner 拒绝：别的 runner 读不到结果')
    ok(service.getCallResult('call-other', owner) === null, '只读结果接口：未知 callId 返回 null')

    const second = await service.call({ owner, callId: 'call-2', serverId: 'app-stdio', toolName: 'no_visibility_note', args: {} })
    ok(second.text === 'plain' && service.getCallResult('call-2', owner)?.text === 'plain', '连续调用：结果按 callId 可读回')

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

  {
    const controller = new AbortController()
    const pending = service.call({ owner, callId: 'call-cancel', serverId: 'app-stdio', toolName: 'slow', args: {}, signal: controller.signal })
    await delay(200)
    controller.abort()
    const error = await pending.then(() => null, (thrown) => thrown)
    ok(error?.code === 'cancelled', '取消：挂起调用以明确取消失败，不返回成功', error?.code)
  }

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

    const noCaller = await scopedService.refresh()
    ok(noCaller.written && noCaller.tools.length === 1, '无项目事实：只刷新全局，不连项目服务', String(noCaller.tools.length))
    ok(listCalls.length === 1 && listCalls[0].serverId === 'global-app', '无项目事实：listTools 只发生在全局服务', JSON.stringify(listCalls))
    ok(!listCalls.some((call) => call.projectId === 'p-b'), '无项目事实：绝不用目标 projectScope 当 caller 连 B')

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

    listCalls.length = 0
    const beforeEmpty = await readFile(scopedService.snapshotPath(), 'utf8')
    const empty = await scopedService.refresh({ serverIds: [], callerProjectId: 'p-a' })
    ok(empty.written === false && listCalls.length === 0, '显式空 serverIds：0 目标、不启动任何服务')
    ok(empty.error === proxy.MCP_APP_PROXY_NO_TARGETS, '显式空 serverIds：明确 no_targets', empty.error)
    const afterEmpty = await readFile(scopedService.snapshotPath(), 'utf8')
    ok(afterEmpty === beforeEmpty, '显式空 serverIds：不覆盖旧快照')

    const projTool = forA.tools.find((tool) => tool.serverId === 'proj-a-app')
    ok(projTool?.projectScope === 'p-a', '跨项目快照：条目带各自 projectScope，供薄层按 runner 项目筛选')
    await scopedService.refresh({ callerProjectId: 'p-b' })
    await scopedService.refresh({ callerProjectId: 'p-a' })
    const merged = JSON.parse(await readFile(scopedService.snapshotPath(), 'utf8')).tools.map((tool) => tool.serverId)
    ok(merged.includes('proj-a-app') && merged.includes('proj-b-app') && merged.filter((id) => id === 'global-app').length === 1, '按项目刷新不抹掉其他项目的托管工具，全局工具不重复', merged.join(','))
    ok(proxy.MCP_APP_PROXY_PROJECT_ENV === 'YAN_MCP_APP_PROJECT_ID', '跨项目快照：项目身份环境变量名固定')
  }

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

  {
    const makePi = () => {
      const registered = new Map()
      const hooks = new Map()
      return {
        registered,
        hooks,
        registerTool: (definition) => registered.set(definition.name, definition),
        on: (name, handler) => hooks.set(name, [...(hooks.get(name) ?? []), handler])
      }
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
    ok(nonePi.registered.size === 0 && nonePi.hooks.size === 0, '扩展：没有快照 → 不注册任何工具，也不加提示')

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

    const fallbackDef = piA.registered.get('mcp__app_stdio__no_visibility_note')
    ok(fallbackDef?.parameters?.type === 'object' && fallbackDef?.annotations === undefined, '扩展：缺 schema 补成空对象；缺注解不臆造')
    ok(/^[\x20-\x7e]+$/.test(fallbackDef?.description ?? '') && fallbackDef.description.includes('app-stdio'), '扩展：缺描述时补英文描述，带服务器名供检索', fallbackDef?.description)
    ok([...piA.registered.values()].every((definition) => definition.exposure === 'deferred'), '扩展：托管工具一律 deferred，不预先声明')
    ok(readOnlyDef?.namespace?.name === 'app-stdio' && /^[\x20-\x7e]+$/.test(readOnlyDef.namespace.description ?? ''), '扩展：namespace 按服务器归组，说明为英文')

    const startHooks = piA.hooks.get('before_agent_start') ?? []
    ok(startHooks.length === 1, '扩展：有托管工具时登记一个提示钩子')
    const sections = {}
    ok(startHooks[0]({ systemPrompt: 'BASE', systemPromptOptions: { sections } }) === undefined, '扩展：有具名分区时只写分区、不返回整段提示')
    ok((sections.inkstone_hosted_mcp ?? '').includes('app-stdio') && sections.inkstone_hosted_mcp.includes('tool_search'), '扩展：分区写明托管服务器名与 tool_search 用法', sections.inkstone_hosted_mcp)
    ok(/tool_search.*not Chinese/.test(sections.inkstone_hosted_mcp ?? ''), '扩展：说明 tool_search 不匹配中文检索词（F06）', sections.inkstone_hosted_mcp)
    ok(/^[\x20-\x7e]+$/.test(sections.inkstone_hosted_mcp ?? ''), '扩展：分区内容为英文')
    const injected = startHooks[0]({ systemPrompt: 'BASE' })
    ok(injected?.systemPrompt?.startsWith('BASE\n\n') && injected.systemPrompt.includes('app-stdio') && injected.systemPrompt.includes('tool_search'), '扩展：旧版 pi 没有分区时追加到系统提示末尾', injected?.systemPrompt)
    ok(startHooks[0]({ systemPrompt: injected.systemPrompt, systemPromptOptions: { sections: {} } }) === undefined, '扩展：已含说明时不重复追加')
    ok(extension.hostedServersNote([]) === '', '扩展：没有托管工具时不加说明')

    const calls = []
    const hostServer = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let payload = {}
        try { payload = JSON.parse(body) } catch { }
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

  {
    const runtimeDir = selectedPiRuntime(resolve(process.env.YAN_TEST_PI_RUNTIME_ROOT ?? 'resources/pi-runtime'))
    const cli = join(runtimeDir, 'dist/bundle/cli.js')
    const piDir = join(root, 'pi')
    const extDir = join(piDir, 'extensions')
    const sessionsDir = join(root, 'sessions')
    const probeLog = join(root, 'proxy-probe.jsonl')
    for (const dir of [piDir, extDir, sessionsDir]) await mkdir(dir, { recursive: true })

    const providerRequests = []
    const providerServer = createServer((req, res) => {
      let body = ''
      req.on('data', (part) => { body += part })
      req.on('end', () => {
        let request = null
        try { request = JSON.parse(body) } catch { }
        if (request) providerRequests.push(request)
        const sse = (delta, finish) => `data: ${JSON.stringify({ id: 'proxy-fix', object: 'chat.completion.chunk', created: 0, model: 'proxy-physical', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const searched = (request?.messages ?? []).some((message) => message?.role === 'tool')
        if (searched) {
          res.write(sse({ role: 'assistant', content: 'PROXY-BOOT-OK' }))
          res.write(sse({}, 'stop'))
        } else {
          res.write(sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'search-1', type: 'function', function: { name: 'tool_search', arguments: JSON.stringify({ query: 'read only note' }) } }] }))
          res.write(sse({}, 'tool_calls'))
        }
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
    await copyFile(resolve('resources/pi-extensions/codemode-policy.js'), join(extDir, 'codemode-policy.js'))
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
      ok(ready.success === true, '真实 pi：get_state 成功（随包 pi + 本机隔离目录）', ready.error)
      await command('set_model', { provider: 'proxy-fixture', modelId: 'proxy-physical' }).catch(() => undefined)
      const before = frames.length
      await command('prompt', { message: 'MCP_APP_PROXY_BOOT' }, 60000)
      const settled = Date.now() + 60000
      while (Date.now() < settled && !frames.slice(before).some((frame) => frame.type === 'agent_settled')) await delay(20)
      let probe = []
      try {
        probe = (await readFile(probeLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      } catch { }
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
      ok(tools.some((tool) => tool.name === 'mcp__app_stdio__slow'), '真实 pi：缺 visibility 的工具按规范仍对模型可见')
      ok(tools.length > 0 && tools.every((tool) => tool.exposure === 'deferred'), '真实 pi：托管工具的 exposure 保留为 deferred', tools.map((tool) => `${tool.name}=${tool.exposure}`).join(','))

      const declared = (request) => (request?.tools ?? []).map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean)
      const [first, second] = providerRequests
      const firstTools = declared(first)
      ok(firstTools.includes('tool_search'), '真实 pi：存在 deferred 工具时首个请求就声明 tool_search', firstTools.join(','))
      ok(!firstTools.some((name) => name.startsWith('mcp__app_stdio__')), '真实 pi：首个请求不预先声明托管工具 schema', firstTools.join(','))
      const systemText = (first?.messages ?? []).filter((message) => message?.role === 'system' || message?.role === 'developer').map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
      ok(systemText.includes('Inkstone-hosted MCP servers: app-stdio'), '真实 pi：系统提示列出托管服务器名')
      const secondTools = declared(second)
      ok(secondTools.includes('mcp__app_stdio__read_only_note'), '真实 pi：tool_search 命中后下一次请求声明该工具', secondTools.join(','))
      const searchResult = (second?.messages ?? []).find((message) => message?.role === 'tool')
      ok(String(typeof searchResult?.content === 'string' ? searchResult.content : JSON.stringify(searchResult?.content)).includes('mcp__app_stdio__read_only_note'), '真实 pi：tool_search 结果里列出加载的工具')
    } finally {
      try { child.stdin.end() } catch { }
      const exited = new Promise((done) => child.once('exit', done))
      const killTimer = setTimeout(() => child.kill(), 3000)
      await exited
      clearTimeout(killTimer)
      providerServer.closeAllConnections?.()
      await new Promise((done) => providerServer.close(done))
    }
  }

  {
    const envFileA = join(root, 'singleton-a.json')
    const envFileB = join(root, 'singleton-b.json')
    await writeFile(
      envFileA,
      JSON.stringify({ servers: [{ id: 'singleton-a', transport: 'stdio', command: 'node', ownedBy: 'inkstone', appHost: { at: 'x', natives: [] } }] })
    )
    await writeFile(
      envFileB,
      JSON.stringify({ servers: [{ id: 'singleton-b', transport: 'stdio', command: 'node', ownedBy: 'inkstone', appHost: { at: 'x', natives: [] } }] })
    )
    const withA = proxy.mcpAppProxyService({ env: { YAN_MCP_SERVERS_FILE: envFileA } })
    const withB = proxy.mcpAppProxyService({ env: { YAN_MCP_SERVERS_FILE: envFileB } })
    ok(withA === withB, '单例：调用记录只有一份（App 视图按 callId 读回）')
    ok(withB.managedConfigOrNull('singleton-b') !== null && withB.managedConfigOrNull('singleton-a') === null, '单例：后续 env 入参被采纳而不是被吞掉')
  }

  console.log(`\n托管 MCP 代理通道：${checks} 项检查通过`)
} finally {
  await service.close()
  await proxy.closeMcpAppProxyService().catch(() => undefined)
  await proxy.closeMcpAppHost().catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await rm(bundleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined)
}
}

async function approvalParitySuite() {
let checks = 0
const failures = []
const ok = (condition, message, detail) => {
  checks += 1
  if (!condition) {
    failures.push(message)
    console.log(`✗ ${message}${detail !== undefined ? `（${detail}）` : ''}`)
  } else {
    console.log(`✓ ${message}`)
  }
}

const bundled = await build({
  stdin: {
    contents:
      "export * from './src/shared/mcp-approval';" +
      "export * from './src/main/mcp/app-view-approval';" +
      "export * from './src/main/approval-broker';",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const shared = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

const ext = await import(pathToFileURL(resolve('resources/pi-extensions/danger-guard.js')).href)
ok(typeof shared.mcpApprovalNeeded === 'function', '加载共享 mcpApprovalNeeded')
ok(typeof ext.mcpApprovalNeeded === 'function', '加载扩展 mcpApprovalNeeded')

const CASES = [
  { key: 'none', annotations: undefined },
  { key: 'empty', annotations: {} },
  { key: 'null', annotations: null },
  { key: 'non-object', annotations: 42 },
  { key: 'readOnly-true', annotations: { readOnlyHint: true } },
  { key: 'readOnly-false', annotations: { readOnlyHint: false } },
  { key: 'destructive-true', annotations: { destructiveHint: true } },
  { key: 'destructive-false', annotations: { destructiveHint: false } },
  { key: 'idempotent-true', annotations: { idempotentHint: true } },
  { key: 'idempotent-false', annotations: { idempotentHint: false } },
  { key: 'openWorld-true', annotations: { openWorldHint: true } },
  { key: 'openWorld-false', annotations: { openWorldHint: false } },
  { key: 'ro+destructive', annotations: { readOnlyHint: true, destructiveHint: true } },
  { key: 'ro+openWorld', annotations: { readOnlyHint: true, openWorldHint: true } },
  { key: 'destructive-false+openWorld-false', annotations: { destructiveHint: false, openWorldHint: false } },
  { key: 'all-false', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { key: 'all-true', annotations: { readOnlyHint: true, destructiveHint: true, idempotentHint: true, openWorldHint: true } },
  { key: 'non-boolean-hints', annotations: { destructiveHint: 'yes', openWorldHint: 1, readOnlyHint: 0 } }
]

const toolNameOf = (key) => `mcp__srv__${key.replace(/[^a-zA-Z0-9]+/g, '_')}`

for (const { key, annotations } of CASES) {
  const name = toolNameOf(key)
  ok(
    ext.mcpApprovalNeeded(annotations) === shared.mcpApprovalNeeded(annotations),
    `approval 一致：${key}`,
    `${ext.mcpApprovalNeeded(annotations)} vs ${shared.mcpApprovalNeeded(annotations)}`
  )
  ok(
    JSON.stringify(ext.mcpCallDanger(name, annotations)) === JSON.stringify(shared.mcpCallDanger(name, annotations)),
    `理由一致：${key}`,
    JSON.stringify(ext.mcpCallDanger(name, annotations))
  )
  ok(
    JSON.stringify(ext.mcpTarget(name)) === JSON.stringify(shared.mcpTarget(name)),
    `target 一致：${key}`
  )
}

ok(shared.mcpCallDanger('bash', { destructiveHint: true }).length === 0, '非 mcp__ 工具不产生 MCP 理由')

const requests = []
let hostMode = 'danger'
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    let payload = {}
    try { payload = JSON.parse(body) } catch {}
    requests.push(payload)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload?.command === 'danger.confirm'
      ? { ok: true, summary: { kind: 'danger-confirm', allowed: true, decision: 'allow' } }
      : payload?.command === 'danger.prefs'
        ? { ok: true, summary: { mode: hostMode, outsideWrites: true, allowRoots: [] } }
        : { ok: true, summary: {} }))
  })
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const hostUrl = `http://127.0.0.1:${server.address().port}`

const dataDir = await mkdtemp(join(tmpdir(), 'yan-mcp-approval-parity-'))
process.env.YAN_CLI_URL = hostUrl
process.env.YAN_CLI_TOKEN = 'test-token'
process.env.YAN_SESSION_ID = 'test-session'
process.env.YAN_PROJECT_ID = 'test-project'
process.env.YAN_DATA_DIR = dataDir
delete process.env.YAN_DANGER_GUARD

const writePrefs = async (mode) => { hostMode = mode }

const tools = CASES.map(({ key, annotations }) => {
  const entry = { name: toolNameOf(key) }
  if (annotations !== undefined) entry.annotations = annotations
  return entry
})
let handler
const fakePi = {
  on: (event, fn) => { if (event === 'tool_call') handler = fn },
  getAllTools: () => tools
}
ext.default(fakePi)
ok(typeof handler === 'function', '扩展注册了 tool_call 处理器')

const observedAsk = async (name) => {
  const before = requests.filter((request) => request?.command === 'danger.confirm').length
  await handler({ toolName: name, toolCallId: 'call-1', input: { arg: 1 } }, { cwd: 'C:/proj' })
  return requests.filter((request) => request?.command === 'danger.confirm').length > before
}

for (const mode of ['danger', 'all']) {
  await writePrefs(mode)
  for (const { key, annotations } of CASES) {
    const name = toolNameOf(key)
    const expected = (mode === 'all' ? [] : shared.mcpCallDanger(name, annotations)).length > 0
    const asked = await observedAsk(name)
    ok(
      asked === expected,
      `处理器口径一致（${mode}）：${key}`,
      `asked=${asked} expected=${expected}`
    )
  }
}

await writePrefs('danger')

const baseCall = { server: 'srv', tool: 't', visibility: ['app'], cwd: 'C:/proj' }
const allowAsk = () => Promise.resolve({ choice: 'once' })
const denyAsk = () => Promise.resolve({ choice: 'deny' })

{
  const tracker = { calls: 0 }
  const result = await shared.approveAppViewCall(
    { ...baseCall, annotations: { readOnlyHint: true } },
    () => { tracker.calls += 1; return Promise.resolve({ choice: 'once' }) }
  )
  ok(result.allowed && result.asked && tracker.calls === 1 && result.recorded, '无宿主授权时只读调用先询问（不静默放行）')

  const trustedTracker = { calls: 0 }
  const now = Date.now()
  const trusted = await shared.approveAppViewCall(
    { ...baseCall, annotations: { readOnlyHint: true } },
    () => { trustedTracker.calls += 1; return Promise.resolve({ choice: 'once' }) },
    {
      serverFingerprint: 'f'.repeat(64),
      now,
      grants: [{ serverFingerprint: 'f'.repeat(64), scope: 'server', authorizer: 'user', expiresAt: now + 60_000 }]
    }
  )
  ok(trusted.allowed && !trusted.asked && trustedTracker.calls === 0, '有宿主 grant 的只读直接放行、不弹卡')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, denyAsk)
  ok(!result.allowed && result.asked && /拒绝/.test(result.reason ?? ''), '用户拒绝时视图调用被拒')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, () => Promise.resolve({ choice: 'once' }))
  ok(result.allowed && result.asked && result.recorded, '用户允许一次时视图调用放行')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, () => Promise.resolve({ choice: 'remember' }))
  ok(result.allowed, '允许并记住也视为放行')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { openWorldHint: true } }, () => Promise.reject(new Error('broken')))
  ok(!result.allowed && /没有得到用户确认/.test(result.reason ?? ''), '询问通道异常按无答复拒绝')
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, () => Promise.resolve(null))
  ok(!result.allowed && /没有得到用户确认|拒绝/.test(result.reason ?? ''), 'ask 返回 null 判拒绝')
}

{
  let asked = false
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: ['model'], annotations: { destructiveHint: true } }, () => { asked = true; return Promise.resolve({ choice: 'once' }) })
  ok(!result.allowed && !asked && /未向 App 视图开放/.test(result.reason ?? ''), 'visibility 不含 app 直接拒绝、不弹卡')
}
{
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: undefined, annotations: { destructiveHint: true } }, allowAsk)
  ok(!result.allowed && /缺少 visibility/.test(result.reason ?? ''), '缺 visibility 按最严处理（不对 App 开放）')
}
{
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: 'app', annotations: { destructiveHint: true } }, allowAsk)
  ok(!result.allowed && /缺少 visibility/.test(result.reason ?? ''), 'visibility 非数组按缺省处理')
}
{
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: [], annotations: { destructiveHint: true } }, allowAsk)
  ok(!result.allowed && /未向 App 视图开放/.test(result.reason ?? ''), 'visibility 空数组视为不含 app')
}
{
  const result = await shared.approveAppViewCall({ ...baseCall, visibility: ['model', 'app'], annotations: { destructiveHint: true } }, allowAsk)
  ok(result.allowed, 'visibility 含 app 且获允许时放行')
}

{
  let asked = false
  const result = await shared.approveAppViewCall({ ...baseCall, permissionMode: 'all', annotations: { destructiveHint: true } }, () => { asked = true; return Promise.resolve({ choice: 'deny' }) })
  ok(result.allowed && !asked && result.recorded && result.reasons.length > 0, 'all 档不拦截但仍记录风险')
}

{
  let approvedRequest = null
  const called = await shared.approveAppViewCall(
    { server: 'a__b', tool: 'c', visibility: ['app'], cwd: 'C:/proj', annotations: { destructiveHint: true } },
    (request) => {
      approvedRequest = request
      return Promise.resolve({ choice: 'once' })
    }
  )
  ok(
    called.allowed && approvedRequest?.title === 'App 视图请求调用 a__b / c',
    '审批卡标题用真实 server / tool（名字含 __ 也不错位）',
    approvedRequest?.title
  )
}

{
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: undefined }, denyAsk)
  ok(!result.allowed && result.asked, '缺注解按要问处理')
}

{
  const broker = new shared.ApprovalBroker({ canAsk: () => true, open: () => {}, close: () => {} })
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, _ms, ...rest) => realSetTimeout(fn, 0, ...rest)
  try {
    const choice = await broker.ask({ kind: 'danger', tool: 'mcp__srv__t', title: 't', detail: '{}', reasons: ['r'], cwd: '', canRemember: false })
    ok(choice === null, 'ApprovalBroker 超时判为无答复（null）')

    let askCalls = 0
    const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, () => {
      askCalls += 1
      return broker.ask({ kind: 'danger', tool: 'mcp__srv__t', title: 't', detail: '{}', reasons: ['r'], cwd: '', canRemember: false })
    })
    ok(askCalls === 1 && !result.allowed, '真实 broker 超时后视图调用判拒绝')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
}

{
  const broker = new shared.ApprovalBroker({ canAsk: () => false, open: () => {}, close: () => {} })
  const result = await shared.approveAppViewCall({ ...baseCall, annotations: { destructiveHint: true } }, (request) => broker.ask(request))
  ok(!result.allowed && result.asked, '无可用窗口时视图调用判拒绝')
}

await new Promise((ready) => server.close(ready))
await rm(dataDir, { recursive: true, force: true })

console.log(`\n${checks} 项，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}
}

async function settingsBoundarySuite() {
const root = await mkdtemp(join(process.cwd(), '.tmp', 'mcp-settings-boundary-'))
const configFile = join(root, 'mcp-servers.json')
process.env.YAN_MCP_SERVERS_FILE = configFile
process.env.YAN_DATA_DIR = join(root, 'yan')

let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail !== undefined ? `（${detail}）` : ''}`)
  checks++
  console.log(`✓ ${message}`)
}
const eq = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks++
  console.log(`✓ ${message}`)
}
const throwsCode = (work, code, message) => {
  let thrown
  try {
    work()
  } catch (error) {
    thrown = error
  }
  ok(Boolean(thrown) && thrown.code === code, message, thrown ? `${thrown.code}: ${thrown.message}` : '没有抛错')
}
const rejectsCode = async (work, code, message) => {
  let thrown
  try {
    await work()
  } catch (error) {
    thrown = error
  }
  ok(Boolean(thrown) && thrown.code === code, message, thrown ? `${thrown.code}: ${thrown.message}` : '没有抛错')
}

async function bundle(contents, name) {
  const outfile = join(root, name)
  await build({
    stdin: { contents, resolveDir: process.cwd(), sourcefile: `${name}.ts` },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(pathToFileURL(outfile).href)
}

const ipcMod = await bundle(
  "export { registerMcpAppIpc } from './src/main/ipc/mcp-app-ipc';",
  'main-ipc.mjs'
)
const helper = await bundle(
  "export * from './src/main/mcp/settings-safe-access';\nexport * from './src/shared/mcp-app-switch';",
  'settings-safe-access.mjs'
)
const renderer = await bundle(
  "export * from './src/renderer/src/features/settings/capabilities/mcp-app-ownership';",
  'renderer-ownership.mjs'
)

const { registerMcpAppIpc } = ipcMod
const {
  disconnectManagedServer,
  managedConfigOf,
  managedRuntimeFacts,
  probeManagedServer,
  reconcileLegacyManaged,
  verifyManagedServer
} = helper
const { parseMcpAppOwnershipResponse } = renderer

function captureIpc() {
  const handlers = new Map()
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn)
    },
    rawHandle(channel, fn) {
      handlers.set(channel, fn)
    }
  }
}

function registerWithDeps({ agent = { capabilityProjectId: null }, registry = () => null } = {}) {
  const ipc = captureIpc()
  registerMcpAppIpc(ipc, {
    currentAgent: () => agent,
    registry,
    settings: async () => ({ projects: [] }),
    isProjectTrusted: async () => true
  })
  return ipc.handlers.get('yan:mcpApp:ownership')
}

await writeFile(
  configFile,
  JSON.stringify([{ id: 'svc-a', transport: 'stdio', command: 'node', args: ['x.js'] }])
)
const realHandler = registerWithDeps()
const handlerOutput = await realHandler()
ok(handlerOutput && !Array.isArray(handlerOutput) && Array.isArray(handlerOutput.servers), 'ownership handler 返回 { servers } 对象，不是数组')
eq(handlerOutput.servers.length, 1, 'ownership handler 从真实砚配置产出 1 条视图')
const parsedReal = parseMcpAppOwnershipResponse(handlerOutput)
ok(parsedReal.ok === true, '真实 handler 输出经解析 helper 解包成功')
eq(parsedReal.views.map((view) => view.serverId), ['svc-a'], '解析得到视图数组（serverId）')

await writeFile(configFile, '{ not json')
const brokenOutput = await registerWithDeps()()
ok(typeof brokenOutput.error === 'string' && brokenOutput.error.length > 0, '配置损坏时 handler 返回可展示的 error')
const parsedBroken = parseMcpAppOwnershipResponse(brokenOutput)
ok(parsedBroken.ok === false && parsedBroken.code === 'backend_error', '后端 error 被解析为失败（backend_error）')

for (const [label, payload] of [
  ['null', null],
  ['数组', [managedConfig('a')]],
  ['缺 servers', { error: '' }],
  ['servers 非数组', { servers: { 0: managedConfig('a') } }],
  ['条目缺 serverId', { servers: [{ ownedBy: 'pi', managed: false }] }],
  ['条目缺 ownedBy', { servers: [{ serverId: 'a', managed: false }] }]
]) {
  const parsed = parseMcpAppOwnershipResponse(payload)
  ok(parsed.ok === false && parsed.code === 'ownership_response_invalid', `拒绝畸形响应：${label}`)
}
const parsedEmpty = parseMcpAppOwnershipResponse({ servers: [] })
ok(parsedEmpty.ok === true && parsedEmpty.views.length === 0, 'servers:[] 无 error 是正常空状态')

{
  const log = []
  const legacy = createFakeLegacyManager(['A'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A')], managers: [legacy], host, log })
  const facts = await verifyManagedServer(access, 'A', 'proj-1')
  eq(facts.toolCount, 2, '托管检查用 host.listToolsWithMeta 的工具数')
  ok(log.includes('legacy.disconnect:A'), '托管检查前 await 断开旧 legacy 的该 server')
  ok(log.includes('host.reconcile:A'), '托管检查先 host.reconcile')
  ok(log.includes('host.listToolsWithMeta:A:proj-1'), '托管检查传真实 caller 项目身份')
  ok(!log.some((line) => line.startsWith('legacy.listToolsCached')), '托管检查不走 legacy listToolsCached')
}

{
  const log = []
  const legacy = createFakeLegacyManager(['A'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A')], managers: [legacy], host, log })
  await verifyManagedServer(access, 'A', 'proj-1')
  ok(!log.includes('legacy.listToolsCached:A'), 'pi→inkstone 后旧 client 不再被用来连 A')
  ok(log.filter((line) => line === 'legacy.disconnect:A').length === 1, '旧 client 的 A 恰好被断开一次')
}

{
  const log = []
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A')], managers: [], host, log })
  const status = managedRuntimeFacts(access, 'A')
  eq(status.status, 'disconnected', '托管状态读 host.statusOf')
  ok(!log.some((line) => line.startsWith('host.reconcile') || line.startsWith('host.listToolsWithMeta')), '只读 status 不 reconcile / 不连接')
}

{
  const log = []
  const host = createFakeAppHost(log, {
    reconcile: async () => {
      throw new Error('status must not reconcile')
    },
    listToolsWithMeta: async () => {
      throw new Error('status must not connect')
    },
    disconnect: async () => {
      throw new Error('status must not disconnect')
    }
  })
  const access = createAccess({ servers: [managedConfig('A')], managers: [], host, log })
  const status = managedRuntimeFacts(access, 'A')
  ok(status.toolCount === null, '读状态不连接（host 连接方法未被调用）')
}

{
  const log = []
  const legacy = createFakeLegacyManager(['A', 'B'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A'), managedConfig('B')], managers: [legacy], host, log })
  await disconnectManagedServer(access, 'A', 'proj-1')
  ok(log.includes('host.disconnect:A'), '断开托管 A 只调用 host.disconnect:A')
  ok(!log.includes('host.disconnect:B'), '断开 A 不碰 B')
  ok(!log.includes('host.close'), '断开 A 不 close 整个连接池')
  ok(!log.includes('legacy.disconnect:B'), '断 A 不误断 legacy B')
}

{
  const log = []
  const legacy = createFakeLegacyManager(['A'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [piConfig('A')], managers: [legacy], host, log })
  ok(managedConfigOf(access, 'A', 'proj-1') === null, 'pi 原生配置判为非托管')
  const decision = await reconcileLegacyManaged(access, 'A', 'proj-1')
  ok(decision.managed === false && decision.legacyHeld === false, '非托管对账不动 legacy')
  ok(log.length === 0, '非托管对账不产生任何连接 / 断开调用')
  await rejectsCode(() => probeManagedServer(access, 'A', 'proj-1'), 'not-managed', '非托管 probe 不走托管路径')
}

{
  const log = []
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A', { projectScope: 'proj-1' })], managers: [], host, log })
  await rejectsCode(
    () => probeManagedServer(access, 'A', undefined),
    'managed-project-required',
    '托管 probe 无调用者项目身份时明确拒绝'
  )
  const result = await probeManagedServer(access, 'A', 'proj-2')
  eq(result.tools, ['toolA', 'toolB'], '跨项目 probe 仍从 host 拿工具表')
  ok(
    log.includes('host.listToolsWithMeta:A:proj-2') && !log.includes('host.listToolsWithMeta:A:proj-1'),
    'probe 传真实 caller 身份（proj-2），不拿 config.projectScope（proj-1）冒充'
  )
}

{
  const log = []
  const legacy = createFakeLegacyManager(['A'], log)
  const host = createFakeAppHost(log)
  const access = createAccess({ servers: [managedConfig('A')], managers: [legacy], host, log })
  const result = await probeManagedServer(access, 'A', 'proj-1')
  eq(result.tools, ['toolA', 'toolB'], '登记 probe 从 host 单例拿工具表')
  ok(log.includes('legacy.disconnect:A') && !log.some((line) => line.startsWith('legacy.listToolsCached')), '登记 probe 不经旧 client 连接')
}

await rm(root, { recursive: true, force: true })
console.log(`\n${checks} 项通过（mcp-app-settings-boundary）`)
}

console.log('\n=====mcp-app-host =====')
await isolated(hostSuite)
console.log('\n=====mcp-app-proxy =====')
await isolated(proxySuite)
console.log('\n=====mcp-approval-parity =====')
await isolated(approvalParitySuite)
console.log('\n=====mcp-app-settings-boundary =====')
await isolated(settingsBoundarySuite)

process.exit(0)
