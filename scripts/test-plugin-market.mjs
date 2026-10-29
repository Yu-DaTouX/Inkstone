import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, readdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zipArchive(files) {
  const locals = []
  const directory = []
  let offset = 0
  for (const [name, body] of files) {
    const data = Buffer.from(body)
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x0021, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, data)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0x0021, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(offset, 42)
    directory.push(header, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

function pluginFiles() {
  return {
    'package.json': JSON.stringify({ name: 'inkstone-minecraft-plugin', version: '0.1.0' }),
    'mcp/server.ts': 'server',
    'skills/inkstone-fabric-dev/SKILL.md': 'skill',
    'templates/fabric/a.txt': 't',
    'templates/java/write-argfile.ps1': 'native-encoding-helper',
    'src/core/dev/runner.ts': 'r',
    'companion-mod/build/libs/inkstone-companion-0.1.0.jar': 'jar',
    'companion-mod/build/classes/A.class': 'class',
    'companion-mod/.gradle/cache.bin': 'cache',
    'companion-mod/mc26/build/libs/inkstone-companion-mc26-0.1.0.jar': 'jar26',
    'companion-mod/mc26/run/options.txt': 'run',
    'companion-mod/core/src/Main.java': 'java',
    'node_modules/x/index.js': 'nm'
  }
}

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
    const agentDir = join(mcRoot, 'agent')
    const paths = { pluginDir: join(mcRoot, 'yan', 'plugins', 'inkstone-minecraft'), skillsDir: join(mcRoot, 'yan', 'skills'), agentDir, runtime: 'C:/Inkstone/Inkstone.exe', tempDir: join(mcRoot, 'yan', 'tmp') }
    const archive = zipArchive(Object.entries(pluginFiles()))
    const seen = []
    const serve = (body, status = 200, headers = {}) => async (url) => {
      seen.push(url)
      return new Response(body, { status, headers })
    }
    const has = (name) => readFile(join(paths.pluginDir, name), 'utf8').then(() => true, () => false)
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ keep: 1, mcpServers: { codegraph: { command: 'codegraph' } } }))
    const before = await mc.minecraftPluginStatus(paths)
    ok(!before.installed && !before.configured && !before.conflict && !before.skill && before.installedVersion === undefined, 'Minecraft 插件：安装前没有目录、登记、技能与版本')
    const installed = await mc.installMinecraftPlugin(paths, { fetch: serve(archive) })
    const doc = JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8'))
    const entry = doc.mcpServers['inkstone-minecraft']
    ok(seen.length === 1 && seen[0] === 'https://github.com/Yu-DaTouX/inkstone-minecraft-plugin/releases/latest/download/inkstone-minecraft-plugin.zip', 'Minecraft 插件：只从新仓库的稳定地址下载')
    ok(installed.ok && installed.status.installed && installed.status.configured && installed.status.skill, 'Minecraft 插件：下载解压后登记 MCP 并装好技能')
    ok(installed.status.installedVersion === '0.1.0', 'Minecraft 插件：状态带已装版本')
    ok(entry.command === paths.runtime && entry.env.ELECTRON_RUN_AS_NODE === '1' && entry.args.at(-1) === join(paths.pluginDir, 'mcp', 'server.ts'), 'Minecraft 插件：用砚自带运行时启动解压后的服务')
    ok(doc.keep === 1 && doc.mcpServers.codegraph.command === 'codegraph', 'Minecraft 插件：保留 mcp.json 其他内容')
    ok(await has('companion-mod/build/libs/inkstone-companion-0.1.0.jar') && await has('companion-mod/mc26/build/libs/inkstone-companion-mc26-0.1.0.jar') && await has('companion-mod/core/src/Main.java'), 'Minecraft 插件：带上伴随 mod 源码与预编译 jar')
    ok(await has('templates/java/write-argfile.ps1'), 'Minecraft 插件：带上 Windows Java 参数文件编码助手')
    ok(!(await has('companion-mod/build/classes/A.class')) && !(await has('companion-mod/.gradle/cache.bin')) && !(await has('companion-mod/mc26/run/options.txt')) && !(await has('node_modules/x/index.js')), 'Minecraft 插件：不复制构建中间产物、运行目录与依赖')
    ok((await readdir(paths.tempDir)).length === 0, 'Minecraft 插件：装完清理临时目录')
    const latestSeen = []
    const latest = await mc.latestMinecraftPluginVersion(async (url) => {
      latestSeen.push(url)
      return Response.json({ tag_name: 'v0.2.0' })
    })
    ok(latest === '0.2.0' && latestSeen[0] === 'https://api.github.com/repos/Yu-DaTouX/inkstone-minecraft-plugin/releases/latest', 'Minecraft 插件：最新版本取自 GitHub Release 标签')
    ok((await mc.latestMinecraftPluginVersion(async () => { throw new Error('offline') })) === undefined, 'Minecraft 插件：查不到最新版本时不报错')
    ok((await mc.latestMinecraftPluginVersion(async () => new Response('', { status: 403 }))) === undefined, 'Minecraft 插件：GitHub API 拒绝时忽略')
    doc.mcpServers['inkstone-minecraft'].enabled = false
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify(doc))
    const next = zipArchive(Object.entries({ ...pluginFiles(), 'package.json': JSON.stringify({ version: '0.2.0' }), 'mcp/server.ts': 'export const changed = 1\n' }))
    const updated = await mc.installMinecraftPlugin(paths, { fetch: serve(next) })
    ok(updated.ok && updated.status.installedVersion === '0.2.0' && !updated.status.configured, 'Minecraft 插件：更新换掉插件目录并保留停用设置')
    ok((await readFile(join(paths.pluginDir, 'mcp', 'server.ts'), 'utf8')).includes('changed'), 'Minecraft 插件：更新后插件目录是新版本内容')
    const downloads = seen.length
    ok((await mc.refreshMinecraftPlugin(paths)) === 'current', 'Minecraft 插件：启动检查在路径没变时不动')
    ok((await mc.refreshMinecraftPlugin({ ...paths, runtime: 'D:/New/Inkstone.exe' })) === 'updated' && JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8')).mcpServers['inkstone-minecraft'].command === 'D:/New/Inkstone.exe', 'Minecraft 插件：启动检查只在运行时路径变化时改写 mcp.json')
    ok(seen.length === downloads, 'Minecraft 插件：启动检查不联网')
    const failed = await mc.installMinecraftPlugin(paths, { fetch: serve(archive, 404) })
    ok(!failed.ok && /HTTP 404/.test(failed.error) && (await readFile(join(paths.pluginDir, 'mcp', 'server.ts'), 'utf8')).includes('changed'), 'Minecraft 插件：下载失败保留已装版本')
    const huge = await mc.installMinecraftPlugin(paths, { fetch: serve(archive, 200, { 'content-length': String(300 * 1024 * 1024) }) })
    ok(!huge.ok && /200 MB/.test(huge.error) && (await readFile(join(paths.pluginDir, 'package.json'), 'utf8')).includes('0.2.0'), 'Minecraft 插件：超过大小上限时停止且不动已装版本')
    const empty = await mc.installMinecraftPlugin(paths, { fetch: serve(new Uint8Array()) })
    ok(!empty.ok && /空的/.test(empty.error) && (await has('mcp/server.ts')), 'Minecraft 插件：下载内容为空时说明原因')
    const noFiles = await mc.installMinecraftPlugin(paths, { fetch: serve(zipArchive(Object.entries({ 'package.json': '{}', 'README.md': 'x' }))) })
    ok(!noFiles.ok && /没有插件文件/.test(noFiles.error) && (await has('mcp/server.ts')), 'Minecraft 插件：包里没有插件文件时拒绝替换')
    const removed = await mc.removeMinecraftPlugin(paths)
    const afterDoc = JSON.parse(await readFile(join(agentDir, 'mcp.json'), 'utf8'))
    ok(removed.ok && !removed.status.installed && !removed.status.skill && !afterDoc.mcpServers['inkstone-minecraft'] && afterDoc.mcpServers.codegraph, 'Minecraft 插件：移除只删自己的登记、目录与技能')
    ok((await mc.refreshMinecraftPlugin(paths)) === 'skipped', 'Minecraft 插件：没装时启动检查不联网也不装回')
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'inkstone-minecraft': { command: 'node', args: ['other/server.ts'] } } }))
    const conflict = await mc.installMinecraftPlugin(paths, { fetch: serve(archive) })
    ok(!conflict.ok && conflict.status.conflict && !conflict.status.installed, 'Minecraft 插件：同名服务不是砚装的时拒绝覆盖')
    await writeFile(join(agentDir, 'mcp.json'), '{bad')
    const broken = await mc.installMinecraftPlugin(paths, { fetch: serve(archive) })
    ok(!broken.ok && (await readFile(join(agentDir, 'mcp.json'), 'utf8')) === '{bad', 'Minecraft 插件：坏 JSON 拒绝改写')
    await writeFile(join(agentDir, 'mcp.json'), '{}')
    const skillTarget = join(paths.skillsDir, 'inkstone-fabric-dev')
    await mkdir(skillTarget, { recursive: true })
    await writeFile(join(skillTarget, 'SKILL.md'), 'someone else')
    const foreignSkill = await mc.installMinecraftPlugin(paths, { fetch: serve(archive) })
    ok(!foreignSkill.ok && /不是砚装的/.test(foreignSkill.error) && (await readFile(join(skillTarget, 'SKILL.md'), 'utf8')) === 'someone else', 'Minecraft 插件：同名技能不是砚装的时拒绝覆盖')
  } finally { await rm(mcRoot, { recursive: true, force: true }) }
  await build({ entryPoints: ['src/shared/plugin-catalog.ts'], outfile: 'out/test/plugin-catalog-shared.mjs', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const catalog = await import(pathToFileURL('out/test/plugin-catalog-shared.mjs').href)
  ok(catalog.BUILTIN_PLUGIN_CATALOG.plugins.some((entry) => entry.id === 'inkstone-minecraft' && entry.kind === 'mcp'), '内置插件目录包含 Minecraft 插件')
  ok(['desktop-pet', 'comfyui'].every(id => catalog.BUILTIN_PLUGIN_CATALOG.plugins.some(entry => entry.id === id && entry.kind === 'bundled')), '桌宠与 ComfyUI 作为随包可安装插件列出')
  ok(catalog.normalizePluginCatalog({ schema: 1, plugins: [{ id: 'unknown', kind: 'bundled', name: 'x', url: 'https://example.com', text: { 'zh-CN': { desc: 'x' } } }] }).plugins.length === 0, '远程目录不能为未知随包插件增加可执行接入')
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
