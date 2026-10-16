import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runPluginMarketTests(ok) {
  await build({ entryPoints: ['src/main/plugin-market.ts'], outfile: 'out/test/plugin-market.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { searchPiPackages, exportHermesPlugin, HERMES_PLUGIN_FILES } = await import(pathToFileURL('out/test/plugin-market.mjs').href)
  let requested
  const response = await searchPiPackages('browser', 24, async url => {
    requested = url
    return Response.json({ total: 45, objects: [
      { package: { name: '@fixture/pi-browser', keywords: ['pi-package'], version: '1.2.3', publisher: { username: 'fixture' }, description: 'Browser tools',
        links: { repository: 'git+https://github.com/fixture/pi-browser.git', homepage: 'javascript:alert(1)' } } },
      { package: { name: 'pi-unsafe-link', keywords: ['pi-package'], version: '0.1.0', links: { homepage: 'http://example.com' } } },
      { package: { name: 'unrelated', keywords: [] } },
      { package: { name: 'invalid;command', keywords: ['pi-package'] } }
    ] })
  })
  ok(requested.origin === 'https://registry.npmjs.org' && requested.searchParams.get('text') === 'keywords:pi-package browser' && requested.searchParams.get('from') === '24', '目录查询固定 npm 来源并正确分页')
  ok(response.ok && response.entries.length === 2 && response.entries[0].source === 'npm:@fixture/pi-browser', '只收录有效 pi 包，安装来源不接受元数据命令')
  ok(response.entries[0].npmUrl === 'https://www.npmjs.com/package/@fixture/pi-browser' && response.entries[0].homepage === 'https://github.com/fixture/pi-browser', '原链接：npm 页面与 https 仓库地址')
  ok(response.entries[1].homepage === undefined, '非 https 主页不展示')
  ok(!(await searchPiPackages('', 0, async () => new Response('', { status: 503 }))).ok, '目录失败明确返回错误')
  ok(!(await searchPiPackages('', 0, async () => Response.json({ objects: 'bad', total: 1 }))).ok, '拒绝无效目录格式')
  ok(!(await searchPiPackages('', 0, async () => new Response('x'.repeat(1024 * 1024 + 1)))).ok, '目录响应限制大小')
  const temp = await mkdtemp(join(tmpdir(), 'inkstone-market-'))
  try {
    const source = join(temp, 'source'), destination = join(temp, 'download')
    await mkdir(source); await mkdir(destination)
    for (const name of HERMES_PLUGIN_FILES) await writeFile(join(source, name), 'fixture:' + name)
    const target = await exportHermesPlugin(source, destination)
    ok((await readFile(join(target, 'approvals.py'), 'utf8')) === 'fixture:approvals.py', '导出包含用户批准模块与实际文件')
    let rejected = false
    try { await exportHermesPlugin(source, destination) } catch { rejected = true }
    ok(rejected && (await readFile(join(target, 'plugin.yaml'), 'utf8')) === 'fixture:plugin.yaml', '已有插件目录拒绝覆盖且保留文件')
  } finally { await rm(temp, { recursive: true, force: true }) }
  const { addCodegraphMcp } = await import(pathToFileURL('out/test/plugin-market.mjs').href)
  const agentDir = await mkdtemp(join(tmpdir(), 'inkstone-codegraph-'))
  try {
    const present = async () => true
    const missing = await addCodegraphMcp(agentDir, async () => false)
    ok(!missing.ok && /npm i -g @colbymchenry\/codegraph/.test(missing.error) && !(await readFile(join(agentDir, 'mcp.json'), 'utf8').catch(() => null)), '未装 CLI 时给出安装命令且不写配置')
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ autoEnableCodemode: true, mcpServers: { other: { command: 'x' } } }))
    const added = await addCodegraphMcp(agentDir, present)
    const doc = JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8'))
    ok(added.ok && !added.existed && doc.mcpServers.codegraph.command === 'codegraph' && doc.mcpServers.codegraph.args.join(' ') === 'serve --mcp', '写入 pi 原生 mcp.json 的 codegraph serve --mcp')
    ok(doc.mcpServers.other.command === 'x' && doc.autoEnableCodemode === true, '保留已有服务与其他字段')
    const again = await addCodegraphMcp(agentDir, present)
    ok(again.ok && again.existed, '已有同名服务时不覆盖')
    await writeFile(join(agentDir, 'mcp.json'), '{bad')
    const bad = await addCodegraphMcp(agentDir, present)
    ok(!bad.ok && (await readFile(join(agentDir, 'mcp.json'), 'utf8')) === '{bad', '坏 JSON 拒绝改写')
  } finally { await rm(agentDir, { recursive: true, force: true }) }
  if (process.argv.includes('--live')) {
    const live = await searchPiPackages('browser')
    ok(live.ok && live.entries.length > 0, '真实 npm pi-package 目录可用：' + live.entries.length)
  }
}
if (process.argv[1]?.endsWith('test-plugin-market.mjs')) {
  let passed = 0, failed = 0
  await runPluginMarketTests((value, name) => { console.log((value ? 'PASS ' : 'FAIL ') + name); value ? passed++ : failed++ })
  console.log(`${passed} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
