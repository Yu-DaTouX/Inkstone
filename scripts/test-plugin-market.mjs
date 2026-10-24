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
  await build({ entryPoints: ['src/main/minecraft-plugin.ts'], outfile: 'out/test/minecraft-plugin.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const mc = await import(pathToFileURL('out/test/minecraft-plugin.mjs').href)
  const mcRoot = await mkdtemp(join(tmpdir(), 'inkstone-mc-plugin-'))
  try {
    const source = join(mcRoot, 'source')
    const files = {
      'package.json': '{}',
      'mcp/server.ts': 'server',
      'skills/inkstone-fabric-dev/SKILL.md': 'skill',
      'templates/fabric/a.txt': 't',
      'src/core/dev/runner.ts': 'r',
      'companion-mod/build/libs/inkstone-companion-0.1.0.jar': 'jar',
      'companion-mod/build/classes/A.class': 'class',
      'companion-mod/.gradle/cache.bin': 'cache',
      'companion-mod/mc26/build/libs/inkstone-companion-mc26-0.1.0.jar': 'jar26',
      'companion-mod/mc26/run/options.txt': 'run',
      'companion-mod/core/src/Main.java': 'java',
      'node_modules/x/index.js': 'nm'
    }
    for (const [name, body] of Object.entries(files)) {
      await mkdir(join(source, name, '..'), { recursive: true })
      await writeFile(join(source, name), body)
    }
    const agentDir = join(mcRoot, 'agent')
    const paths = { source, pluginDir: join(mcRoot, 'yan', 'plugins', 'inkstone-minecraft'), skillsDir: join(mcRoot, 'yan', 'skills'), agentDir, runtime: 'C:/Inkstone/Inkstone.exe' }
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ keep: 1, mcpServers: { codegraph: { command: 'codegraph' } } }))
    const before = await mc.minecraftPluginStatus(paths)
    ok(before.bundled && !before.installed && !before.configured && !before.conflict, 'Minecraft 插件：安装前只有随包文件')
    const installed = await mc.installMinecraftPlugin(paths)
    const doc = JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8'))
    const entry = doc.mcpServers['inkstone-minecraft']
    ok(installed.ok && installed.status.installed && installed.status.configured && installed.status.skill, 'Minecraft 插件：安装后已登记 MCP 并装好技能')
    ok(entry.command === paths.runtime && entry.env.ELECTRON_RUN_AS_NODE === '1' && entry.args.at(-1) === join(paths.pluginDir, 'mcp', 'server.ts'), 'Minecraft 插件：用砚自带运行时启动复制后的服务')
    ok(doc.keep === 1 && doc.mcpServers.codegraph.command === 'codegraph', 'Minecraft 插件：保留 mcp.json 其他内容')
    const has = (name) => readFile(join(paths.pluginDir, name), 'utf8').then(() => true, () => false)
    ok(await has('companion-mod/build/libs/inkstone-companion-0.1.0.jar') && await has('companion-mod/mc26/build/libs/inkstone-companion-mc26-0.1.0.jar') && await has('companion-mod/core/src/Main.java'), 'Minecraft 插件：带上伴随 mod 源码与预编译 jar')
    ok(!(await has('companion-mod/build/classes/A.class')) && !(await has('companion-mod/.gradle/cache.bin')) && !(await has('companion-mod/mc26/run/options.txt')) && !(await has('node_modules/x/index.js')), 'Minecraft 插件：不复制构建中间产物、运行目录与依赖')
    doc.mcpServers['inkstone-minecraft'].enabled = false
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify(doc))
    const updated = await mc.installMinecraftPlugin(paths)
    ok(updated.ok && !updated.status.configured && JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8')).mcpServers['inkstone-minecraft'].enabled === false, 'Minecraft 插件：更新时保留用户的停用设置')
    ok(await mc.refreshMinecraftPlugin(paths) === 'current', '\u542f\u52a8\u68c0\u67e5\uff1a\u5df2\u662f\u968f\u5305\u7248\u672c\u65f6\u4e0d\u52a8')
    await writeFile(join(source, 'mcp', 'server.ts'), 'export const changed = 1\n')
    const refreshed = await mc.refreshMinecraftPlugin(paths)
    const afterRefresh = JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8')).mcpServers['inkstone-minecraft']
    ok(refreshed === 'updated' && (await readFile(join(paths.pluginDir, 'mcp', 'server.ts'), 'utf8')).includes('changed') && afterRefresh.enabled === false, '\u542f\u52a8\u68c0\u67e5\uff1a\u968f\u5305\u6587\u4ef6\u53d8\u5316\u65f6\u81ea\u52a8\u66f4\u65b0\u5e76\u4fdd\u7559\u505c\u7528')
    ok(await mc.refreshMinecraftPlugin({ ...paths, runtime: 'D:/New/Inkstone.exe' }) === 'updated' && JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8')).mcpServers['inkstone-minecraft'].command === 'D:/New/Inkstone.exe', '\u542f\u52a8\u68c0\u67e5\uff1a\u781a\u7684\u4f4d\u7f6e\u53d8\u5316\u65f6\u6539\u5199\u8fd0\u884c\u65f6\u8def\u5f84')
    const removed = await mc.removeMinecraftPlugin(paths)
    const afterDoc = JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8'))
    ok(removed.ok && !removed.status.installed && !removed.status.skill && !afterDoc.mcpServers['inkstone-minecraft'] && afterDoc.mcpServers.codegraph, 'Minecraft 插件：移除只删自己的登记、目录与技能')
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'inkstone-minecraft': { command: 'node', args: ['other/server.ts'] } } }))
    const conflict = await mc.installMinecraftPlugin(paths)
    ok(!conflict.ok && conflict.status.conflict && !conflict.status.installed, 'Minecraft 插件：同名服务不是砚装的时拒绝覆盖')
    await mc.removeMinecraftPlugin(paths)
    ok(JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8')).mcpServers['inkstone-minecraft'].args[0] === 'other/server.ts', 'Minecraft 插件：移除不动别人的同名服务')
    await writeFile(join(agentDir, 'mcp.json'), '{bad')
    const broken = await mc.installMinecraftPlugin(paths)
    ok(!broken.ok && (await readFile(join(agentDir, 'mcp.json'), 'utf8')) === '{bad', 'Minecraft 插件：坏 JSON 拒绝改写')
    ok(await mc.refreshMinecraftPlugin(paths) === 'skipped', '\u542f\u52a8\u68c0\u67e5\uff1a\u6ca1\u5b89\u88c5\u6216\u767b\u8bb0\u5df2\u5220\u65f6\u4e0d\u81ea\u52a8\u88c5\u56de')
    const missing = await mc.installMinecraftPlugin({ ...paths, source: null })
    ok(!missing.ok && /随包插件文件缺失/.test(missing.error), 'Minecraft 插件：没有随包文件时说明原因')
  } finally { await rm(mcRoot, { recursive: true, force: true }) }
  await build({ entryPoints: ['src/shared/plugin-catalog.ts'], outfile: 'out/test/plugin-catalog-shared.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const catalog = await import(pathToFileURL('out/test/plugin-catalog-shared.mjs').href)
  ok(catalog.BUILTIN_PLUGIN_CATALOG.plugins.some((entry) => entry.id === 'inkstone-minecraft' && entry.kind === 'mcp'), '内置插件目录包含 Minecraft 插件')
  ok(catalog.normalizePluginCatalog({ schema: 1, plugins: [{ id: 'other-mcp', kind: 'mcp', name: 'x', url: 'https://example.com', text: { 'zh-CN': { desc: 'x' } } }] }).plugins.length === 0, '远程目录不能加入没有代码支撑的 MCP 插件')
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
