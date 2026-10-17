#!/usr/bin/env node
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const bundles = []
async function bundle(entry) {
  const outfile = join(tmpdir(), `yan-opencode-${randomUUID()}.mjs`)
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning'
  })
  bundles.push(outfile)
  return import(pathToFileURL(outfile).href)
}

const agentDir = await mkdtemp(join(tmpdir(), 'yan-opencode-agent-'))
const yanDir = join(agentDir, 'yan')
process.env.YAN_PI_DIR = agentDir
process.env.YAN_DATA_DIR = yanDir

const report = { pass: 0, fail: 0 }
function section(name) {
  process.stdout.write(`\n▌${name}\n`)
}
function ok(message) {
  report.pass += 1
  process.stdout.write(`  ✓ ${message}\n`)
}
function fail(message, error) {
  report.fail += 1
  process.stdout.write(`  ✗ ${message}\n    ${error instanceof Error ? error.message : String(error)}\n`)
}
async function check(message, fn) {
  try {
    await fn()
    ok(message)
  } catch (error) {
    fail(message, error)
  }
}

const proxy = await bundle('../src/main/opencode-proxy.ts')
const ipcMod = await bundle('../src/main/ipc/opencode-ipc.ts')

const stateFile = join(yanDir, 'opencode-proxy.json')
const installDir = join(yanDir, 'plugins', 'opencode2api', '1.4.1')
const modelsFile = join(agentDir, 'models.json')
const apiKey = 'yan-test-key'
const port = 18085 + Math.floor(Math.random() * 1000)

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function listen(server, listenPort) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, '127.0.0.1', () => resolve())
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

const seenAuth = []
const server = createServer((req, res) => {
  seenAuth.push(req.headers.authorization ?? '')
  if (req.url !== '/v1/models') {
    res.writeHead(404).end('{}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      data: [
        { id: 'beam-free', context_window: 1048576, max_output: 131072, compat: { supportsReasoningEffort: true } },
        { id: 'glm-5.3-flash-free', metadata: { context_window: 200000, max_output: 32000, reasoning: true } },
        { id: 'big-pickle' }
      ]
    })
  )
})

try {
  section('未安装时的状态')
  const missing = await proxy.openCodeProxyStatus()
  await check('installed=false 且没有报错', () => {
    assert.equal(missing.installed, false)
    assert.equal(missing.running, false)
    assert.equal(missing.version, '')
    assert.deepEqual(missing.models, [])
  })
  await check('start 提示尚未安装', async () => {
    const result = await proxy.startOpenCodeProxy()
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /还没有安装/)
  })
  await check('refresh 提示尚未安装', async () => {
    const result = await proxy.refreshOpenCodeProxy()
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /还没有安装/)
  })

  section('已安装且服务在本机运行')
  await mkdir(installDir, { recursive: true })
  await writeFile(join(installDir, 'opencode2api.exe'), '', 'utf8')
  await writeFile(join(installDir, 'config.json'), '{"listen":"127.0.0.1"}\n', 'utf8')
  await writeJson(stateFile, { version: '1.4.1', port, consolePort: port + 1, apiKey, consolePassword: 'pw', autoStart: false, installedAt: 1 })
  await listen(server, port)
  const status = await proxy.openCodeProxyStatus()
  await check('识别为已安装并复用本机实例', () => {
    assert.equal(status.installed, true)
    assert.equal(status.version, '1.4.1')
    assert.equal(status.running, true)
    assert.equal(status.managed, false)
    assert.equal(status.port, port)
    assert.equal(status.baseUrl, `http://127.0.0.1:${port}/v1`)
    assert.deepEqual(status.models, ['beam-free', 'glm-5.3-flash-free', 'big-pickle'])
  })
  await check('探测时带上本地 Key', () => {
    assert.equal(seenAuth.at(-1), `Bearer ${apiKey}`)
  })
  await check('尚未写入模型列表', () => {
    assert.equal(status.providerLinked, false)
  })

  section('刷新模型写入砚的自定义服务')
  const refreshed = await proxy.refreshOpenCodeProxy()
  await check('刷新成功', () => {
    assert.equal(refreshed.ok, true)
    assert.equal(refreshed.status?.providerLinked, true)
    assert.equal(refreshed.status?.models.length, 3)
  })
  await check('models.json 写入 yan-opencode', async () => {
    const json = JSON.parse(await readFile(modelsFile, 'utf8'))
    const entry = json.providers['yan-opencode']
    assert.equal(entry.baseUrl, `http://127.0.0.1:${port}/v1`)
    assert.equal(entry.apiKey, apiKey)
    assert.equal(entry.api, 'openai-completions')
    assert.deepEqual(
      entry.models.map((model) => model.id),
      ['beam-free', 'glm-5.3-flash-free', 'big-pickle']
    )
    assert.equal(entry.models[1].name, 'GLM 5.3 Flash')
  })
  await check('上游窗口与推理能力写进模型条目', async () => {
    const json = JSON.parse(await readFile(modelsFile, 'utf8'))
    const models = json.providers['yan-opencode'].models
    assert.equal(models[0].contextWindow, 1048576)
    assert.equal(models[0].maxTokens, 131072)
    assert.equal(models[0].reasoning, true)
    assert.equal(models[1].contextWindow, 200000)
    assert.equal(models[1].maxTokens, 32000)
    assert.equal(models[1].reasoning, true)
    assert.equal(models[2].contextWindow, undefined)
    assert.equal(models[2].reasoning, undefined)
  })

  section('随砚启动开关')
  await check('关闭后落盘', async () => {
    const result = await proxy.setOpenCodeProxyAutoStart(false)
    assert.equal(result.ok, true)
    assert.equal(result.status?.autoStart, false)
    const json = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(json.autoStart, false)
  })
  await check('开启后落盘', async () => {
    const result = await proxy.setOpenCodeProxyAutoStart(true)
    assert.equal(result.ok, true)
    assert.equal(result.status?.autoStart, true)
  })
  await check('无状态文件时拒绝写入开关', async () => {
    const before = await readFile(stateFile, 'utf8')
    await rm(stateFile, { force: true })
    const result = await proxy.setOpenCodeProxyAutoStart(false)
    assert.equal(result.ok, false)
    await writeFile(stateFile, before, 'utf8')
  })

  section('服务停掉之后')
  await close(server)
  const stopped = await proxy.openCodeProxyStatus()
  await check('状态回到未运行', () => {
    assert.equal(stopped.installed, true)
    assert.equal(stopped.running, false)
    assert.deepEqual(stopped.models, [])
  })
  await check('刷新给出未运行提示', async () => {
    const result = await proxy.refreshOpenCodeProxy()
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /没有在运行/)
  })
  await check('停止操作幂等', async () => {
    const result = await proxy.stopOpenCodeProxy()
    assert.equal(result.ok, true)
    assert.equal(result.status?.running, false)
  })

  section('IPC 接线')
  const handlers = new Map()
  const registrar = {
    handle: (channel, fn) => handlers.set(channel, fn),
    rawHandle: () => undefined
  }
  const reloads = []
  ipcMod.registerOpenCodeProxyIpc(registrar, { restartAgent: async (reason) => reloads.push(reason) })
  await check('注册全部通道', () => {
    const expected = [
      'yan:opencodeProxy:status',
      'yan:opencodeProxy:install',
      'yan:opencodeProxy:start',
      'yan:opencodeProxy:stop',
      'yan:opencodeProxy:refresh',
      'yan:opencodeProxy:uninstall',
      'yan:opencodeProxy:autoStart'
    ]
    for (const channel of expected) assert.equal(handlers.has(channel), true, `缺少 ${channel}`)
    assert.equal(handlers.size, expected.length)
  })
  await check('status 通道返回当前状态', async () => {
    const result = await handlers.get('yan:opencodeProxy:status')()
    assert.equal(result.installed, true)
    assert.equal(result.version, '1.4.1')
  })
  await check('autoStart 通道只接受布尔真值', async () => {
    await handlers.get('yan:opencodeProxy:autoStart')(false)
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(state.autoStart, false)
    await handlers.get('yan:opencodeProxy:autoStart')(1)
    const next = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(next.autoStart, false)
  })
  await check('stop 通道返回当前状态且不触发刷新', async () => {
    const before = reloads.length
    const result = await handlers.get('yan:opencodeProxy:stop')()
    assert.equal(result.ok, true)
    assert.equal(result.status?.version, '1.4.1')
    assert.equal(reloads.length, before)
  })

  section('卸载')
  const removed = await proxy.uninstallOpenCodeProxy()
  await check('卸载成功', () => {
    assert.equal(removed.ok, true)
    assert.equal(removed.status?.installed, false)
  })
  await check('程序目录与状态文件被删除', () => {
    assert.equal(existsSync(join(yanDir, 'plugins', 'opencode2api')), false)
    assert.equal(existsSync(stateFile), false)
  })
  await check('模型列表里的条目被移除', async () => {
    const json = JSON.parse(await readFile(modelsFile, 'utf8'))
    assert.equal(json.providers['yan-opencode'], undefined)
  })
  await check('卸载后重复卸载仍然成功', async () => {
    const again = await proxy.uninstallOpenCodeProxy()
    assert.equal(again.ok, true)
  })
} finally {
  await close(server).catch(() => undefined)
  await rm(agentDir, { recursive: true, force: true }).catch(() => undefined)
  for (const file of bundles) await rm(file, { force: true }).catch(() => undefined)
}

process.stdout.write(`\n通过 ${report.pass} 项，失败 ${report.fail} 项\n`)
process.exit(report.fail ? 1 : 0)
