import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SERVER = `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const end = buffer.indexOf('\\n')
    if (end < 0) break
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (!line) continue
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (request.id === undefined || request.id === null) continue
    let result
    if (request.method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture-mcp', version: '1.0.0' } }
    } else if (request.method === 'tools/list') {
      result = { tools: [{ name: 'fixture_echo', description: 'fixture', inputSchema: { type: 'object' } }] }
    } else {
      result = {}
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`

export async function runMcpPackageTests(ok, mod) {
  const root = await mkdtemp(join(tmpdir(), 'yan-mcp-package-'))
  const packageRoot = join(root, 'package')
  try {
    await mkdir(join(packageRoot, 'bin'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/mcp-server',
      version: '1.2.3',
      bin: { 'fixture-mcp': 'bin/server.mjs' }
    }), 'utf8')
    await writeFile(join(packageRoot, 'bin', 'server.mjs'), SERVER, 'utf8')

    const resolved = await mod.resolveMcpPackage({
      packageRoot,
      candidateId: 'mcp-registry:fixture/server@1.2.3',
      title: 'Fixture MCP',
      expectedName: '@fixture/mcp-server',
      expectedVersion: '1.2.3'
    })
    ok(resolved.config.transport === 'stdio', 'MCP 包：解析成 stdio 配置')
    ok(resolved.config.command === process.execPath, 'MCP 包：只使用可信 Node 运行时')
    ok(resolved.config.args?.length === 1 && /bin[\\/]server\.mjs$/.test(resolved.config.args[0]), 'MCP 包：只接受包内 bin 入口')

    const smoke = await mod.smokeMcpPackage({ config: resolved.config, timeoutMs: 5_000 })
    ok(smoke.ok, 'MCP 包：真实子进程完成官方 SDK 握手与 tools/list', smoke.problems.join('; '))
    ok(smoke.tools.some((tool) => tool.name === 'fixture_echo'), 'MCP 包：冒烟带回真实工具描述')

    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/mcp-server',
      version: '1.2.3',
      bin: { cli: 'bin/cli.mjs', server: 'bin/server.mjs' }
    }), 'utf8')
    let ambiguous = false
    try {
      await mod.resolveMcpPackage({
        packageRoot,
        candidateId: 'mcp-registry:fixture/server@1.2.3',
        title: 'Fixture MCP',
        expectedName: '@fixture/mcp-server',
        expectedVersion: '1.2.3'
      })
    } catch {
      ambiguous = true
    }
    ok(ambiguous, 'MCP 包：多个未命名 bin 入口时拒绝猜测')

    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/mcp-server',
      version: '1.2.3',
      main: 'bin/server.mjs'
    }), 'utf8')
    let rejected = false
    try {
      await mod.resolveMcpPackage({
        packageRoot,
        candidateId: 'mcp-registry:fixture/server@1.2.3',
        title: 'Fixture MCP',
        expectedName: '@fixture/mcp-server',
        expectedVersion: '1.2.3'
      })
    } catch {
      rejected = true
    }
    ok(rejected, 'MCP 包：没有明确 bin 时拒绝猜测 main 入口')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
