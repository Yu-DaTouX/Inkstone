import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'yan-p2-fixes-'))
const home = join(root, 'home')
mkdirSync(home)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.YAN_DATA_DIR = join(home, 'yan')
process.env.YAN_DIR = join(home, 'yan')
process.env.PI_CODING_AGENT_DIR = join(home, 'agent')

const electronStub = join(root, 'electron-stub.mjs')
writeFileSync(electronStub, "export const safeStorage = { isEncryptionAvailable: () => false }; export const app = {}; export const shell = {}; export const dialog = {};")

async function bundle(entry, name) {
  const outfile = join(root, `${name}.mjs`)
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', alias: { electron: electronStub }, banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } })
  return import(pathToFileURL(outfile).href)
}

try {
  const { SessionItemProjector } = await bundle('src/main/session-items/projector.ts', 'projector')
  const items = new SessionItemProjector()
  items.appendMessage({
    id: 'b1', role: 'bash', text: 'ls', bash: { command: 'ls', exitCode: null, cancelled: false },
    toolCalls: [{ id: 'b1', name: 'bash', args: { command: 'ls' }, status: 'running', output: '', startedAt: 1 }], timestamp: 1
  })
  items.settleBash('b1', { bash: { command: 'ls', exitCode: 0, cancelled: false } }, { status: 'ok', output: 'done', endedAt: 2 })
  const [settled] = items.uiMessages()
  assert.equal(settled.bash.exitCode, 0)
  assert.equal(settled.toolCalls[0].status, 'ok')
  assert.equal(settled.toolCalls[0].output, 'done')
  console.log('✓ `!命令` 结束后内存里的消息也更新')

  const { RemoteDeviceStore } = await bundle('src/main/remote-devices.ts', 'devices')
  const devicesDir = join(root, 'devices')
  mkdirSync(devicesDir)
  writeFileSync(join(devicesDir, 'remote-devices.json'), '{broken')
  const devices = new RemoteDeviceStore(devicesDir)
  for (let i = 0; i < 3; i += 1) await devices.list().then(() => assert.fail('损坏的设备表不该读成功'), (error) => assert.ok(!/不该读成功/.test(error.message)))
  assert.equal(readdirSync(devicesDir).filter((name) => name.includes('.corrupt-')).length, 1)
  console.log('✓ 设备表损坏时只留一份备份')

  const { RelayBridgeStore } = await bundle('src/main/relay-bridge/store.ts', 'relay-store')
  const relayDir = join(root, 'relay')
  mkdirSync(relayDir)
  writeFileSync(join(relayDir, 'relay-bridge.json'), '{broken')
  const relay = new RelayBridgeStore(relayDir)
  for (let i = 0; i < 3; i += 1) await relay.list().then(() => assert.fail('损坏的中继存储不该读成功'), (error) => assert.ok(!/不该读成功/.test(error.message)))
  assert.equal(readdirSync(relayDir).filter((name) => name.endsWith('.corrupt')).length, 1)
  console.log('✓ 中继存储损坏时只留一份备份')

  const { YAN_DIR } = await bundle('src/main/paths.ts', 'paths')
  const { PeerClient } = await bundle('src/main/peer-client.ts', 'peer-client')
  mkdirSync(YAN_DIR, { recursive: true })
  const peersFile = join(YAN_DIR, 'peers.json')
  mkdirSync(peersFile)
  const peerClient = new PeerClient()
  await peerClient.status().then(() => assert.fail('读取出错不该当成空表'), (error) => assert.notEqual(error.code, 'ERR_ASSERTION'))
  rmSync(peersFile, { recursive: true })
  const stored = { version: 1, peers: [{ id: 'p1', computer: 'pc', address: 'http://x', token: 't', pairedAt: 1 }] }
  writeFileSync(peersFile, JSON.stringify(stored))
  assert.equal((await peerClient.status()).peers.length, 1)
  console.log('✓ peers.json 读取出错时不当成空表，恢复后能读到原配对')
  writeFileSync(peersFile, '{broken')
  assert.equal((await new PeerClient().status()).peers.length, 0)
  assert.equal(readdirSync(YAN_DIR).filter((name) => name.startsWith('peers.json.') && name.endsWith('.corrupt')).length, 1)
  console.log('✓ peers.json 真正损坏时留备份后按空表启动')

  const { createDataBackup } = await bundle('src/main/data-backup.ts', 'data-backup')
  const sessions = join(root, 'data-sessions')
  const yan = join(root, 'data-yan')
  const target = join(root, 'backup-target')
  mkdirSync(sessions)
  mkdirSync(yan)
  mkdirSync(target)
  writeFileSync(join(sessions, 'a.jsonl'), '{}\n')
  writeFileSync(join(yan, 'b.json'), '{}\n')
  const made = await createDataBackup(target, sessions, yan)
  assert.ok(made)
  const madeCount = readdirSync(target).length
  const liveTimer = setInterval(() => {
    try {
      writeFileSync(join(sessions, 'a.jsonl'), `${Math.random()}\n`)
    } catch {
    }
  }, 0)
  let failed = false
  for (let i = 0; i < 40 && !failed; i += 1) {
    await new Promise((done) => setTimeout(done, 2))
    await createDataBackup(target, sessions, yan).then(() => undefined, () => { failed = true })
  }
  clearInterval(liveTimer)
  if (failed) {
    const left = readdirSync(target).filter((name) => !existsSync(join(target, name, 'manifest.json')) && !readdirSync(join(target, name)).some((item) => item.endsWith('.json')))
    assert.equal(left.length, 0)
    console.log('✓ 备份失败时不留半成品')
  } else {
    console.log(`- 备份竞争未触发（已有 ${madeCount} 份），跳过半成品断言`)
  }

  const { hasGitCommit } = await bundle('src/main/subagent-isolation.ts', 'isolation')
  const repo = join(root, 'empty-repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  assert.equal(await hasGitCommit(repo), false)
  execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo })
  assert.equal(await hasGitCommit(repo), true)
  console.log('✓ 能判断仓库有没有提交')

  const question = await import(pathToFileURL(resolve('resources/pi-extensions/question.js')).href)
  const hooks = () => {
    const handlers = {}
    question.default({ on: (name, fn) => { handlers[name] = fn }, registerTool: () => undefined })
    return handlers
  }
  const first = hooks()
  globalThis[Symbol.for('yan.question.secretStore')].hold({ YAN_SECRET_P2: 'hunter2-value' })
  const reloaded = hooks()
  const masked = reloaded.tool_result({ content: [{ type: 'text', text: 'x hunter2-value y' }] })
  assert.ok(masked && !JSON.stringify(masked).includes('hunter2-value'))
  assert.ok(first)
  reloaded.session_start({ reason: 'new' })
  assert.equal(process.env.YAN_SECRET_P2, undefined)
  console.log('✓ 扩展重载后遮蔽名单仍在，换会话时能清掉密文变量')

  const source = (file) => readFileSync(file, 'utf8')
  const agent = source('src/main/agent.ts')
  assert.match(agent, /isCompacting: false, pendingMessageCount: 0 \}/)
  assert.match(agent, /const terminal = this\.turn\.terminal[\s\S]{0,240}void this\.persistTurnTiming\(\)\s+this\.turn\.terminal = terminal/)
  assert.equal((agent.match(/this\.queue\.reset\(true\)\s+this\.queue\.clearSaved\(\)/g) ?? []).length, 1)
  assert.match(source('src/main/queue-coordinator.ts'), /async clearForStop\(\)[\s\S]{0,600}this\.reset\(true\)\s+this\.clearSaved\(\)/)
  const main = source('src/main/index.ts')
  assert.match(main, /'data-root-writer', error\); dialog\.showErrorBox/)
  assert.ok(main.includes('registerAppUpdate(ipc, () => quitReasons(quitActivity()).length > 0)'))
  assert.match(main, /yan:revealPath[\s\S]{0,160}\[\\\\\/\]\{2\}/)
  console.log('✓ 停止结果、崩溃后的忙状态、排队文件、启动失败提示、安装前检查和 UNC 拦截都已接上')
} finally {
  rmSync(root, { recursive: true, force: true })
}
