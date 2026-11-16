import './lib/test-isolate.mjs'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const mc = await compile('src/main/minecraft-plugin.ts')
  const cli = await compile('src/main/yan-cli.ts')
  const root = await mkdtemp(join(tmpdir(), 'yan-mc-entry-'))
  try {
    const binDir = join(root, 'yan', 'bin')
    const agentDir = join(root, 'agent')
    const pluginDir = join(root, 'yan', 'plugins', 'inkstone-minecraft')
    await mkdir(join(pluginDir, 'mcp'), { recursive: true })
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(pluginDir, 'mcp', 'server.ts'), 'export {}\n')
    const entryPath = cli.nodeLauncherPath(binDir)
    const mcpPath = join(agentDir, 'mcp.json')
    const script = join(pluginDir, 'mcp', 'server.ts')
    const devExe = 'E:/dev/node_modules/electron/dist/electron.exe'
    const installedExe = 'C:/Program Files/Inkstone/Inkstone.exe'
    const pathsFor = (exe) => ({
      pluginDir, skillsDir: join(root, 'yan', 'skills'), agentDir, runtime: entryPath, tempDir: join(root, 'yan', 'tmp'),
      prepareRuntime: () => void cli.ensureNodeLauncher({ execPath: exe, binDir })
    })
    const readDoc = async () => JSON.parse(await readFile(mcpPath, 'utf8'))
    const originalDoc = {
      keep: { nested: [1, 2] },
      mcpServers: {
        codegraph: { command: 'codegraph', args: ['serve'], env: { A: '1' } },
        'inkstone-minecraft': { command: 'E:/pi-desktop/node_modules/electron/dist/electron.exe', args: ['--no-warnings', script], env: { ELECTRON_RUN_AS_NODE: '1' }, enabled: false, timeout: 9 },
        other: { url: 'http://localhost:1/mcp' }
      }
    }
    await writeFile(mcpPath, JSON.stringify(originalDoc, null, 2))

    ok(entryPath === join(binDir, process.platform === 'win32' ? 'yan-node.cmd' : 'yan-node'), '稳定入口在 yan/bin 下，和 yan 启动器同目录')

    cli.ensureNodeLauncher({ execPath: devExe, binDir })
    const shimText = readFileSync(entryPath, 'utf8')
    ok(shimText.includes(devExe) && shimText.includes('ELECTRON_RUN_AS_NODE') && shimText.includes('%*'), '稳定入口转到当前实例并以纯 Node 模式运行')
    const mtime = statSync(entryPath).mtimeMs
    await new Promise((done) => setTimeout(done, 30))
    cli.ensureNodeLauncher({ execPath: devExe, binDir })
    ok(statSync(entryPath).mtimeMs === mtime, '当前实例没变时不重写入口')
    rmSync(entryPath)

    const first = await mc.refreshMinecraftPlugin(pathsFor(devExe))
    const migrated = await readDoc()
    ok(first === 'updated' && migrated.mcpServers['inkstone-minecraft'].command === entryPath, '旧版直接写的 exe 路径只改写一次，改成稳定入口', JSON.stringify(first))
    ok(existsSync(entryPath) && readFileSync(entryPath, 'utf8').includes(devExe), '改写同时修复缺失的入口文件')
    const expected = structuredClone(originalDoc)
    expected.mcpServers['inkstone-minecraft'].command = entryPath
    ok(JSON.stringify(migrated) === JSON.stringify(expected), '只改 command，其他服务与其他字段（含 enabled、timeout、env、顶层键）原样保留')

    const stable = readFileSync(mcpPath, 'utf8')
    const stableMtime = statSync(mcpPath).mtimeMs
    for (const exe of [installedExe, devExe, installedExe, devExe]) {
      const result = await mc.refreshMinecraftPlugin(pathsFor(exe))
      ok(result === 'current', `开发版与安装版交替启动（${exe.includes('dev') ? '开发版' : '安装版'}）不改写 mcp.json`, JSON.stringify(result))
      ok(readFileSync(entryPath, 'utf8').includes(exe), '入口随当前实例切换')
    }
    ok(readFileSync(mcpPath, 'utf8') === stable && statSync(mcpPath).mtimeMs === stableMtime, '交替启动后 mcp.json 内容与修改时间都没变')

    const slashed = { ...originalDoc, mcpServers: { ...migrated.mcpServers, 'inkstone-minecraft': { ...migrated.mcpServers['inkstone-minecraft'], command: entryPath.replace(/\\/g, '/') } } }
    await writeFile(mcpPath, JSON.stringify(slashed))
    ok((await mc.refreshMinecraftPlugin(pathsFor(devExe))) === 'current' || process.platform !== 'win32', 'Windows 上斜杠写法不同的同一入口不重复改写')

    await writeFile(mcpPath, JSON.stringify(migrated))
    rmSync(entryPath)
    ok((await mc.refreshMinecraftPlugin(pathsFor(installedExe))) === 'current' && readFileSync(entryPath, 'utf8').includes(installedExe), '入口文件被删后下次启动重建，配置不用改')

    const broken = structuredClone(migrated)
    broken.mcpServers['inkstone-minecraft'].command = 'D:/Gone/Inkstone.exe'
    await writeFile(mcpPath, JSON.stringify(broken))
    ok((await mc.refreshMinecraftPlugin(pathsFor(installedExe))) === 'updated' && (await readDoc()).mcpServers['inkstone-minecraft'].command === entryPath, '配置里是失效的旧路径时修复为稳定入口')
    ok((await mc.refreshMinecraftPlugin(pathsFor(installedExe))) === 'current', '修复后不再改写')

    const missing = await mc.refreshMinecraftPlugin({ ...pathsFor(devExe), pluginDir: join(root, 'missing') })
    ok(missing === 'skipped', '没装插件时不创建入口也不改配置')

    const failing = await mc.refreshMinecraftPlugin({ ...pathsFor(devExe), prepareRuntime: () => { throw new Error('bin 不可写') } })
    ok(typeof failing === 'object' && /bin 不可写/.test(failing.error), '入口生成失败时返回错误而不是改配置')

    const spawnSync = createRequire(import.meta.url)('cross-spawn').sync
    const probe = join(root, 'probe dir', 'probe.mjs')
    await mkdir(join(root, 'probe dir'), { recursive: true })
    writeFileSync(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    cli.ensureNodeLauncher({ execPath: process.execPath, binDir })
    const ran = spawnSync(entryPath, ['--no-warnings', probe, 'a b'], { encoding: 'utf8' })
    ok(ran.status === 0 && ran.stdout === JSON.stringify(['a b']), '入口能被 MCP 客户端按「命令加参数」直接启动，参数含空格也原样传到', `${ran.status} ${ran.stdout} ${ran.stderr}`)

  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
