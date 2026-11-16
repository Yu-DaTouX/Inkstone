import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-computer-use-'))
const originalEnv = { ...process.env }
let checks = 0
const ok = (condition, message, detail) => {
  assert.ok(condition, `${message}${detail === undefined ? '' : `: ${detail}`}`)
  checks++
}

const built = await build({
  entryPoints: ['src/main/computer-use.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  logLevel: 'silent'
})

try {
  const file = join(root, 'mcp-servers.json')
  process.env.YAN_MCP_SERVERS_FILE = file
  process.env.YAN_DATA_DIR = join(root, 'data')
  process.env.YAN_PI_DIR = join(root, 'pi')
  const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
  const { refreshComputerUseEntry, disableComputerUse, computerUseStatus, windowsMcpConfigPath, COMPUTER_USE_SERVER_ID, COMPUTER_USE_TOOLS } = mod
  const configArg = (args) => args[args.indexOf('--config') + 1]
  const read = async () => JSON.parse(await readFile(file, 'utf8'))
  const foreign = { id: 'my-own-server', command: 'node', args: ['own.js'], enabled: false }
  const ours = { id: COMPUTER_USE_SERVER_ID, command: 'uvx', args: ['stale'], enabled: false }
  await writeFile(file, JSON.stringify([foreign, ours], null, 2), 'utf8')

  {
    const updated = await refreshComputerUseEntry()
    ok(updated === true, '把过期的 windows-mcp 启动参数改写成当前版本')
    const servers = await read()
    const mine = servers.find((server) => server.id === COMPUTER_USE_SERVER_ID)
    ok(Array.isArray(mine.args) && mine.args.includes('windows-mcp==0.8.9') && mine.args.includes('3.14'), '固定到明确版本的 windows-mcp', JSON.stringify(mine.args))
    ok(mine.args.includes('--tools') && mine.args.includes(COMPUTER_USE_TOOLS.join(',')), '工具白名单随条目写入')
    ok(mine.enabled === false, '刷新不改变用户停用状态')
    ok(servers.some((server) => server.id === 'my-own-server'), '刷新不动其他 MCP 服务')
    ok((await refreshComputerUseEntry()) === false, '参数已是最新时不重复改写')
    ok(configArg(mine.args) === join(root, 'windows-mcp-approval.toml'), '默认档（危险操作需确认）用砚数据目录里的关倒计时配置', JSON.stringify(mine.args))
    ok((await readFile(join(root, 'windows-mcp-approval.toml'), 'utf8')) === '[control]\nconsent_countdown_seconds = 0\n', '只写 consent_countdown_seconds = 0，其余保持上游默认')
    ok((await readFile(join(root, 'windows-mcp-auto.toml'), 'utf8')) === '', '全部自动批准档的配置为空，全是上游默认')
    ok(windowsMcpConfigPath('danger') === windowsMcpConfigPath(undefined) && windowsMcpConfigPath('danger') !== windowsMcpConfigPath('all'), '档位判定与 confirmMcpCall 一致：只有 all 不弹审批')

    ok((await refreshComputerUseEntry('all')) === true, '切到全部自动批准时条目参数变化，调用方据此重启 windows-mcp')
    const autoArgs = (await read()).find((server) => server.id === COMPUTER_USE_SERVER_ID).args
    ok(configArg(autoArgs) === join(root, 'windows-mcp-auto.toml'), '全部自动批准档指向默认配置（保留 10 秒确认）', JSON.stringify(autoArgs))
    ok((await refreshComputerUseEntry('all')) === false, '同档位不重复改写')
    ok((await refreshComputerUseEntry('danger')) === true, '切回需确认档再次改写')
    await writeFile(join(root, 'windows-mcp-approval.toml'), 'tampered', 'utf8')
    ok((await refreshComputerUseEntry('danger')) === false && (await readFile(join(root, 'windows-mcp-approval.toml'), 'utf8')).startsWith('[control]'), '配置文件被改动时刷新会恢复内容')
  }

  {
    const status = await computerUseStatus()
    ok(status.enabled === false, '停用的条目不算已启用')
    ok(status.supported === (process.platform === 'win32'), '平台支持状态按当前平台报告')
  }

  {
    const result = await disableComputerUse()
    ok(result.ok, '停用电脑操作成功', result.error)
    const servers = await read()
    ok(!servers.some((server) => server.id === COMPUTER_USE_SERVER_ID), '停用移除砚自己的条目')
    ok(servers.some((server) => server.id === 'my-own-server'), '停用不动其他 MCP 服务')
  }

  {
    await writeFile(file, JSON.stringify({ servers: [{ id: COMPUTER_USE_SERVER_ID, command: 'uvx', args: ['stale'] }, foreign] }, null, 2), 'utf8')
    ok((await refreshComputerUseEntry()) === true, '对象形式的配置也能刷新')
    const document = await read()
    ok(Array.isArray(document.servers) && document.servers.length === 2, '对象形式保留结构与其他服务')
  }

  console.log(`computer-use-entry: ${checks} assertions passed (temp MCP file, no Process spawn)`)
} finally {
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name]
  Object.assign(process.env, originalEnv)
  await rm(root, { recursive: true, force: true })
}
