import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const lan = Object.values(networkInterfaces()).flat().find((item) => item && item.family === 'IPv4' && !item.internal)?.address
if (!lan) {
  console.log('跳过：本机没有非回环 IPv4 地址，无法验证隧道与身份行为')
  process.exit(0)
}

const root = await mkdtemp(join(tmpdir(), 'inkstone-remote-identity-'))
process.env.YAN_DATA_DIR = join(root, 'host-data')

const requireBanner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'js',
      contents: [
        'export const app = { getPath: () => process.cwd(), getVersion: () => "0.0.0", isPackaged: false, on() {} }',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (v) => Buffer.from(String(v)), decryptString: (v) => Buffer.from(v).toString() }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
        'export const shell = { openPath: async () => "" }',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
        'export const ipcMain = { handle: () => undefined }',
        'export const BrowserWindow = class {}'
      ].join('\n')
    }))
  }
}

async function bundle(contents, name, options = {}) {
  const outfile = join(root, `${name}.mjs`)
  await build({
    stdin: { contents, resolveDir: options.resolveDir ?? process.cwd(), loader: 'ts' },
    outfile,
    bundle: true,
    platform: options.platform ?? 'node',
    format: 'esm',
    logLevel: 'silent',
    mainFields: options.mainFields,
    banner: options.banner,
    plugins: options.plugins ?? [electronStub]
  })
  return import(pathToFileURL(outfile).href)
}

const D = await bundle(`export { RemoteAccess } from './src/main/remote-access'`, 'desk', { banner: requireBanner })
const C = await bundle(`export * from './src/main/relay-bridge/crypto'`, 'crypto', { banner: requireBanner })
const Mobile = await bundle(
  `export * from './src/api/relay'; export * as Client from './src/api/client'; export { pairingPrefillFor, parsePairingLink } from './src/pairLink'`,
  'mobile',
  { resolveDir: join(process.cwd(), 'mobile'), platform: 'neutral', mainFields: ['module', 'main'], plugins: [] }
)

let failures = 0
let checks = 0
async function check(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`✔ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`✖ ${name}\n  ${error?.stack ?? error}`)
  }
}

const dataDir = await mkdtemp(join(tmpdir(), 'inkstone-remote-identity-data-'))
const actions = []
const handlers = {
  async snapshot() {
    return { sessions: [{ id: 's1' }] }
  },
  async history(sessionId) {
    return { ok: true, data: { sessionId, messages: [] } }
  },
  async command(command) {
    actions.push(command.action)
    return { ok: true, data: { action: command.action } }
  }
}
const access = new D.RemoteAccess(dataDir, handlers, () => undefined)
await access.apply({ enabled: true, bind: lan, port: 0 })
const started = await access.status()
assert.ok(started.running, started.error ?? 'remote server did not start')
const base = `http://${lan}:${started.port}`
const tunnelUrl = `ws://${lan}:${started.port}/remote/v1/tunnel`

async function inviteNow() {
  const response = await fetch(`${base}/remote/v1/tunnel/invite`)
  return response.json()
}

try {
  await check('手输配对先核对电脑身份，指纹由本地用将信任的公钥算出', async () => {
    const identity = await access.hostIdentity()
    assert.match(identity, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    const { code } = access.startPairing()
    let seen = null
    const connection = await Mobile.Client.pair(base, code, '核对身份的手机', async (shown) => {
      seen = shown
      return true
    })
    assert.ok(seen, '必须要求确认电脑身份')
    assert.equal(seen.fingerprint, identity)
    const info = await new Mobile.Client.RemoteClient(connection).info()
    assert.ok(info.capabilities.includes('sessions'))
  })

  await check('手输配对不传身份确认回调会直接拒绝', async () => {
    const { code } = access.startPairing()
    await assert.rejects(() => Mobile.Client.pair(base, code, '没确认的手机'), /核对|确认|confirm/)
    access.cancelPairing()
  })

  await check('拒绝核对身份就不会配对', async () => {
    const before = (await access.status()).devices.length
    const { code } = access.startPairing()
    await assert.rejects(() => Mobile.Client.pair(base, code, '拒绝核对', async () => false), /身份|identity/)
    assert.equal((await access.status()).devices.length, before)
    access.cancelPairing()
  })

  await check('中间人替换公钥但保留真实指纹时必须拒绝', async () => {
    const realFingerprint = await access.hostIdentity()
    const attacker = await C.generateKeyPair()
    const attackerKey = C.toB64u(attacker.raw)
    const forged = createServer((req, res) => {
      if (req.url?.startsWith('/remote/v1/tunnel/invite')) {
        const body = JSON.stringify({ ok: true, hostKey: attackerKey, code: 'forged-code', hostFingerprint: realFingerprint, computer: { name: '冒充的电脑' } })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((resolve) => forged.listen(0, '127.0.0.1', resolve))
    const forgedBase = `http://127.0.0.1:${forged.address().port}`
    try {
      const preflight = await Mobile.Client.manualPairInvite(forgedBase)
      assert.ok('error' in preflight, '指纹与公钥不一致时不能给出可信任身份')
      assert.equal(preflight.error.code, 'host_identity_mismatch')
      await assert.rejects(() => Mobile.Client.pair(forgedBase, '123456', '手机', async () => true), /不一致|does not match|冒充/)
    } finally {
      await new Promise((resolve) => forged.close(resolve))
    }
  })

  await check('电脑只给公钥不给指纹时，展示的是这把公钥本地算出的指纹', async () => {
    const realFingerprint = await access.hostIdentity()
    const attacker = await C.generateKeyPair()
    const attackerKey = C.toB64u(attacker.raw)
    const forged = createServer((req, res) => {
      if (req.url?.startsWith('/remote/v1/tunnel/invite')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, hostKey: attackerKey, code: 'forged-code', computer: { name: '冒充的电脑' } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((resolve) => forged.listen(0, '127.0.0.1', resolve))
    const forgedBase = `http://127.0.0.1:${forged.address().port}`
    try {
      const preflight = await Mobile.Client.manualPairInvite(forgedBase)
      assert.ok(!('error' in preflight))
      assert.notEqual(preflight.identity.fingerprint, realFingerprint)
    } finally {
      await new Promise((resolve) => forged.close(resolve))
    }
  })

  await check('同一配对窗口内反复取邀请拿到同一把通道码', async () => {
    access.startPairing()
    const one = await inviteNow()
    const two = await inviteNow()
    assert.equal(one.code, two.code)
    assert.equal(one.hostKey, two.hostKey)
    assert.equal(one.hostFingerprint, await access.hostIdentity())
    access.cancelPairing()
  })

  await check('手机自撤销同时清掉它的隧道身份，旧通道身份不能再连', async () => {
    const { code } = access.startPairing()
    const connection = await Mobile.Client.pair(base, code, '自撤销手机', async () => true)
    const device = (await access.status()).devices.find((item) => item.id === connection.deviceId)
    assert.ok(device?.tunnelClientId)
    await new Mobile.Client.RemoteClient(connection).revokeSelf()
    const revokedClient = (await access.relay.store.list()).find((client) => client.id === device.tunnelClientId)
    assert.ok(revokedClient?.revokedAt, '撤销设备后隧道身份应被撤掉')
    Mobile.RelayTunnel.for(connection.relay).close()
    await assert.rejects(() => Mobile.RelayTunnel.for(connection.relay).connect(), /撤销|revoke|配对|pair/)
  })

  await check('先由列表触发过期后，运行清理仍会断开仍在连的未配对隧道', async () => {
    access.startPairing()
    const invite = await inviteNow()
    const tunnel = new Mobile.RelayTunnel({ direct: [tunnelUrl], hostKey: invite.hostKey, clientKey: Mobile.newClientKey() }, '未配对设备')
    await tunnel.connect(invite.code)
    const health = await tunnel.request('GET', '/remote/v1/health')
    assert.equal(health.status, 200)
    const store = access.relay.store
    const unpaired = (await store.list()).find((client) => !client.pairedAt)
    assert.ok(unpaired, '未配对隧道身份缺失')
    const originalNow = store.now
    store.now = () => Date.now() + 11 * 60_000
    try {
      const listed = await store.list()
      const expired = listed.find((client) => client.id === unpaired.id)
      assert.ok(expired?.revokedAt, '列表读取时未配对身份已过期')
      await access.relay.sweepExpiredIdentities()
    } finally {
      store.now = originalNow
    }
    await assert.rejects(() => tunnel.request('GET', '/remote/v1/health'), /连接已关闭|断开|closed|drop/)
  })

  await check('真实服务拒绝认证前的超大握手帧', async () => {
    const socket = new WebSocket(tunnelUrl)
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = reject
    })
    const closed = new Promise((resolve) => {
      socket.onclose = () => resolve(true)
    })
    socket.send(JSON.stringify({ t: 'hi', v: 1, c: 'x', e: 'y', pad: 'A'.repeat(100_000) }))
    const result = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 3000))])
    assert.equal(result, true, '超大握手帧应被直接断开')
  })

  await check('远程选择会话不切换到电脑的活动实例', async () => {
    const remoteHost = await bundle(
      `export { configureRemoteHost, remoteSelectSession, remoteAnswer } from './src/main/remote-host'`,
      'remotehost',
      {
        banner: requireBanner,
        plugins: [
          electronStub,
          {
            name: 'remote-host-fixtures',
            setup(b) {
              const stubs = {
                './remote-approval': 'export const approvalDigest = () => "d"; export const applyHumanApproval = async () => ({ ok: false }); export const remoteApprovalQuestion = (x) => x',
                './image-store': 'export const localizeImage = () => ""',
                './title': 'export const setManualTitle = async () => ({ ok: true }); export const manualTitles = async () => ({}); export const cachedTitles = async () => ({})',
                './settings': 'export const getSettings = async () => globalThis.__remoteHostFixture.settings',
                './sessions': 'export const listSessions = async () => globalThis.__remoteHostFixture.sessions.map((item) => ({ ...item })); export const deleteSession = async () => undefined; export const restoreSession = async () => undefined; export const sessionsToDelete = async () => []; export const SESSIONS_DIR = ""',
                './paths': 'export const YAN_DIR = "/fixture"'
              }
              b.onResolve({ filter: /.*/ }, (args) => (Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined))
              b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: stubs[args.path], loader: 'js' }))
            }
          }
        ]
      }
    )
    const selects = []
    const fixture = {
      settings: { projects: [{ id: 'P', cwd: '/fixture/P' }], cwd: '/fixture/P' },
      sessions: [{ id: 'A', path: '/fixture/A.jsonl', cwd: '/fixture/P', projectId: 'P', scope: 'project', title: 'A', createdAt: 1, updatedAt: 1, messageCount: 1 }]
    }
    globalThis.__remoteHostFixture = fixture
    remoteHost.configureRemoteHost({
      runners: () => ({
        select: async (target) => {
          selects.push(target)
          return { ok: true, id: 'run-a', runId: 'run-a', sessionId: target.sessionId, generation: 1 }
        }
      }),
      ac: () => null,
      push: () => undefined,
      pushRunners: () => undefined,
      pushRunnerSnapshot: () => undefined,
      validateCwd: async (cwd) => ({ ok: true, cwd }),
      startAgent: async () => ({ ok: true }),
      projectIdForCwd: () => 'P',
      rememberRunnerSession: async () => undefined,
      readHistoryWithArtifacts: async () => null,
      sessionChains: { load: async () => undefined, chains: () => [], representativeOf: () => undefined },
      win: () => null,
      remoteAccess: () => null
    })
    const result = await remoteHost.remoteSelectSession('A')
    assert.equal(result.ok, true)
    assert.equal(selects.length, 1)
    assert.equal(selects[0].activate, false)

    const answers = []
    let answerResult = { ok: false, code: 'pi_down' }
    const agent = {
      pendingUiRequests: () => [{ id: 'q1', method: 'input', sensitive: false }],
      answerUiRemotely: async (id, answer) => {
        answers.push({ id, answer })
        return answerResult
      }
    }
    remoteHost.configureRemoteHost({
      runners: () => ({ statuses: () => [{ runId: 'r1', sessionId: 'A' }], agentOf: () => agent }),
      ac: () => null,
      push: () => undefined,
      pushRunners: () => undefined,
      pushRunnerSnapshot: () => undefined,
      validateCwd: async (cwd) => ({ ok: true, cwd }),
      startAgent: async () => ({ ok: true }),
      projectIdForCwd: () => 'P',
      rememberRunnerSession: async () => undefined,
      readHistoryWithArtifacts: async () => null,
      sessionChains: { load: async () => undefined, chains: () => [], representativeOf: () => undefined },
      win: () => null,
      remoteAccess: () => null
    })
    const undelivered = await remoteHost.remoteAnswer('q1', { value: '答案' })
    assert.equal(undelivered.ok, false)
    assert.equal(undelivered.status, 503)
    assert.equal(undelivered.code, 'pi_down')
    assert.match(undelivered.error, /重试|retry/i)
    answerResult = { ok: false, code: 'question_not_pending' }
    const expired = await remoteHost.remoteAnswer('q1', { value: '答案' })
    assert.equal(expired.status, 409)
    assert.equal(expired.code, 'question_not_pending')
    answerResult = { ok: false, code: 'sensitive_confirmation_requires_desktop' }
    const sensitive = await remoteHost.remoteAnswer('q1', { confirmed: true })
    assert.equal(sensitive.status, 403)
    answerResult = { ok: true }
    const accepted = await remoteHost.remoteAnswer('q1', { value: '答案' })
    assert.equal(accepted.ok, true)
    assert.equal(answers.length, 4)
  })

  await check('网页深链只在手机尚未连接时预填配对页', async () => {
    const link = 'inkstone://pair?address=100.101.102.103%3A37892&code=123456'
    assert.ok(Mobile.parsePairingLink(link))
    assert.equal(Mobile.pairingPrefillFor(link, 'connected'), null)
    assert.equal(Mobile.pairingPrefillFor(link, 'unknown'), null)
    assert.ok(Mobile.pairingPrefillFor(link, 'disconnected'))
  })

  await check('整体身份重置更换主机密钥、撤销全部设备并要求重新配对', async () => {
    const before = await access.hostIdentity()
    const { code } = access.startPairing()
    const connection = await Mobile.Client.pair(base, code, '重置前手机', async () => true)
    const oldHostKey = connection.relay.hostKey
    const reset = await access.resetIdentity()
    assert.notEqual(reset.hostFingerprint, before)
    assert.equal(await access.hostIdentity(), reset.hostFingerprint)
    assert.ok(reset.revokedDevices >= 1)
    const status = await access.status()
    assert.ok(status.devices.every((device) => device.revokedAt !== null), '重置后所有设备应被撤销')
    assert.equal((await access.relay.store.list()).length, 0, '重置后旧隧道身份应清空')
    assert.equal(status.relay.clients.length, 0)
    Mobile.RelayTunnel.for(connection.relay).close()
    await assert.rejects(() => Mobile.RelayTunnel.for(connection.relay).connect(), /撤销|revoke|配对|pair|断开|closed/)
    const stale = new Mobile.RelayTunnel({ direct: [tunnelUrl], hostKey: oldHostKey, clientKey: Mobile.newClientKey() }, '旧主机密钥')
    await assert.rejects(() => stale.connect(), /断开|closed|拒绝|refused|denied/)
  })
} finally {
  await access.stop().catch(() => undefined)
}

if (failures) console.log(`\n✖ 身份与隧道检查：${failures} / ${checks} 项失败`)
else console.log(`\n身份与隧道检查全部通过（${checks} 项）。`)
process.stdout.write('', () => process.exit(failures ? 1 : 0))
