import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

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
  platform: 'neutral',
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
  ok(strict.length === 1 && strict[0] === 'model', '缺省最严：缺 _meta.ui 只给模型')
  ok(host.mcpAppVisibilityOf({ ui: { visibility: 'app' } })[0] === 'model', '缺省最严：visibility 不是数组时退回只给模型')
  ok(host.mcpAppVisibilityOf({ ui: { visibility: [] } })[0] === 'model', '缺省最严：空 visibility 退回只给模型')
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
    ok(noVisibility?.modelVisible === true && noVisibility?.appVisible === false, 'stdio：缺 visibility 按最严只给模型')

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
    ok(tools.find((tool) => tool.name === 'no_visibility_note')?.appVisible === false, 'HTTP：缺 visibility 按最严只给模型')

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
