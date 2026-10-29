#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/')
const bundles = []

async function bundleModules(entries) {
  const outfile = join(tmpdir(), `yan-collab-${randomUUID()}.mjs`)
  const contents = Object.entries(entries)
    .map(([name, path]) => `export * as ${name} from ${JSON.stringify(`${repoRoot}${path}`)}`)
    .join('\n')
  await build({
    stdin: { contents, resolveDir: repoRoot, sourcefile: 'collab-entry.ts', loader: 'ts' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
    logLevel: 'warning'
  })
  bundles.push(outfile)
  return import(pathToFileURL(outfile).href)
}

const mod = await bundleModules({
  gitOps: 'src/main/collab/git.ts',
  hostMod: 'src/main/collab/host.ts',
  serverMod: 'src/main/remote-server.ts',
  devicesMod: 'src/main/remote-devices.ts',
  grantsMod: 'src/main/peer-grants.ts',
  collab: 'src/shared/collab.ts',
  serviceMod: 'src/main/collab/service.ts',
  collabTextMod: 'src/renderer/src/features/collab/collab-text.ts'
})
const { gitOps, hostMod, serverMod, devicesMod, grantsMod, collab, serviceMod, collabTextMod } = mod
const { CollabService } = serviceMod
const { RemoteServer } = serverMod
const { RemoteDeviceStore } = devicesMod
const { PeerGrantRegistry } = grantsMod
const { createCollabHost } = hostMod
const { slugForRemote, trackingRefFor, COLLAB_BUNDLE_MAX_BYTES } = collab

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

const sh = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const shOk = (cwd, ...args) => {
  try {
    sh(cwd, ...args)
    return true
  } catch {
    return false
  }
}
function commitFile(dir, name, content, message) {
  writeFileSync(join(dir, name), content)
  sh(dir, 'add', '--', name)
  sh(dir, 'commit', '-q', '-m', message)
  return sh(dir, 'rev-parse', 'HEAD')
}
function identify(dir, name) {
  sh(dir, 'config', 'user.name', name)
  sh(dir, 'config', 'user.email', `${name.toLowerCase()}@example.test`)
  sh(dir, 'config', 'core.autocrlf', 'false')
  sh(dir, 'config', 'commit.gpgsign', 'false')
}
const allRefs = (dir, pattern = '') =>
  sh(dir, 'for-each-ref', '--format=%(refname) %(objectname)', ...(pattern ? [pattern] : []))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'yan-collab-test-')))
const gitConfigFile = join(root, 'gitconfig')
writeFileSync(gitConfigFile, '')
process.env.GIT_CONFIG_GLOBAL = gitConfigFile
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'

const B = join(root, 'B')
const BWT = join(root, 'B-wt')
const A = join(root, 'A')
const C = join(root, 'C')
const plain = join(root, 'plain')
const SH = join(root, 'SH')
const SC = join(root, 'SC')
const svcDir = join(root, 'svc')
const work = join(root, 'work')
const hostTemp = join(root, 'host-tmp')
const deviceDir = join(root, 'devices')
for (const dir of [plain, work, deviceDir]) mkdirSync(dir, { recursive: true })

const DEVICE_NAME = '砚 · Laptop-A'
let REMOTE_SLUG = 'yan-laptop-a'
const FEATURE_REF = trackingRefFor(slugForRemote('B 电脑', 'peerb'), 'feature')
const PUSHED_REF = (branch) => trackingRefFor(REMOTE_SLUG, branch)

const incoming = []
const streams = []
let nextDecision = null
let server = null
let base = ''
let peerToken = ''
let phoneToken = ''
let peerDeviceId = ''
let conn1 = null
let conn2 = null

const grants = new PeerGrantRegistry({
  ask: (request) => {
    const decision = nextDecision
      ? nextDecision(request)
      : { approve: false, projectIds: [], operations: [] }
    setTimeout(() => grants.decide({ ...decision, requestId: request.requestId }), 5)
  },
  closed: () => undefined,
  changed: (_list, revoked) => {
    if (revoked) server?.disconnectConnection(revoked)
  }
})

const sessionList = [
  { id: 's1', title: '特性会话', cwd: B, updatedAt: 1700000002000, messageCount: 4 },
  { id: 's2', title: '工作树会话', cwd: BWT, updatedAt: 1700000001000, messageCount: 2 },
  { id: 's3', title: '主目录会话', cwd: B, updatedAt: 1700000000000, messageCount: 1 }
]
const serviceSessions = [
  { id: 's4', title: '服务会话', cwd: SH, updatedAt: 1700000200000, messageCount: 3 },
  { id: 's5', title: '另一个会话', cwd: SH, updatedAt: 1700000100000, messageCount: 1 }
]
const sessionProject = { s1: 'p1', s2: 'p1', s3: 'p1', s4: 'p4', s5: 'p4', 's-other': 'p2' }

const collabHost = createCollabHost({
  projects: async () => [
    { id: 'p1', name: '演示', cwd: B },
    { id: 'p2', name: '其他', cwd: C },
    { id: 'p3', name: '非仓库', cwd: plain },
    { id: 'p4', name: '服务项目', cwd: SH }
  ],
  projectSessions: async (projectId) => (projectId === 'p1' ? sessionList : projectId === 'p4' ? serviceSessions : []),
  sessionBranchLinks: () => [
    { sessionId: 's1', branch: 'feature' },
    { sessionId: 's4', branch: 'feature' },
    { sessionId: 's5', branch: 'feature' }
  ],
  projectOfSession: async (sessionId) => sessionProject[sessionId] ?? null,
  exportSession: async (sessionId) => ({
    ok: true,
    data: {
      version: 1,
      source: { computer: 'B 电脑', sessionId, projectId: sessionProject[sessionId], projectName: '演示', title: '导出', exportedAt: 1, updatedAt: 1, messageCount: 0 },
      messages: [],
      artifacts: [],
      truncated: false
    }
  }),
  onIncomingRequest: async (request) => {
    incoming.push(request)
    await writeFile(join(root, 'host-state.json'), JSON.stringify({ version: 1, requests: incoming }))
  },
  stateFile: join(root, 'host-state.json'),
  tempDir: hostTemp
})

async function call(path, { token = peerToken, connection, method = 'GET', json, raw, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(connection ? { 'x-yan-connection': connection } : {}),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(raw !== undefined ? { 'content-type': 'application/octet-stream' } : {}),
      ...headers
    },
    body: json !== undefined ? JSON.stringify(json) : raw
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type') ?? ''
  let body = {}
  if (contentType.includes('json')) {
    try {
      body = JSON.parse(buffer.toString('utf8'))
    } catch {
      body = {}
    }
  }
  return { status: response.status, contentType, buffer, body }
}
const collabCall = (connection, path, options = {}) => call(`/remote/v1/peer/collab/${path}`, { connection, ...options })

async function openStream(token, connection) {
  const controller = new AbortController()
  const response = await fetch(`${base}/remote/v1/peer/events`, {
    headers: { authorization: `Bearer ${token}`, 'x-yan-connection': connection },
    signal: controller.signal
  })
  const reader = response.ok ? response.body.getReader() : null
  if (reader) await reader.read()
  const stream = { status: response.status, close: () => controller.abort() }
  streams.push(stream)
  return stream
}

async function connectPeer(operations, projectIds, decidedOperations = operations) {
  nextDecision = () => ({ approve: true, projectIds, operations: decidedOperations })
  const response = await call('/remote/v1/peer/connect', { method: 'POST', json: { operations } })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body.data.grant
}

async function activate(grant) {
  const stream = await openStream(peerToken, grant.connectionId)
  assert.equal(stream.status, 200, '事件流应打开')
  return stream
}

function declaredOversize(path, connection) {
  return new Promise((resolve, reject) => {
    const url = new URL(base)
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: 'POST',
        headers: {
          authorization: `Bearer ${peerToken}`,
          'x-yan-connection': connection,
          'content-type': 'application/octet-stream',
          'content-length': String(COLLAB_BUNDLE_MAX_BYTES + 1)
        }
      },
      (response) => {
        response.resume()
        resolve(response.statusCode)
        request.destroy()
      }
    )
    request.on('error', reject)
    request.setTimeout(5000, () => request.destroy(new Error('等待 413 超时')))
    request.flushHeaders()
  })
}

async function pullFeatureInto(dir) {
  const haves = await gitOps.refTips(dir)
  const response = await collabCall(conn1.connectionId, 'projects/p1/bundle', { method: 'POST', json: { branch: 'feature', haves } })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  if (response.contentType.includes('json')) return { upToDate: true, response }
  const oid = sh(B, 'rev-parse', 'refs/heads/feature')
  const file = join(work, `pull-${randomUUID()}.bundle`)
  await writeFile(file, response.buffer)
  const fetched = await gitOps.fetchBundle(dir, file, 'feature', FEATURE_REF, oid)
  assert.equal(fetched.ok, true, fetched.error)
  return { upToDate: false, response, oid, file }
}

let featureOid1 = ''
let featureOid2 = ''
let pulledBundle = null
let topicOid = ''
let topicBundle = null
let hostTips = []
let branchListing = null

try {
  section('准备：两个仓库')

  await check('B（host）有 main / feature，A 是 B 的克隆，工作树里还有 wt-branch', async () => {
    sh(root, 'init', '-q', '-b', 'main', B)
    identify(B, 'Bob')
    commitFile(B, 'a.txt', 'line1\nline2\nline3\n', '初始提交')
    commitFile(B, 'big.txt', randomBytes(160 * 1024).toString('base64'), '加一个较大的文件')
    sh(B, 'checkout', '-q', '-b', 'feature')
    featureOid1 = commitFile(B, 'feature.txt', 'feature v1\n', 'feature 第一次提交')
    sh(B, 'checkout', '-q', 'main')
    sh(B, 'worktree', 'add', '-q', '-b', 'wt-branch', BWT)
    sh(root, 'clone', '-q', B, A)
    identify(A, 'Alice')
    sh(root, 'init', '-q', '-b', 'main', C)
    identify(C, 'Carol')
    commitFile(C, 'c.txt', 'c\n', 'C 初始提交')
    assert.equal(sh(A, 'rev-parse', 'origin/feature'), featureOid1)
    assert.equal(sh(A, 'symbolic-ref', '--short', 'HEAD'), 'main')
  })

  section('服务：RemoteServer + 配对 + 授权')

  const devices = new RemoteDeviceStore(deviceDir)
  server = new RemoteServer({
    host: '127.0.0.1',
    port: 0,
    devices,
    handlers: {
      async snapshot() {
        return { sessions: [] }
      },
      async history(sessionId) {
        return { ok: true, data: { sessionId, messages: [] } }
      },
      async command(command) {
        return { ok: true, data: command }
      }
    },
    peers: {
      grants,
      handlers: {
        async projects() {
          return [
            { id: 'p1', name: '演示' },
            { id: 'p2', name: '其他' },
            { id: 'p3', name: '非仓库' },
            { id: 'p4', name: '服务项目' }
          ]
        },
        async sessions() {
          return []
        },
        async projectOfSession(sessionId) {
          return sessionProject[sessionId] ?? null
        },
        async projectOfRun() {
          return null
        },
        async exportSession(sessionId) {
          return { ok: true, data: { version: 1, source: { sessionId }, messages: [], artifacts: [] } }
        },
        async startSession() {
          return { ok: false, status: 501, error: '测试不支持' }
        },
        collab: collabHost
      }
    }
  })
  const info = await server.start()
  base = `http://127.0.0.1:${info.port}`

  await check('配对：手机与另一台砚（peer）都能用配对码配对', async () => {
    const pairAs = async (kind, deviceName) => {
      const { code } = devices.startPairing()
      const response = await call('/remote/v1/pair', { token: '', method: 'POST', json: { code, deviceName, kind } })
      assert.equal(response.status, 200, JSON.stringify(response.body))
      return response.body
    }
    const peer = await pairAs('peer', DEVICE_NAME)
    peerToken = peer.token
    peerDeviceId = peer.deviceId
    phoneToken = (await pairAs('phone', '我的手机')).token
    assert.ok(peerToken && phoneToken && peerDeviceId)
    REMOTE_SLUG = slugForRemote(DEVICE_NAME, peerDeviceId)
    assert.ok(REMOTE_SLUG.startsWith('yan-laptop-a-') && REMOTE_SLUG.length > 'yan-laptop-a-'.length, REMOTE_SLUG)
    assert.notEqual(slugForRemote(DEVICE_NAME, 'another-device'), REMOTE_SLUG, '同名设备的追踪引用不互相覆盖')
  })

  await check('collab 路由：未申请连接 401，手机令牌 403，事件流打开前 409', async () => {
    const noConnection = await collabCall(undefined, 'projects/p1/branches')
    assert.equal(noConnection.status, 401)
    const phone = await call('/remote/v1/peer/collab/projects/p1/branches', { token: phoneToken })
    assert.equal(phone.status, 403)
    conn1 = await connectPeer(['pull', 'push'], ['p1', 'p3'])
    assert.deepEqual(conn1.operations, ['pull', 'push'])
    assert.deepEqual(conn1.projects.map((p) => p.id), ['p1', 'p3'])
    const inactive = await collabCall(conn1.connectionId, 'projects/p1/branches')
    assert.equal(inactive.status, 409)
    assert.equal(inactive.body.code, 'peer_connection_inactive')
  })

  await check('打开事件流后连接激活，collab 可用', async () => {
    await activate(conn1)
    const response = await collabCall(conn1.connectionId, 'projects/p1/branches')
    assert.equal(response.status, 200, JSON.stringify(response.body))
    branchListing = response.body.data
  })

  section('branches：分支清单')

  await check('列出 feature / main / wt-branch，提交号与 B 一致，main 为当前分支', async () => {
    const names = branchListing.branches.map((b) => b.name).sort()
    assert.deepEqual(names, ['feature', 'main', 'wt-branch'])
    assert.equal(branchListing.projectId, 'p1')
    assert.equal(branchListing.projectName, '演示')
    const feature = branchListing.branches.find((b) => b.name === 'feature')
    assert.equal(feature.oid, featureOid1)
    assert.equal(feature.subject, 'feature 第一次提交')
    assert.equal(feature.author, 'Bob')
    assert.equal(feature.current, false)
    assert.equal(branchListing.branches.find((b) => b.name === 'main').current, true)
  })

  await check('rootCommits 与 A 的根提交一致', async () => {
    const aRoots = sh(A, 'rev-list', '--max-parents=0', '--all').split(/\s+/).filter(Boolean).sort()
    assert.deepEqual([...branchListing.rootCommits].sort(), aRoots)
    assert.deepEqual([...(await gitOps.rootCommits(A))].sort(), aRoots)
    assert.equal(aRoots.length, 1)
  })

  await check('分支关联会话：feature→s1（显式关联），wt-branch→s2（按工作树），main 无', async () => {
    const byName = Object.fromEntries(branchListing.branches.map((b) => [b.name, b.sessions.map((s) => s.sessionId)]))
    assert.deepEqual(byName.feature, ['s1'])
    assert.deepEqual(byName['wt-branch'], ['s2'])
    assert.deepEqual(byName.main, [])
    const s1 = branchListing.branches.find((b) => b.name === 'feature').sessions[0]
    assert.equal(s1.title, '特性会话')
    assert.equal(s1.messageCount, 4)
  })

  await check('tips 含 B 各分支的提交号', async () => {
    for (const branch of ['feature', 'main', 'wt-branch']) {
      assert.ok(branchListing.tips.includes(sh(B, 'rev-parse', `refs/heads/${branch}`)), `${branch} 的 tip 不在 tips 里`)
    }
  })

  section('bundle：增量拉取')

  await check('B 在 feature 上新提交后，A 带 haves 请求得到 octet-stream 增量包', async () => {
    sh(B, 'checkout', '-q', 'feature')
    commitFile(B, 'feature.txt', 'feature v2\n', 'feature 第二次提交')
    featureOid2 = commitFile(B, 'feature2.txt', 'second file\n', 'feature 加第二个文件')
    sh(B, 'checkout', '-q', 'main')
    const haves = await gitOps.refTips(A)
    assert.ok(haves.length >= 2)
    const response = await collabCall(conn1.connectionId, 'projects/p1/bundle', { method: 'POST', json: { branch: 'feature', haves } })
    assert.equal(response.status, 200, response.buffer.toString('utf8').slice(0, 200))
    assert.ok(response.contentType.startsWith('application/octet-stream'), response.contentType)
    assert.ok(response.buffer.length > 0)
    pulledBundle = response.buffer
  })

  await check('fetchBundle 成功：追踪引用落在 B 声明的提交上，且没有写 FETCH_HEAD', async () => {
    const file = join(work, 'pull-1.bundle')
    await writeFile(file, pulledBundle)
    const result = await gitOps.fetchBundle(A, file, 'feature', FEATURE_REF, featureOid2)
    assert.equal(result.ok, true, result.error)
    assert.equal(FEATURE_REF, 'refs/remotes/yan-b-peerb/feature')
    assert.equal(sh(A, 'rev-parse', FEATURE_REF), featureOid2)
    assert.equal(sh(A, 'rev-parse', 'refs/heads/main'), sh(A, 'rev-parse', 'origin/main'))
    assert.equal(existsSync(join(A, '.git', 'FETCH_HEAD')), false)
  })

  await check('aheadBehind：A 落后 feature 至少 1 个提交，没有领先', async () => {
    const counts = await gitOps.aheadBehind(A, FEATURE_REF)
    assert.ok(counts, 'aheadBehind 返回 null')
    assert.ok(counts.incoming >= 1, `incoming=${counts.incoming}`)
    assert.equal(counts.outgoing, 0)
  })

  await check('包是增量的：头部有 prerequisite（A 已有的提交），体积远小于完整包', async () => {
    const head = pulledBundle.subarray(0, 4096).toString('latin1')
    const header = head.slice(0, head.indexOf('\n\n'))
    assert.match(header.split('\n')[0], /^# v\d git bundle$/)
    const prerequisites = header.split('\n').filter((line) => line.startsWith('-')).map((line) => line.slice(1).split(' ')[0])
    assert.ok(prerequisites.length >= 1, `没有 prerequisite：\n${header}`)
    for (const oid of prerequisites) assert.ok(shOk(A, 'cat-file', '-e', `${oid}^{commit}`), `A 没有前置提交 ${oid}`)
    assert.ok(sh(A, 'bundle', 'list-heads', join(work, 'pull-1.bundle')).includes(`${featureOid2} refs/heads/feature`))
    const fullFile = join(work, 'full.bundle')
    const full = await gitOps.createBundle(B, 'feature', [], fullFile)
    assert.equal(full.kind, 'bundle')
    const fullSize = (await stat(fullFile)).size
    assert.ok(fullSize > 100 * 1024, `完整包只有 ${fullSize} 字节，样例不够大`)
    assert.ok(pulledBundle.length < fullSize / 4, `增量包 ${pulledBundle.length} 字节，完整包 ${fullSize} 字节`)
  })

  await check('再请求一次（haves 含新提交）返回 JSON upToDate:true', async () => {
    const haves = await gitOps.refTips(A)
    assert.ok(haves.includes(featureOid2))
    const response = await collabCall(conn1.connectionId, 'projects/p1/bundle', { method: 'POST', json: { branch: 'feature', haves } })
    assert.equal(response.status, 200)
    assert.ok(response.contentType.includes('json'), response.contentType)
    assert.equal(response.body.data.upToDate, true)
    assert.equal(response.body.data.oid, featureOid2)
  })

  await check('host 临时目录里的代码包在传输结束后被清理', async () => {
    let left = []
    for (let i = 0; i < 20; i += 1) {
      left = existsSync(hostTemp) ? await readdir(hostTemp) : []
      if (!left.length) break
      await wait(50)
    }
    assert.deepEqual(left, [])
  })

  section('对比：compareWith / fileDiffWith / 引用校验')

  await check('compareWith：base、ahead/behind、提交列表与文件改动合理', async () => {
    const result = await gitOps.compareWith(A, FEATURE_REF)
    assert.equal(result.error, undefined, result.error)
    assert.equal(result.ref, FEATURE_REF)
    assert.equal(result.base, sh(A, 'merge-base', 'HEAD', FEATURE_REF))
    assert.equal(result.incoming, 3)
    assert.equal(result.outgoing, 0)
    assert.equal(result.commits.length, 3)
    assert.equal(result.commits[0].oid, featureOid2)
    assert.equal(result.commits[0].subject, 'feature 加第二个文件')
    assert.equal(result.commits[0].author, 'Bob')
    const paths = result.files.map((f) => f.path).sort()
    assert.deepEqual(paths, ['feature.txt', 'feature2.txt'])
    const featureTxt = result.files.find((f) => f.path === 'feature.txt')
    assert.equal(featureTxt.status, 'A')
    assert.equal(featureTxt.additions, 1)
    assert.equal(featureTxt.deletions, 0)
  })

  await check('fileDiffWith 返回该文件相对共同祖先的 diff，拒绝坏路径', async () => {
    const diff = await gitOps.fileDiffWith(A, FEATURE_REF, 'feature.txt')
    assert.equal(typeof diff, 'string')
    assert.ok(diff.includes('+++ b/feature.txt'), diff)
    assert.ok(diff.includes('+feature v2'), diff)
    assert.ok(!diff.includes('feature2.txt'))
    assert.ok(typeof (await gitOps.fileDiffWith(A, FEATURE_REF, '--output=x')) === 'object')
    assert.ok(typeof (await gitOps.fileDiffWith(A, 'refs/heads/main', 'feature.txt')) === 'object')
  })

  await check('checkTrackingRef 拒绝本地分支与畸形引用，且 fetch / 指针 / 对比 / 合并都不能越过它', async () => {
    assert.ok(gitOps.checkTrackingRef('refs/heads/main'))
    assert.ok(gitOps.checkTrackingRef('refs/remotes/yan-b'))
    assert.ok(gitOps.checkTrackingRef('refs/remotes/yan-b/../x'))
    assert.ok(gitOps.checkTrackingRef('refs/remotes//x'))
    assert.ok(gitOps.checkTrackingRef('refs/tags/v1'))
    assert.ok(gitOps.checkTrackingRef(42))
    assert.equal(gitOps.checkTrackingRef(FEATURE_REF), null)
    const mainBefore = sh(A, 'rev-parse', 'refs/heads/main')
    const file = join(work, 'pull-1.bundle')
    const fetched = await gitOps.fetchBundle(A, file, 'feature', 'refs/heads/main', featureOid2)
    assert.equal(fetched.ok, false)
    const pointed = await gitOps.pointTrackingRef(A, 'refs/heads/main', featureOid2)
    assert.equal(pointed.ok, false)
    assert.ok((await gitOps.compareWith(A, 'refs/heads/main')).error)
    const merged = await gitOps.mergeRef(A, 'refs/heads/feature', 'x')
    assert.equal(merged.ok, false)
    assert.equal(sh(A, 'rev-parse', 'refs/heads/main'), mainBefore)
  })

  section('合并：mergeRef / abortMerge')

  await check('没拉取过的追踪引用不能合并', async () => {
    const result = await gitOps.mergeRef(A, trackingRefFor('yan-b', 'never-fetched'), 'x')
    assert.equal(result.ok, false)
    assert.match(result.error, /还没有拉取/)
  })

  await check('工作区有未提交改动时拒绝合并，返回 worktree-dirty 错误码，HEAD 不动', async () => {
    const head = sh(A, 'rev-parse', 'HEAD')
    writeFileSync(join(A, 'a.txt'), 'dirty\n')
    const result = await gitOps.mergeRef(A, FEATURE_REF, '不该合并')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'worktree-dirty')
    assert.doesNotMatch(result.error, /[\u4e00-\u9fff]/, '主进程文案不写中文，由渲染端按语言显示')
    assert.match(result.error, /uncommitted/)
    assert.equal(sh(A, 'rev-parse', 'HEAD'), head)
    assert.equal(await gitOps.mergeInProgress(A), false)
    sh(A, 'restore', '--', 'a.txt')
    assert.equal(sh(A, 'status', '--porcelain'), '')
  })

  await check('合并会覆盖未跟踪文件时失败，不留下合并状态，也不动用户文件', async () => {
    const head = sh(A, 'rev-parse', 'HEAD')
    writeFileSync(join(A, 'feature2.txt'), '我自己的文件\n')
    const result = await gitOps.mergeRef(A, FEATURE_REF, 'x')
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.ok(result.error)
    assert.equal(result.conflicts, undefined)
    assert.equal(await gitOps.mergeInProgress(A), false)
    assert.equal(sh(A, 'rev-parse', 'HEAD'), head)
    assert.equal(await readFile(join(A, 'feature2.txt'), 'utf8'), '我自己的文件\n')
    await rm(join(A, 'feature2.txt'), { force: true })
  })

  await check('mergeRef 合并成功：能快进就直接快进到对方提交，不生成合并提交', async () => {
    const before = sh(A, 'rev-parse', 'HEAD')
    const tip = sh(A, 'rev-parse', FEATURE_REF)
    const tipSubject = sh(A, 'log', '-1', '--format=%s', tip)
    const result = await gitOps.mergeRef(A, FEATURE_REF, '合并 B 电脑的 feature')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.merged, true)
    assert.equal(result.head, sh(A, 'rev-parse', 'HEAD'))
    assert.notEqual(result.head, before)
    assert.equal(result.head, tip, '快进到对方的提交')
    assert.equal(sh(A, 'log', '-1', '--format=%s'), tipSubject, '快进不生成合并提交')
    assert.equal(sh(A, 'rev-list', '--parents', '-1', 'HEAD').trim().split(' ').length, 2, '快进后的提交只有单个父提交')
    assert.equal(await readFile(join(A, 'feature2.txt'), 'utf8'), 'second file\n')
    assert.equal(await gitOps.mergeInProgress(A), false)
  })

  await check('再合并一次：已包含对方全部提交，merged:false 且 HEAD 不变', async () => {
    const head = sh(A, 'rev-parse', 'HEAD')
    const result = await gitOps.mergeRef(A, FEATURE_REF, '重复合并')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.merged, false)
    assert.equal(sh(A, 'rev-parse', 'HEAD'), head)
  })

  await check('两边改同一行：返回 conflicts，mergeInProgress 为 true，重复合并被拒', async () => {
    sh(B, 'checkout', '-q', 'feature')
    const bOid = commitFile(B, 'a.txt', 'line1\nline2 from B\nline3\n', 'B 改第二行')
    sh(B, 'checkout', '-q', 'main')
    commitFile(A, 'a.txt', 'line1\nline2 from A\nline3\n', 'A 改第二行')
    const pulled = await pullFeatureInto(A)
    assert.equal(pulled.upToDate, false)
    assert.equal(sh(A, 'rev-parse', FEATURE_REF), bOid)
    const head = sh(A, 'rev-parse', 'HEAD')
    const result = await gitOps.mergeRef(A, FEATURE_REF, '会冲突的合并')
    assert.equal(result.ok, false)
    assert.deepEqual(result.conflicts, ['a.txt'])
    assert.equal(await gitOps.mergeInProgress(A), true)
    assert.match(await readFile(join(A, 'a.txt'), 'utf8'), /<<<<<<<[\s\S]*line2 from A[\s\S]*=======[\s\S]*line2 from B[\s\S]*>>>>>>>/)
    const again = await gitOps.mergeRef(A, FEATURE_REF, '又合并')
    assert.equal(again.ok, false)
    assert.match(again.error, /上一次合并/)
    assert.equal(sh(A, 'rev-parse', 'HEAD'), head)
  })

  await check('abortMerge 放弃合并：mergeInProgress 变 false，工作区恢复干净；没有合并时再 abort 被拒', async () => {
    const aborted = await gitOps.abortMerge(A)
    assert.equal(aborted.ok, true, aborted.error)
    assert.equal(await gitOps.mergeInProgress(A), false)
    assert.equal(sh(A, 'status', '--porcelain'), '')
    assert.equal(await readFile(join(A, 'a.txt'), 'utf8'), 'line1\nline2 from A\nline3\n')
    const second = await gitOps.abortMerge(A)
    assert.equal(second.ok, false)
  })

  section('push：A 推给 B')

  const refsHeadsBefore = allRefs(B, 'refs/heads')
  const bHeadBefore = sh(B, 'rev-parse', 'HEAD')

  await check('A 的 topic 增量包推给 B：只落在 B 的 refs/remotes/<设备>/topic，B 的 refs/heads 不变', async () => {
    sh(A, 'checkout', '-q', '-b', 'topic')
    topicOid = commitFile(A, 'topic.txt', 'topic\n', 'topic 提交')
    const listing = await collabCall(conn1.connectionId, 'projects/p1/branches')
    hostTips = listing.body.data.tips
    const file = join(work, 'topic.bundle')
    const outcome = await gitOps.createBundle(A, 'topic', hostTips, file)
    assert.equal(outcome.kind, 'bundle', JSON.stringify(outcome))
    assert.equal(outcome.oid, topicOid)
    topicBundle = await readFile(file)
    const response = await collabCall(conn1.connectionId, `projects/p1/push?branch=topic&oid=${topicOid}`, { method: 'POST', raw: topicBundle })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.data.trackingRef, PUSHED_REF('topic'))
    assert.equal(response.body.data.oid, topicOid)
    assert.equal(sh(B, 'rev-parse', PUSHED_REF('topic')), topicOid)
    assert.equal(allRefs(B, 'refs/heads'), refsHeadsBefore)
    assert.equal(sh(B, 'rev-parse', 'HEAD'), bHeadBefore)
    assert.equal(sh(B, 'status', '--porcelain'), '')
    assert.equal(existsSync(join(B, '.git', 'FETCH_HEAD')), false)
  })

  await check('推送的包是增量的（带 prerequisite），且 push 后 host 临时目录被清空', async () => {
    const head = topicBundle.subarray(0, 4096).toString('latin1')
    const header = head.slice(0, head.indexOf('\n\n'))
    assert.ok(header.split('\n').some((line) => line.startsWith('-')), header)
    let left = []
    for (let i = 0; i < 20; i += 1) {
      left = await readdir(hostTemp)
      if (!left.length) break
      await wait(50)
    }
    assert.deepEqual(left, [])
  })

  await check('known=1：B 已有该提交时只移动追踪引用；B 没有的提交号被拒绝', async () => {
    const response = await collabCall(conn1.connectionId, `projects/p1/push?branch=topic-alias&oid=${topicOid}&known=1`, { method: 'POST' })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(sh(B, 'rev-parse', PUSHED_REF('topic-alias')), topicOid)
    const missing = await collabCall(conn1.connectionId, `projects/p1/push?branch=ghost&oid=${'1'.repeat(40)}&known=1`, { method: 'POST' })
    assert.equal(missing.status, 409)
    assert.equal(shOk(B, 'rev-parse', '--verify', '--quiet', PUSHED_REF('ghost')), false)
    assert.equal(allRefs(B, 'refs/heads'), refsHeadsBefore)
  })

  section('requests：合并请求')

  await check('POST requests 后 onIncomingRequest 收到 incoming 请求，追踪引用与字段正确，控制字符被清掉', async () => {
    const response = await collabCall(conn1.connectionId, 'projects/p1/requests', {
      method: 'POST',
      json: { branch: 'topic', oid: topicOid, title: '加 topic', note: '请看一下\u0007这个改动' }
    })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(incoming.length, 1)
    const request = incoming[0]
    assert.equal(request.direction, 'incoming')
    assert.equal(request.trackingRef, PUSHED_REF('topic'))
    assert.equal(request.oid, topicOid)
    assert.equal(request.branch, 'topic')
    assert.equal(request.localProjectId, 'p1')
    assert.equal(request.projectName, '演示')
    assert.equal(request.peerName, 'Laptop-A', '旧客户端报的「砚 · Laptop-A」在登记设备时已去掉前缀')
    assert.equal(request.title, '加 topic')
    assert.equal(request.note, '请看一下 这个改动')
    assert.equal(request.status, 'open')
    assert.equal(request.id, response.body.data.requestId)
    assert.ok(request.id.startsWith('mr-'))
  })

  section('越权与坏输入')

  await check('非法分支名（../x、-x、带空格、.lock、..、前导斜杠、空）在 push / bundle / requests 上都是 400，且不产生任何引用', async () => {
    const refsBefore = allRefs(B)
    const incomingBefore = incoming.length
    for (const name of ['../x', '-x', 'a b', 'x.lock', 'a..b', '/x', '']) {
      const push = await collabCall(conn1.connectionId, `projects/p1/push?branch=${encodeURIComponent(name)}&oid=${topicOid}`, { method: 'POST', raw: topicBundle })
      assert.equal(push.status, 400, `push ${JSON.stringify(name)} 得到 ${push.status}`)
      const bundle = await collabCall(conn1.connectionId, 'projects/p1/bundle', { method: 'POST', json: { branch: name, haves: [] } })
      assert.equal(bundle.status, 400, `bundle ${JSON.stringify(name)} 得到 ${bundle.status}`)
      const request = await collabCall(conn1.connectionId, 'projects/p1/requests', { method: 'POST', json: { branch: name, oid: topicOid, title: 't', note: '' } })
      assert.equal(request.status, 400, `requests ${JSON.stringify(name)} 得到 ${request.status}`)
    }
    assert.equal(allRefs(B), refsBefore)
    assert.equal(incoming.length, incomingBefore)
  })

  await check('非法提交号在 push / requests 上是 400', async () => {
    for (const oid of ['', 'zzz', 'abc123', 'G'.repeat(40), `${topicOid}0`]) {
      const push = await collabCall(conn1.connectionId, `projects/p1/push?branch=topic&oid=${encodeURIComponent(oid)}`, { method: 'POST', raw: topicBundle })
      assert.equal(push.status, 400, `push oid=${JSON.stringify(oid)} 得到 ${push.status}`)
      const request = await collabCall(conn1.connectionId, 'projects/p1/requests', { method: 'POST', json: { branch: 'topic', oid, title: 't', note: '' } })
      assert.equal(request.status, 400, `requests oid=${JSON.stringify(oid)} 得到 ${request.status}`)
    }
    const badJson = await collabCall(conn1.connectionId, 'projects/p1/bundle', { method: 'POST', raw: Buffer.from('not json') })
    assert.equal(badJson.status, 400)
  })

  await check('请求的分支不存在时 bundle 返回 409', async () => {
    const response = await collabCall(conn1.connectionId, 'projects/p1/bundle', { method: 'POST', json: { branch: 'no-such-branch', haves: [] } })
    assert.equal(response.status, 409)
    assert.match(response.body.error, /找不到分支/)
  })

  await check('坏包（随便几字节）push 返回 409，B 没有新引用', async () => {
    const refsBefore = allRefs(B)
    const response = await collabCall(conn1.connectionId, `projects/p1/push?branch=junk&oid=${topicOid}`, { method: 'POST', raw: randomBytes(64) })
    assert.equal(response.status, 409, JSON.stringify(response.body))
    assert.equal(allRefs(B), refsBefore)
    const empty = await collabCall(conn1.connectionId, `projects/p1/push?branch=junk&oid=${topicOid}`, { method: 'POST', raw: Buffer.alloc(0) })
    assert.equal(empty.status, 409, JSON.stringify(empty.body))
    assert.equal(allRefs(B), refsBefore)
  })

  await check('缺前置提交的增量包（B 没有它依赖的提交）被拒绝，409 且无引用', async () => {
    sh(A, 'checkout', '-q', '-b', 'local-only', 'main')
    const baseOid = commitFile(A, 'local1.txt', '1\n', 'A 本地提交 1')
    const tipOid = commitFile(A, 'local2.txt', '2\n', 'A 本地提交 2')
    const file = join(work, 'local-only.bundle')
    const outcome = await gitOps.createBundle(A, 'local-only', [baseOid], file)
    assert.equal(outcome.kind, 'bundle', JSON.stringify(outcome))
    assert.ok((await readFile(file)).subarray(0, 2048).toString('latin1').includes(`-${baseOid}`))
    const refsBefore = allRefs(B)
    const response = await collabCall(conn1.connectionId, `projects/p1/push?branch=local-only&oid=${tipOid}`, { method: 'POST', raw: await readFile(file) })
    assert.equal(response.status, 409, JSON.stringify(response.body))
    assert.equal(allRefs(B), refsBefore)
    sh(A, 'checkout', '-q', 'topic')
  })

  await check('声明的提交号与包内容不符：409，且不留下指向包内容的引用', async () => {
    sh(A, 'branch', 'mismatch-topic', 'topic')
    const file = join(work, 'mismatch.bundle')
    const outcome = await gitOps.createBundle(A, 'mismatch-topic', hostTips, file)
    assert.equal(outcome.kind, 'bundle', JSON.stringify(outcome))
    const refsBefore = allRefs(B)
    const response = await collabCall(conn1.connectionId, `projects/p1/push?branch=mismatch-topic&oid=${featureOid2}`, { method: 'POST', raw: await readFile(file) })
    assert.equal(response.status, 409, JSON.stringify(response.body))
    assert.equal(allRefs(B), refsBefore, 'push 失败后 B 的引用发生了变化')
  })

  await check('声明的包长度超过 512MB 上限：直接 413', async () => {
    const status = await declaredOversize(`/remote/v1/peer/collab/projects/p1/push?branch=big&oid=${topicOid}`, conn1.connectionId)
    assert.equal(status, 413)
    assert.equal(shOk(B, 'rev-parse', '--verify', '--quiet', PUSHED_REF('big')), false)
  })

  await check('对方已包含 feature 提交（feature 是 haves 里某提交的祖先）时返回 upToDate，不报错', async () => {
    sh(B, 'checkout', '-q', '-b', 'feature-next', 'feature')
    const nextOid = commitFile(B, 'next.txt', 'next\n', 'feature-next 在 feature 之上')
    sh(B, 'checkout', '-q', 'main')
    const response = await collabCall(conn1.connectionId, 'projects/p1/bundle', { method: 'POST', json: { branch: 'feature', haves: [nextOid] } })
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.ok(response.contentType.includes('json'), response.contentType)
    assert.equal(response.body.data.upToDate, true)
  })

  await check('授权的项目不是 Git 仓库时 409', async () => {
    const response = await collabCall(conn1.connectionId, 'projects/p3/branches')
    assert.equal(response.status, 409)
  })

  await check('只申请 pull：批准即使多给了 push 也被收窄；push / requests 403，branches / bundle 可用', async () => {
    conn2 = await connectPeer(['pull'], ['p1'], ['pull', 'push'])
    assert.deepEqual(conn2.operations, ['pull'])
    await activate(conn2)
    const refsBefore = allRefs(B)
    const incomingBefore = incoming.length
    const push = await collabCall(conn2.connectionId, `projects/p1/push?branch=sneaky&oid=${topicOid}`, { method: 'POST', raw: topicBundle })
    assert.equal(push.status, 403, JSON.stringify(push.body))
    assert.equal(push.body.code, 'peer_operation_denied')
    const known = await collabCall(conn2.connectionId, `projects/p1/push?branch=sneaky&oid=${topicOid}&known=1`, { method: 'POST' })
    assert.equal(known.status, 403)
    const request = await collabCall(conn2.connectionId, 'projects/p1/requests', { method: 'POST', json: { branch: 'topic', oid: topicOid, title: 't', note: '' } })
    assert.equal(request.status, 403)
    assert.equal(allRefs(B), refsBefore)
    assert.equal(incoming.length, incomingBefore)
    assert.equal((await collabCall(conn2.connectionId, 'projects/p1/branches')).status, 200)
    const bundle = await collabCall(conn2.connectionId, 'projects/p1/bundle', { method: 'POST', json: { branch: 'main', haves: [] } })
    assert.equal(bundle.status, 200)
    assert.ok(bundle.contentType.startsWith('application/octet-stream'))
  })

  await check('未开放的项目（p2）和不存在的项目都不可访问：403', async () => {
    for (const connection of [conn1.connectionId, conn2.connectionId]) {
      for (const id of ['p2', 'nope']) {
        const branches = await collabCall(connection, `projects/${id}/branches`)
        assert.equal(branches.status, 403, `branches ${id} 得到 ${branches.status}`)
        assert.equal(branches.body.code, 'peer_project_denied', `branches ${id} 的错误码`)
        const bundle = await collabCall(connection, `projects/${id}/bundle`, { method: 'POST', json: { branch: 'main', haves: [] } })
        assert.equal(bundle.status, 403, `bundle ${id}`)
        const push = await collabCall(connection, `projects/${id}/push?branch=topic&oid=${topicOid}`, { method: 'POST', raw: topicBundle })
        assert.equal(push.status, 403, `push ${id}`)
      }
    }
    assert.equal(shOk(C, 'rev-parse', '--verify', '--quiet', PUSHED_REF('topic')), false)
  })

  await check('collab 路径不存在时 404，方法不对时 404', async () => {
    assert.equal((await collabCall(conn1.connectionId, 'projects/p1/nothing')).status, 404)
    assert.equal((await collabCall(conn1.connectionId, 'projects/p1/branches', { method: 'POST', json: {} })).status, 404)
    assert.equal((await collabCall(conn1.connectionId, 'whatever')).status, 404)
  })

  section('sessions/:sid/export')

  await check('有 pull 时导出成功，未知会话 404，未开放项目的会话 403', async () => {
    const response = await collabCall(conn2.connectionId, 'sessions/s1/export')
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.data.version, 1)
    assert.equal(response.body.data.source.sessionId, 's1')
    assert.equal((await collabCall(conn2.connectionId, 'sessions/zzz/export')).status, 404)
    const other = await collabCall(conn2.connectionId, 'sessions/s-other/export')
    assert.equal(other.status, 403)
    assert.equal(other.body.code, 'peer_project_denied')
  })

  await check('只有 read / transfer、没有 pull 时 collab 导出被拒', async () => {
    const conn3 = await connectPeer(['read', 'transfer'], ['p1'])
    await activate(conn3)
    const response = await collabCall(conn3.connectionId, 'sessions/s1/export')
    assert.equal(response.status, 403)
    assert.equal(response.body.code, 'peer_operation_denied')
    assert.equal((await collabCall(conn3.connectionId, 'projects/p1/branches')).status, 403)
    grants.revoke(conn3.connectionId)
    await wait(30)
    assert.equal((await collabCall(conn3.connectionId, 'sessions/s1/export')).status, 401)
  })

  section('边界：引用名与请求字段')

  await check('slugForRemote 对各种设备名生成的追踪引用都是合法的 git 引用名', async () => {
    const names = [
      DEVICE_NAME, 'a..b', 'x.lock', '.hidden', 'a/b', '电脑', 'A B', 'a.lock-', '-x', 'a@{b}',
      `${'x'.repeat(39)}.y`, `${'x'.repeat(39)}-y`, `${'x'.repeat(34)}.lock.y`, 'ａｂｃ', '', '...', 'foo.lock.bar', 'a~b^c:d?e*f[g'
    ]
    const bad = []
    for (const name of names) {
      const ref = trackingRefFor(slugForRemote(name, 'device-12345678-abcd'), 'topic')
      if (!shOk(root, 'check-ref-format', ref) || gitOps.checkTrackingRef(ref)) bad.push(`${JSON.stringify(name)} → ${ref}`)
    }
    assert.deepEqual(bad, [])
    assert.equal(slugForRemote('Inkstone · Laptop-A', 'abcd'), slugForRemote('Laptop-A', 'abcd'), '新设备名前缀不进追踪引用')
    assert.equal(slugForRemote('砚 · Laptop-A', 'abcd'), slugForRemote('Laptop-A', 'abcd'), '旧设备名前缀同样剥掉')
  })

  await check('requests 的分支名带前后空白时被拒绝（不能把畸形引用写进请求列表）', async () => {
    const incomingBefore = incoming.length
    const statuses = []
    for (const name of [' topic', 'topic ', ' topic ']) {
      const response = await collabCall(conn1.connectionId, 'projects/p1/requests', { method: 'POST', json: { branch: name, oid: topicOid, title: 't', note: '' } })
      statuses.push(response.status)
    }
    assert.deepEqual(statuses, [400, 400, 400])
    assert.equal(incoming.length, incomingBefore)
  })

  await check('所有者撤销连接后 collab 立即 401', async () => {
    grants.revoke(conn2.connectionId)
    await wait(30)
    assert.equal((await collabCall(conn2.connectionId, 'projects/p1/branches')).status, 401)
  })

  section('CollabService：本机侧编排')

  const PEER_ID = 'peer-b'
  const REMOTE = 'yan-b-peerb'
  const svcState = join(svcDir, 'collab-state.json')
  const svcTemp = join(svcDir, 'tmp')
  const svcImports = join(svcDir, 'imports')
  const svcWorktrees = join(svcDir, 'worktrees')
  const transportLog = []
  const importCalls = []
  const notified = []
  const failImport = new Set()
  let failRequests = false
  let svcGrant = null
  let svcConnection = { state: 'idle' }
  let svcPeerKnown = true
  let svcFeatureOid = ''
  let svcTracking = ''
  let service = null
  let fetchResult = null
  let outgoingRequestId = ''
  let pushedOid = ''
  let chineseOid = ''

  const connectionId = () => (svcConnection.state === 'connected' ? svcConnection.grant.connectionId : null)
  const authHeaders = () => ({ authorization: `Bearer ${peerToken}`, ...(connectionId() ? { 'x-yan-connection': connectionId() } : {}) })
  const failureOf = async (response) => {
    const body = await response.json().catch(() => ({}))
    return { ok: false, error: body.error ?? `请求失败（HTTP ${response.status}）`, ...(body.code ? { code: body.code } : {}) }
  }
  const transport = {
    async call(_peerId, path, init = {}) {
      transportLog.push({ kind: 'call', path, method: init.method ?? 'GET' })
      if (failRequests && path.endsWith('/requests')) return { ok: false, error: '模拟的网络故障' }
      const response = await fetch(base + path, {
        method: init.method ?? 'GET',
        headers: { ...authHeaders(), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.ok) return { ok: false, error: body.error ?? `请求失败（HTTP ${response.status}）`, ...(body.code ? { code: body.code } : {}) }
      return { ok: true, data: body.data }
    },
    async download(_peerId, path, body, file) {
      transportLog.push({ kind: 'download', path })
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!response.ok) return failureOf(response)
      if ((response.headers.get('content-type') ?? '').includes('application/json')) {
        const parsed = await response.json()
        return parsed.ok ? { ok: true, data: { kind: 'json', data: parsed.data } } : { ok: false, error: parsed.error ?? '对方返回失败' }
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      await writeFile(file, buffer)
      return { ok: true, data: { kind: 'file', bytes: buffer.length } }
    },
    async upload(_peerId, path, file) {
      transportLog.push({ kind: 'upload', path, hadFile: file !== null })
      const body = file ? await readFile(file) : undefined
      const response = await fetch(base + path, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/octet-stream' },
        body
      })
      if (!response.ok) return failureOf(response)
      const parsed = await response.json()
      return parsed.ok ? { ok: true, data: parsed.data } : { ok: false, error: parsed.error ?? '对方返回失败' }
    }
  }
  const lastUpload = () => [...transportLog].reverse().find((entry) => entry.kind === 'upload')
  const readState = async () => JSON.parse(await readFile(svcState, 'utf8'))
  const makeService = (stateFile, projects, overrides = {}) =>
    new CollabService({
      stateFile,
      tempDir: svcTemp,
      transport,
      peerStatus: async () => ({
        peers: svcPeerKnown
          ? [{ id: PEER_ID, computer: 'B 电脑', address: base, pairedAt: 1, connection: svcConnection }]
          : [],
        imports: []
      }),
      localProjects: async () => projects ?? [
        { id: 'decoy', name: '无关项目', cwd: C },
        { id: 'local-a', name: 'A 仓库', cwd: SC }
      ],
      importSession: async (peerId, sessionId) => {
        importCalls.push({ peerId, sessionId })
        if (failImport.has(sessionId)) return { ok: false, error: '模拟的导入失败' }
        const title = serviceSessions.find((item) => item.id === sessionId)?.title ?? sessionId
        return {
          ok: true,
          data: {
            id: `import-${importCalls.length}`,
            kind: 'session',
            title,
            computer: 'B 电脑',
            projectName: '服务项目',
            sourceSessionId: sessionId,
            importedAt: 1,
            exportedAt: 1,
            messageCount: 0,
            artifacts: []
          }
        }
      },
      readImportDir: async (importId) => {
        const dir = join(svcImports, importId)
        await mkdir(dir, { recursive: true })
        return dir
      },
      createWorktree: async ({ cwd, branch, startPoint }) => {
        const path = join(svcWorktrees, branch.replace(/\//g, '__'))
        try {
          sh(cwd, 'worktree', 'add', '-q', '-b', branch, path, startPoint)
          return { ok: true, path, branch }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
      notifyIncoming: (request) => {
        notified.push(request)
      },
      ...overrides
    })

  await check('准备：服务专用仓库、授权连接、transport 与 CollabService', async () => {
    sh(root, 'init', '-q', '-b', 'main', SH)
    identify(SH, 'Sam')
    commitFile(SH, 'a.txt', 'alpha\nbeta\ngamma\n', '服务初始提交')
    sh(SH, 'checkout', '-q', '-b', 'feature')
    commitFile(SH, 'f.txt', 'f1\n', '服务 feature 1')
    sh(SH, 'checkout', '-q', 'main')
    sh(root, 'clone', '-q', SH, SC)
    identify(SC, 'Sue')
    sh(SH, 'checkout', '-q', 'feature')
    svcFeatureOid = commitFile(SH, 'f.txt', 'f2\n', '服务 feature 2')
    sh(SH, 'checkout', '-q', 'main')
    svcGrant = await connectPeer(['pull', 'push'], ['p4'])
    await activate(svcGrant)
    svcConnection = { state: 'connected', grant: svcGrant }
    svcTracking = trackingRefFor(REMOTE, 'feature')
    service = makeService(svcState)
    assert.equal(svcTracking, 'refs/remotes/yan-b-peerb/feature')
  })

  await check('remoteProject（未 link）：按根提交推荐本地项目，分支带追踪引用且还没有拉取记录', async () => {
    const view = await service.remoteProject(PEER_ID, 'p4')
    assert.equal(view.ok, true, view.error)
    assert.deepEqual(view.data.project, { id: 'p4', name: '服务项目' })
    assert.equal(view.data.peerId, PEER_ID)
    assert.equal(view.data.grant.connectionId, svcGrant.connectionId)
    assert.equal(view.data.localProjectId, null)
    assert.equal(view.data.suggestedLocalProjectId, 'local-a')
    assert.deepEqual(view.data.branches.map((b) => b.name).sort(), ['feature', 'main'])
    for (const branch of view.data.branches) {
      assert.equal(branch.trackingRef, trackingRefFor(REMOTE, branch.name))
      assert.equal(branch.fetchedOid, null)
      assert.equal(branch.incoming, null)
      assert.equal(branch.outgoing, null)
    }
    assert.equal(view.data.branches.find((b) => b.name === 'feature').oid, svcFeatureOid)
  })

  await check('remoteProject / fetch 的前置检查：未知设备、未开放项目、未 link', async () => {
    const unknownPeer = await service.remoteProject('peer-x', 'p4')
    assert.equal(unknownPeer.ok, false)
    assert.match(unknownPeer.error, /找不到这台砚/)
    const notOffered = await service.remoteProject(PEER_ID, 'p1')
    assert.equal(notOffered.ok, false)
    assert.match(notOffered.error, /没有向本次连接开放/)
    const unlinked = await service.fetch(PEER_ID, 'p4', 'feature')
    assert.equal(unlinked.ok, false)
    assert.match(unlinked.error, /先选择对应的本地项目/)
    assert.equal(importCalls.length, 0)
    assert.equal(shOk(SC, 'rev-parse', '--verify', '--quiet', svcTracking), false)
  })

  await check('link：未知本地项目被拒；link 后 remoteProject 返回 localProjectId，overview 反映本地仓库状态', async () => {
    const bad = await service.link(PEER_ID, 'p4', 'nope')
    assert.equal(bad.ok, false)
    const linked = await service.link(PEER_ID, 'p4', 'local-a')
    assert.equal(linked.ok, true, linked.error)
    assert.deepEqual(linked.data, [{ peerId: PEER_ID, remoteProjectId: 'p4', localProjectId: 'local-a' }])
    const view = await service.remoteProject(PEER_ID, 'p4')
    assert.equal(view.data.localProjectId, 'local-a')
    const feature = view.data.branches.find((b) => b.name === 'feature')
    assert.equal(feature.trackingRef, svcTracking)
    assert.equal(feature.fetchedOid, null)
    assert.equal(feature.incoming, null)
    const overview = await service.overview()
    assert.equal(overview.peers[0].remoteName, REMOTE)
    assert.equal(overview.peers[0].computer, 'B 电脑')
    assert.deepEqual(overview.links, linked.data)
    const local = overview.localProjects.find((item) => item.id === 'local-a')
    assert.equal(local.isRepo, true)
    assert.equal(local.currentBranch, 'main')
    assert.deepEqual(local.branches, ['main'])
    assert.equal(local.mergeInProgress, false)
  })

  await check('fetch 参数检查：非法分支名与对方没有的分支', async () => {
    const bad = await service.fetch(PEER_ID, 'p4', '../x')
    assert.equal(bad.ok, false)
    const missing = await service.fetch(PEER_ID, 'p4', 'no-such-branch')
    assert.equal(missing.ok, false)
    assert.match(missing.error, /对方没有分支/)
    assert.equal(importCalls.length, 0)
  })

  await check('fetch feature：追踪引用指向 B 的 feature，incoming ≥ 1，关联会话都被导入', async () => {
    const result = await service.fetch(PEER_ID, 'p4', 'feature')
    assert.equal(result.ok, true, result.error)
    fetchResult = result.data
    assert.equal(result.data.trackingRef, svcTracking)
    assert.equal(result.data.oid, svcFeatureOid)
    assert.equal(result.data.upToDate, false)
    assert.ok(result.data.incoming >= 1, `incoming=${result.data.incoming}`)
    assert.equal(result.data.outgoing, 0)
    assert.equal(sh(SC, 'rev-parse', svcTracking), sh(SH, 'rev-parse', 'refs/heads/feature'))
    assert.deepEqual(importCalls, [
      { peerId: PEER_ID, sessionId: 's4' },
      { peerId: PEER_ID, sessionId: 's5' }
    ])
    assert.deepEqual(result.data.imported.map((item) => item.title), ['服务会话', '另一个会话'])
    assert.deepEqual(result.data.importErrors, [])
    const bundleCall = transportLog.filter((entry) => entry.kind === 'download').pop()
    assert.ok(bundleCall.path.endsWith('/projects/p4/bundle'), bundleCall.path)
  })

  await check('fetch 之后：状态文件记录拉取与会话导入，remoteProject 带出 fetchedOid 与 incoming，临时包被删除', async () => {
    const state = await readState()
    assert.equal(state.version, 1)
    assert.equal(state.fetched.length, 1)
    const record = state.fetched[0]
    assert.equal(record.peerId, PEER_ID)
    assert.equal(record.remoteProjectId, 'p4')
    assert.equal(record.localProjectId, 'local-a')
    assert.equal(record.branch, 'feature')
    assert.equal(record.trackingRef, svcTracking)
    assert.equal(record.oid, svcFeatureOid)
    assert.deepEqual(record.importIds, fetchResult.imported.map((item) => item.importId))
    assert.deepEqual(state.sessionImports.map((item) => [item.sessionId, item.branch]), [['s4', 'feature'], ['s5', 'feature']])
    const view = await service.remoteProject(PEER_ID, 'p4')
    const feature = view.data.branches.find((b) => b.name === 'feature')
    assert.equal(feature.fetchedOid, svcFeatureOid)
    assert.equal(feature.incoming, fetchResult.incoming)
    assert.equal(feature.outgoing, 0)
    assert.deepEqual(existsSync(svcTemp) ? await readdir(svcTemp) : [], [])
  })

  await check('再次 fetch（对方没有新提交）：upToDate=true，追踪引用不变，不重复导入会话，拉取记录不重复', async () => {
    const before = importCalls.length
    const result = await service.fetch(PEER_ID, 'p4', 'feature')
    assert.equal(result.ok, true, result.error)
    assert.equal(result.data.upToDate, true)
    assert.equal(result.data.oid, svcFeatureOid)
    assert.equal(sh(SC, 'rev-parse', svcTracking), svcFeatureOid)
    assert.equal(importCalls.length, before)
    assert.deepEqual(result.data.imported.map((item) => item.importId), fetchResult.imported.map((item) => item.importId))
    const state = await readState()
    assert.equal(state.fetched.length, 1)
    assert.equal(state.sessionImports.length, 2)
    assert.deepEqual(existsSync(svcTemp) ? await readdir(svcTemp) : [], [])
  })

  await check('会话在对方有更新时只重新导入变化的那一个；导入失败会进入 importErrors 而不影响拉取', async () => {
    const before = importCalls.length
    serviceSessions[0].updatedAt += 5000
    const refreshed = await service.fetch(PEER_ID, 'p4', 'feature')
    assert.equal(refreshed.ok, true, refreshed.error)
    assert.deepEqual(importCalls.slice(before), [{ peerId: PEER_ID, sessionId: 's4' }])
    assert.equal(refreshed.data.imported.length, 2)
    failImport.add('s5')
    serviceSessions[1].updatedAt += 5000
    const failing = await service.fetch(PEER_ID, 'p4', 'feature')
    failImport.clear()
    assert.equal(failing.ok, true, failing.error)
    assert.equal(failing.data.importErrors.length, 1)
    assert.match(failing.data.importErrors[0], /另一个会话.*模拟的导入失败/)
    assert.deepEqual(failing.data.imported.map((item) => item.title), ['服务会话'])
    assert.equal(sh(SC, 'rev-parse', svcTracking), svcFeatureOid)
    const retried = await service.fetch(PEER_ID, 'p4', 'feature')
    assert.equal(retried.data.importErrors.length, 0)
    assert.equal(retried.data.imported.length, 2)
  })

  await check('compare / fileDiff：基于本地仓库对比追踪引用，拒绝本地分支引用与未知项目', async () => {
    const result = await service.compare('local-a', svcTracking)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.data.incoming, fetchResult.incoming)
    assert.equal(result.data.commits[0].oid, svcFeatureOid)
    assert.deepEqual(result.data.files.map((f) => f.path), ['f.txt'])
    const diff = await service.fileDiff('local-a', svcTracking, 'f.txt')
    assert.equal(diff.ok, true, diff.error)
    assert.ok(diff.data.includes('+f2'), diff.data)
    assert.equal((await service.compare('local-a', 'refs/heads/main')).ok, false)
    assert.equal((await service.compare('nope', svcTracking)).ok, false)
    assert.equal((await service.fileDiff('local-a', 'refs/heads/main', 'f.txt')).ok, false)
  })

  await check('receiveRequest：同一分支的旧请求保留为 closed 以供离线对账，并通知本机界面', async () => {
    const make = (id, createdAt) => ({
      id,
      direction: 'incoming',
      peerName: 'B 电脑',
      peerId: PEER_ID,
      localProjectId: 'local-a',
      projectName: '服务项目',
      branch: 'feature',
      trackingRef: svcTracking,
      oid: svcFeatureOid,
      title: `请求 ${id}`,
      note: '',
      createdAt,
      status: 'open'
    })
    await service.receiveRequest(make('mr-manual-0', 1000))
    await service.receiveRequest(make('mr-manual-1', 2000))
    assert.deepEqual(notified.map((item) => item.id), ['mr-manual-0', 'mr-manual-1'])
    const requests = (await service.overview()).requests
    assert.deepEqual(requests.map((item) => item.id), ['mr-manual-1', 'mr-manual-0'])
    assert.equal(requests.find((item) => item.id === 'mr-manual-0').status, 'closed')
  })

  await check('merge 带 requestId：合并成功后状态文件里该请求变 merged；没有 requestId 的合并不改请求', async () => {
    const headBefore = sh(SC, 'rev-parse', 'HEAD')
    const result = await service.merge('local-a', svcTracking, 'mr-manual-1')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.merged, true)
    assert.notEqual(sh(SC, 'rev-parse', 'HEAD'), headBefore)
    assert.equal(sh(SC, 'rev-parse', 'HEAD'), svcFeatureOid)
    assert.equal(sh(SC, 'log', '-1', '--format=%s'), '服务 feature 2')
    const state = await readState()
    assert.equal(state.requests.find((item) => item.id === 'mr-manual-1').status, 'merged')
    const again = await service.merge('local-a', svcTracking)
    assert.equal(again.ok, true)
    assert.equal(again.merged, false)
    assert.equal((await readState()).requests.find((item) => item.id === 'mr-manual-1').status, 'merged')
    assert.equal((await service.merge('nope', svcTracking)).ok, false)
  })

  await check('合并请求不能借用其他项目、引用或更新后的提交；状态保存故障不冒充 Git 失败', async () => {
    const path = join(svcDir, 'save-failure.json')
    const isolated = makeService(path)
    await isolated.receiveRequest({ id: 'mr-save-failure', direction: 'incoming', peerName: 'B', localProjectId: 'local-a', projectName: 'A', branch: 'feature', trackingRef: svcTracking, oid: svcFeatureOid, title: '保存故障', note: '', createdAt: 1, status: 'open' })
    assert.equal((await isolated.merge('decoy', svcTracking, 'mr-save-failure')).ok, false)
    assert.equal((await isolated.merge('local-a', 'refs/remotes/wrong/feature', 'mr-save-failure')).ok, false)
    assert.equal((await isolated.merge('local-a', svcTracking, 'mr-nope')).ok, false)
    await rm(path)
    await mkdir(path)
    const result = await isolated.merge('local-a', svcTracking, 'mr-save-failure')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.message, /Git merge succeeded.*could not be saved/)
  })

  await check('merge 冲突：返回 conflicts，请求保持 open，overview 显示合并进行中，abortMerge 后恢复', async () => {
    sh(SH, 'checkout', '-q', 'feature')
    commitFile(SH, 'a.txt', 'alpha\nbeta from SH\ngamma\n', 'SH 改 beta')
    sh(SH, 'checkout', '-q', 'main')
    commitFile(SC, 'a.txt', 'alpha\nbeta from SC\ngamma\n', 'SC 改 beta')
    const pulled = await service.fetch(PEER_ID, 'p4', 'feature')
    assert.equal(pulled.ok, true, pulled.error)
    assert.equal(pulled.data.upToDate, false)
    await service.receiveRequest({
      id: 'mr-manual-2',
      direction: 'incoming',
      peerName: 'B 电脑',
      peerId: PEER_ID,
      localProjectId: 'local-a',
      projectName: '服务项目',
      branch: 'feature',
      trackingRef: svcTracking,
      oid: pulled.data.oid,
      title: '会冲突的请求',
      note: '',
      createdAt: 3000,
      status: 'open'
    })
    const result = await service.merge('local-a', svcTracking, 'mr-manual-2')
    assert.equal(result.ok, false)
    assert.deepEqual(result.conflicts, ['a.txt'])
    assert.equal((await readState()).requests.find((item) => item.id === 'mr-manual-2').status, 'open')
    const local = (await service.overview()).localProjects.find((item) => item.id === 'local-a')
    assert.equal(local.mergeInProgress, true)
    const aborted = await service.abortMerge('local-a')
    assert.equal(aborted.ok, true, aborted.error)
    assert.equal((await service.overview()).localProjects.find((item) => item.id === 'local-a').mergeInProgress, false)
    assert.equal(sh(SC, 'status', '--porcelain'), '')
    assert.equal((await service.abortMerge('local-a')).ok, false)
    assert.equal((await service.abortMerge('nope')).ok, false)
  })

  section('协作渲染端文案：推送提示与 Git 身份错误')
  await check('推送成功提示只带分支名，不暴露内部追踪 ref', async () => {
    const zh = collabTextMod.collabText('zh-CN')
    const en = collabTextMod.collabText('en-US')
    for (const text of [zh, en]) {
      assert.equal(text.pushed.includes('{ref}'), false, text.pushed)
      assert.equal(text.pushedWithRequest.includes('{ref}'), false, text.pushedWithRequest)
      assert.ok(text.pushed.includes('{branch}'), text.pushed)
      assert.ok(text.pushedWithRequest.includes('{branch}'), text.pushedWithRequest)
    }
    assert.equal(collabTextMod.fill(zh.pushed, { computer: 'B 电脑', branch: 'feature' }), '已推送到 B 电脑 的分支 feature')
    assert.equal(collabTextMod.fill(en.pushed, { computer: 'B', branch: 'feature' }), 'Pushed to B on branch feature')
  })

  await check('合并缺少 Git 身份时给出 git config 指引，而不是回显 Git 原文', async () => {
    for (const lang of ['zh-CN', 'en-US']) {
      const text = collabTextMod.collabText(lang)
      assert.match(text.mergeIdentityMissing, /git config --global user\.name/)
      assert.match(text.mergeIdentityMissing, /git config --global user\.email/)
    }
  })

  await check('工作区不干净时合并被拒：渲染端按语言给出文案，不显示主进程原文', async () => {
    const zh = collabTextMod.collabText('zh-CN')
    const en = collabTextMod.collabText('en-US')
    assert.match(zh.mergeDirty, /未提交/)
    assert.match(en.mergeDirty, /uncommitted/)
    assert.doesNotMatch(en.mergeDirty, /[\u4e00-\u9fff]/, '英文界面不出现中文')
  })

  await check('对方结束连接的状态文案：两种语言都有，英文界面不出现中文', async () => {
    const zh = collabTextMod.collabText('zh-CN')
    const en = collabTextMod.collabText('en-US')
    assert.equal(zh.stateEnded, '对方已结束连接')
    assert.doesNotMatch(en.stateEnded, /[\u4e00-\u9fff]/)
    assert.ok(en.stateEnded.length > 0)
  })

  section('git merge：能快进就快进，需要合并提交时先检查 Git 身份')
  await check('mergeRef 能快进时直接快进，不生成合并提交', async () => {
    const repo = join(root, 'merge-ff')
    sh(root, 'init', '-q', '-b', 'main', repo)
    identify(repo, 'Fay')
    const base = commitFile(repo, 'a.txt', 'a\n', 'base')
    sh(repo, 'checkout', '-q', '-b', 'feature')
    const tip = commitFile(repo, 'b.txt', 'b\n', 'feature tip')
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'update-ref', 'refs/remotes/peer/feature', tip)
    const result = await gitOps.mergeRef(repo, 'refs/remotes/peer/feature', 'Merge peer/feature')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.merged, true)
    assert.equal(result.head, tip)
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), tip)
    assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'feature tip')
    assert.notEqual(base, tip)
    const again = await gitOps.mergeRef(repo, 'refs/remotes/peer/feature', 'Merge peer/feature')
    assert.equal(again.ok, true, JSON.stringify(again))
    assert.equal(again.merged, false)
  })

  await check('mergeRef 分叉时生成合并提交，提交说明是英文中性文本', async () => {
    const repo = join(root, 'merge-nonff')
    sh(root, 'init', '-q', '-b', 'main', repo)
    identify(repo, 'Mo')
    commitFile(repo, 'a.txt', 'a\n', 'base')
    sh(repo, 'checkout', '-q', '-b', 'feature')
    const tip = commitFile(repo, 'b.txt', 'b\n', 'feature tip')
    sh(repo, 'checkout', '-q', 'main')
    commitFile(repo, 'c.txt', 'c\n', 'main tip')
    sh(repo, 'update-ref', 'refs/remotes/peer/feature', tip)
    const result = await gitOps.mergeRef(repo, 'refs/remotes/peer/feature', 'Merge peer/feature')
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.merged, true)
    assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'Merge peer/feature')
    assert.equal(sh(repo, 'rev-list', '--parents', '-1', 'HEAD').trim().split(' ').length, 3, '合并提交应有两个父提交')
  })

  await check('mergeRef 需要合并提交但本机没有 Git 身份：返回 git-identity-missing，不动工作区', async () => {
    const repo = join(root, 'merge-no-identity')
    sh(root, 'init', '-q', '-b', 'main', repo)
    const commitAs = (dir, name, content, message) => {
      writeFileSync(join(dir, name), content)
      sh(dir, 'add', '--', name)
      sh(dir, '-c', 'user.name=NoId', '-c', 'user.email=noid@example.test', 'commit', '-q', '-m', message)
      return sh(dir, 'rev-parse', 'HEAD')
    }
    commitAs(repo, 'a.txt', 'a\n', 'base')
    sh(repo, 'checkout', '-q', '-b', 'feature')
    const tip = commitAs(repo, 'b.txt', 'b\n', 'feature tip')
    sh(repo, 'checkout', '-q', 'main')
    const mainTip = commitAs(repo, 'c.txt', 'c\n', 'main tip')
    sh(repo, 'update-ref', 'refs/remotes/peer/feature', tip)
    assert.equal(shOk(repo, 'config', '--get', 'user.email'), false, '夹具里不应有 Git 提交身份')
    const result = await gitOps.mergeRef(repo, 'refs/remotes/peer/feature', 'Merge peer/feature')
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'git-identity-missing')
    assert.match(result.error, /user\.name|user\.email/)
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), mainTip)
    assert.equal(existsSync(join(repo, '.git', 'MERGE_HEAD')), false)
    assert.equal(sh(repo, 'status', '--porcelain'), '')
    assert.equal((await gitOps.mergeInProgress(repo)), false)
  })

  await check('push 新分支并带合并请求：B 收到 incoming 请求，A 的状态里有 outgoing 请求', async () => {
    sh(SC, 'checkout', '-q', '-b', 'service-topic', 'main')
    pushedOid = commitFile(SC, 'topic.txt', 'service topic\n', 'service-topic 提交')
    sh(SC, 'checkout', '-q', 'main')
    const hostBefore = incoming.length
    const result = await service.push({
      peerId: PEER_ID,
      remoteProjectId: 'p4',
      localProjectId: 'local-a',
      branch: 'service-topic',
      request: { title: '  服务请求  ', note: '请合并' }
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.data.trackingRef, PUSHED_REF('service-topic'))
    assert.ok(result.data.requestId.startsWith('mr-'))
    outgoingRequestId = result.data.requestId
    assert.equal(sh(SH, 'rev-parse', PUSHED_REF('service-topic')), pushedOid)
    assert.equal(lastUpload().hadFile, true)
    assert.ok(!lastUpload().path.includes('known=1'))
    const received = incoming.slice(hostBefore)
    assert.equal(received.length, 1)
    assert.equal(received[0].direction, 'incoming')
    assert.equal(received[0].peerDeviceId, peerDeviceId)
    assert.equal(received[0].id, outgoingRequestId)
    assert.equal(received[0].localProjectId, 'p4')
    assert.equal(received[0].trackingRef, PUSHED_REF('service-topic'))
    assert.equal(received[0].oid, pushedOid)
    assert.equal(received[0].title, '服务请求')
    const outgoing = (await service.overview()).requests.find((item) => item.id === outgoingRequestId)
    assert.equal(outgoing.direction, 'outgoing')
    assert.equal(outgoing.peerId, PEER_ID)
    assert.equal(outgoing.remoteProjectId, 'p4')
    assert.equal(outgoing.peerName, 'B 电脑')
    assert.equal(outgoing.localProjectId, 'local-a')
    assert.equal(outgoing.projectName, '服务项目')
    assert.equal(outgoing.branch, 'service-topic')
    assert.equal(outgoing.trackingRef, PUSHED_REF('service-topic'))
    assert.equal(outgoing.oid, pushedOid)
    assert.equal(outgoing.title, '服务请求')
    assert.equal(outgoing.note, '请合并')
    assert.equal(outgoing.status, 'open')
    assert.deepEqual(existsSync(svcTemp) ? await readdir(svcTemp) : [], [])
  })

  await check('200 条 open 请求每批最多并发 4 条，刷新节流且轮转；跨 update 只更新匹配归属的快照', async () => {
    const path = join(svcDir, 'bounded-reconcile.json')
    const template = (await readState()).requests.find((item) => item.id === outgoingRequestId)
    const requests = Array.from({ length: 200 }, (_, index) => ({ ...template, id: `bounded-${index}` }))
    await writeFile(path, JSON.stringify({ version: 1, links: [], requests, fetched: [], sessionImports: [] }))
    let clock = 100_000
    let active = 0
    let peak = 0
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const calls = []
    const batched = makeService(path, [], {
      now: () => clock,
      transport: {
        async call(peerId, url, init) {
          const id = decodeURIComponent(url.split('/').at(-1))
          calls.push(id)
          active += 1
          peak = Math.max(peak, active)
          try {
            assert.equal(peerId, PEER_ID)
            assert.equal(init.timeoutMs, 3000)
            await gate
            return { ok: true, data: { requestId: id, projectId: 'p4', branch: template.branch, oid: template.oid, status: id === 'bounded-0' || id === 'bounded-1' || id === 'bounded-2' || id === 'bounded-3' ? 'merged' : 'open' } }
          } finally {
            active -= 1
          }
        }
      }
    })
    const first = batched.overview()
    const simultaneous = batched.overview()
    try {
      for (let tries = 0; tries < 100 && calls.length < 4; tries++) await wait(5)
      assert.equal(calls.length, 4)
      assert.equal(active, 4)
      await batched.link(PEER_ID, 'p4', null)
      await batched.update((draft) => {
        draft.requests = draft.requests.map((item) => ({ ...item }))
        draft.requests.find((item) => item.id === 'bounded-1').branch = 'changed-branch'
        draft.requests.find((item) => item.id === 'bounded-1').remoteProjectId = 'other-project'
        draft.requests.find((item) => item.id === 'bounded-2').peerId = 'other-peer'
      })
      assert.equal((await batched.closeRequest('bounded-3')).ok, true)
    } finally {
      release()
      await Promise.all([first, simultaneous])
    }
    const view = await batched.overview()
    assert.equal(view.requests.find((item) => item.id === 'bounded-0').status, 'merged')
    assert.equal(view.requests.find((item) => item.id === 'bounded-1').status, 'open')
    assert.equal(view.requests.find((item) => item.id === 'bounded-2').status, 'open')
    assert.equal(view.requests.find((item) => item.id === 'bounded-3').status, 'closed')
    assert.equal(calls.length, 4)
    clock += 4999
    await batched.overview()
    assert.equal(calls.length, 4)
    clock += 1
    await batched.overview()
    assert.deepEqual(calls, Array.from({ length: 8 }, (_, index) => `bounded-${index}`))
    await batched.overview()
    assert.equal(calls.length, 8)
    assert.equal(peak, 4)
  })

  await check('少量 open 请求成功与失败均冷却 30 秒，冷却后可重试', async () => {
    const path = join(svcDir, 'cooldown-reconcile.json')
    const template = (await readState()).requests.find((item) => item.id === outgoingRequestId)
    const requests = [template, { ...template, id: 'cooldown-error' }, { ...template, id: 'cooldown-throw' }]
    await writeFile(path, JSON.stringify({ version: 1, links: [], requests, fetched: [], sessionImports: [] }))
    let clock = 100_000
    let calls = 0
    const cooled = makeService(path, [], {
      now: () => clock,
      transport: {
        async call(_peerId, url) {
          calls += 1
          if (url.endsWith('cooldown-error')) return { ok: false, error: 'HTTP 404' }
          if (url.endsWith('cooldown-throw')) throw new Error('离线')
          return { ok: true, data: { requestId: template.id, projectId: 'p4', branch: template.branch, oid: template.oid, status: 'open' } }
        }
      }
    })
    await cooled.overview()
    assert.equal(calls, 3)
    for (const advance of [0, 5000, 5000, 19_999]) {
      clock += advance
      await cooled.overview()
      assert.equal(calls, 3)
    }
    clock += 1
    await cooled.overview()
    assert.equal(calls, 6)
  })

  await check('请求状态读取严格核对认证、授权、项目、设备、请求，拒绝远程改写', async () => {
    const path = `projects/p4/requests/${outgoingRequestId}`
    assert.equal((await collabCall(svcGrant.connectionId, path)).body.data.status, 'open')
    assert.equal((await collabCall(svcGrant.connectionId, path, { token: '' })).status, 401)
    assert.equal((await collabCall(null, path)).status, 401)
    assert.equal((await collabCall(conn1.connectionId, path)).status, 403)
    assert.equal((await collabCall(conn1.connectionId, `projects/p1/requests/${outgoingRequestId}`)).status, 404)
    assert.equal((await collabCall(svcGrant.connectionId, path, { token: phoneToken })).status, 403)
    assert.equal((await collabCall(svcGrant.connectionId, `projects/p4/requests/nope`)).status, 404)
    assert.equal((await collabCall(svcGrant.connectionId, path, { method: 'POST', json: { status: 'merged' } })).status, 404)
    const request = incoming.find((item) => item.id === outgoingRequestId)
    const savedDevice = request.peerDeviceId
    request.peerDeviceId = 'other-device'
    await writeFile(join(root, 'host-state.json'), JSON.stringify({ version: 1, requests: incoming }))
    assert.equal((await collabCall(svcGrant.connectionId, path)).status, 404)
    delete request.peerDeviceId
    await writeFile(join(root, 'host-state.json'), JSON.stringify({ version: 1, requests: incoming }))
    assert.equal((await collabCall(svcGrant.connectionId, path)).status, 404)
    request.peerDeviceId = savedDevice
    await writeFile(join(root, 'host-state.json'), JSON.stringify({ version: 1, requests: incoming }))
    const pullOnly = await connectPeer(['pull'], ['p4'])
    await activate(pullOnly)
    assert.equal((await collabCall(pullOnly.connectionId, path)).status, 403)
  })

  await check('merged / closed 离线不丢失，重启后 overview 重新对账；旧对端与伪造响应不改状态', async () => {
    const request = incoming.find((item) => item.id === outgoingRequestId)
    const originalCall = transport.call
    for (const terminal of ['merged', 'closed']) {
      request.status = 'open'
      await writeFile(join(root, 'host-state.json'), JSON.stringify({ version: 1, requests: incoming }))
      const recipient = makeService(join(root, 'host-state.json'), [{ id: 'p4', name: '服务项目', cwd: SH }])
      const handled = terminal === 'merged' ? await recipient.merge('p4', request.trackingRef, request.id) : await recipient.closeRequest(request.id)
      assert.equal(handled.ok, true, JSON.stringify(handled))
      assert.equal(JSON.parse(await readFile(join(root, 'host-state.json'), 'utf8')).requests.find((item) => item.id === request.id).status, terminal)
      const state = await readState()
      state.requests.find((item) => item.id === outgoingRequestId).status = 'open'
      await writeFile(svcState, JSON.stringify(state))
      let clock = 100_000
      let reloaded = makeService(svcState, undefined, { now: () => clock })
      const refresh = () => {
        clock += 30_000
        return reloaded.overview()
      }
      const originalConnection = svcConnection
      svcConnection = { state: 'idle' }
      assert.equal((await refresh()).requests.find((item) => item.id === outgoingRequestId).status, 'open')
      svcConnection = originalConnection
      transport.call = async (...args) => args[1].includes('/requests/') ? { ok: false, error: '旧对端 HTTP 404' } : originalCall(...args)
      assert.equal((await refresh()).requests.find((item) => item.id === outgoingRequestId).status, 'open')
      transport.call = async (...args) => {
        if (!args[1].includes('/requests/')) return originalCall(...args)
        throw new Error('网络断开')
      }
      assert.equal((await refresh()).requests.find((item) => item.id === outgoingRequestId).status, 'open')
      for (const mismatch of [{ projectId: 'wrong-project' }, { requestId: 'other-request' }, { branch: 'other-branch' }, { oid: '0'.repeat(40) }, { status: 'invalid' }]) {
        transport.call = async (...args) => args[1].includes('/requests/') ? { ok: true, data: { requestId: outgoingRequestId, projectId: 'p4', branch: request.branch, oid: request.oid, status: terminal, ...mismatch } } : originalCall(...args)
        assert.equal((await refresh()).requests.find((item) => item.id === outgoingRequestId).status, 'open')
      }
      transport.call = originalCall
      reloaded = makeService(svcState)
      assert.equal((await refresh()).requests.find((item) => item.id === outgoingRequestId).status, terminal)
      assert.equal((await readState()).requests.find((item) => item.id === outgoingRequestId).status, terminal)
    }
    request.status = 'open'
    await writeFile(join(root, 'host-state.json'), JSON.stringify({ version: 1, requests: incoming }))
    const state = await readState()
    state.requests.find((item) => item.id === outgoingRequestId).status = 'open'
    await writeFile(svcState, JSON.stringify(state))
    service = makeService(svcState)
    const legacyPath = join(svcDir, 'legacy-state.json')
    const legacy = structuredClone(state)
    delete legacy.requests.find((item) => item.id === outgoingRequestId).remoteProjectId
    await writeFile(legacyPath, JSON.stringify(legacy))
    const before = transportLog.length
    assert.equal((await makeService(legacyPath).overview()).requests.find((item) => item.id === outgoingRequestId).status, 'open')
    assert.equal(transportLog.length, before)
  })

  await check('push 同一提交第二次：走 known=1（不上传包），成功且不带请求时 requestId 为 null', async () => {
    const hostBefore = incoming.length
    const refsBefore = allRefs(SH)
    const result = await service.push({ peerId: PEER_ID, remoteProjectId: 'p4', localProjectId: 'local-a', branch: 'service-topic' })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.data.requestId, null)
    assert.equal(result.data.trackingRef, PUSHED_REF('service-topic'))
    assert.equal(lastUpload().hadFile, false)
    assert.ok(lastUpload().path.includes('known=1'), lastUpload().path)
    assert.equal(incoming.length, hostBefore)
    assert.equal(allRefs(SH), refsBefore)
  })

  await check('push 的失败路径：没有 push 授权、本地没有该分支、非法分支名、请求发送失败（分支已推送但提示）', async () => {
    const original = svcConnection
    svcConnection = { state: 'connected', grant: { ...svcGrant, operations: ['pull'] } }
    const noPush = await service.push({ peerId: PEER_ID, remoteProjectId: 'p4', localProjectId: 'local-a', branch: 'service-topic' })
    svcConnection = original
    assert.equal(noPush.ok, false)
    assert.match(noPush.error, /推送权限/)
    const noBranch = await service.push({ peerId: PEER_ID, remoteProjectId: 'p4', localProjectId: 'local-a', branch: 'does-not-exist' })
    assert.equal(noBranch.ok, false)
    assert.match(noBranch.error, /本地没有分支/)
    assert.equal((await service.push({ peerId: PEER_ID, remoteProjectId: 'p4', localProjectId: 'local-a', branch: '../x' })).ok, false)
    assert.equal((await service.push({ peerId: PEER_ID, remoteProjectId: 'p4', localProjectId: 'nope', branch: 'service-topic' })).ok, false)
    const requestsBefore = (await readState()).requests.length
    failRequests = true
    const lost = await service.push({
      peerId: PEER_ID,
      remoteProjectId: 'p4',
      localProjectId: 'local-a',
      branch: 'service-topic',
      request: { title: '丢失的请求', note: '' }
    })
    failRequests = false
    assert.equal(lost.ok, false)
    assert.match(lost.error, /分支已推送，但合并请求没有发出/)
    assert.equal((await readState()).requests.length, requestsBefore)
  })

  await check('closeRequest：open 的请求能关闭，第二次关闭失败；已合并的请求不能再关闭', async () => {
    const first = await service.closeRequest(outgoingRequestId)
    assert.equal(first.ok, true, first.error)
    assert.equal((await readState()).requests.find((item) => item.id === outgoingRequestId).status, 'closed')
    const second = await service.closeRequest(outgoingRequestId)
    assert.equal(second.ok, false)
    assert.match(second.error, /找不到这条合并请求，或它已处理/)
    assert.equal((await service.closeRequest('mr-manual-1')).ok, false)
    assert.equal((await service.closeRequest('mr-nope')).ok, false)
  })

  await check('continueFrom：建出 worktree，分支名为 <对方>/feature，起点是对方的提交，提示词含路径与会话副本', async () => {
    const state = await readState()
    const latestImport = [...state.sessionImports].reverse().find((item) => item.branch === 'feature')
    const featureOid = sh(SC, 'rev-parse', svcTracking)
    const result = await service.continueFrom('local-a', svcTracking)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.data.branch, 'b-peerb/feature')
    assert.equal(sh(result.data.worktree, 'symbolic-ref', '--short', 'HEAD'), 'b-peerb/feature')
    assert.equal(sh(result.data.worktree, 'rev-parse', 'HEAD'), featureOid)
    assert.ok(existsSync(join(result.data.worktree, 'f.txt')))
    assert.ok(result.data.prompt.includes(result.data.worktree), result.data.prompt)
    assert.ok(result.data.prompt.includes('B 电脑'))
    assert.ok(result.data.prompt.includes(join(svcImports, latestImport.importId, 'messages.json')), result.data.prompt)
    assert.ok(result.data.prompt.includes(featureOid.slice(0, 7)))
    assert.ok(result.data.prompt.includes(latestImport.title))
  })

  await check('continueFrom 再次调用：分支名避让为 b/feature-2；指定 importId 用指定会话；未知 importId 不带会话行', async () => {
    const state = await readState()
    const s5Import = [...state.sessionImports].reverse().find((item) => item.sessionId === 's5')
    const second = await service.continueFrom('local-a', svcTracking, s5Import.importId)
    assert.equal(second.ok, true, second.error)
    assert.equal(second.data.branch, 'b-peerb/feature-2')
    assert.ok(second.data.prompt.includes(join(svcImports, s5Import.importId, 'messages.json')))
    assert.ok(second.data.prompt.includes(s5Import.title))
    const third = await service.continueFrom('local-a', svcTracking, 'import-none')
    assert.equal(third.ok, true, third.error)
    assert.equal(third.data.branch, 'b-peerb/feature-3')
    assert.ok(!third.data.prompt.includes('messages.json'))
  })

  await check('continueFrom 的拒绝：本地分支引用、没拉取过的引用、未知项目', async () => {
    assert.equal((await service.continueFrom('local-a', 'refs/heads/main')).ok, false)
    const unfetched = await service.continueFrom('local-a', trackingRefFor(REMOTE, 'never-fetched'))
    assert.equal(unfetched.ok, false)
    assert.match(unfetched.error, /还没有拉取/)
    assert.equal((await service.continueFrom('nope', svcTracking)).ok, false)
  })

  await check('对方分支名含非 ASCII 字符：能拉取，continueFrom 用提交号生成安全的本地分支名', async () => {
    sh(SH, 'checkout', '-q', '-b', '中文分支', 'main')
    chineseOid = commitFile(SH, 'cn.txt', '中文\n', '中文分支提交')
    sh(SH, 'checkout', '-q', 'main')
    const fetched = await service.fetch(PEER_ID, 'p4', '中文分支')
    assert.equal(fetched.ok, true, fetched.error)
    assert.equal(fetched.data.oid, chineseOid)
    assert.equal(sh(SC, 'rev-parse', fetched.data.trackingRef), chineseOid)
    const continued = await service.continueFrom('local-a', fetched.data.trackingRef)
    assert.equal(continued.ok, true, continued.error)
    assert.equal(continued.data.branch, `b-peerb/branch-${chineseOid.slice(0, 7)}`)
    assert.equal(sh(continued.data.worktree, 'rev-parse', 'HEAD'), chineseOid)
  })

  await check('状态落盘：新的 CollabService 读同一个状态文件能看到链接、请求与拉取记录；坏文件视为空状态', async () => {
    const reloaded = makeService(svcState)
    const before = await service.overview()
    const after = await reloaded.overview()
    assert.deepEqual(after.links, before.links)
    assert.deepEqual(after.requests, before.requests)
    assert.deepEqual(after.fetched, before.fetched)
    assert.ok(after.requests.length >= 3)
    const broken = join(svcDir, 'broken-state.json')
    await writeFile(broken, '{ not json')
    const fresh = await makeService(broken).overview()
    assert.deepEqual([fresh.links, fresh.requests, fresh.fetched], [[], [], []])
  })

  await check('连接断开或设备不存在时：remoteProject 报错，push 提示没有权限，fetch 因对方拒绝而失败，且不动本地引用', async () => {
    const original = svcConnection
    svcConnection = { state: 'idle' }
    const view = await service.remoteProject(PEER_ID, 'p4')
    assert.equal(view.ok, false)
    assert.match(view.error, /还没有连接这台砚/)
    const push = await service.push({ peerId: PEER_ID, remoteProjectId: 'p4', localProjectId: 'local-a', branch: 'service-topic' })
    assert.equal(push.ok, false)
    assert.match(push.error, /推送权限/)
    const refsBefore = allRefs(SC)
    const fetched = await service.fetch(PEER_ID, 'p4', 'feature')
    assert.equal(fetched.ok, false)
    assert.equal(allRefs(SC), refsBefore)
    assert.deepEqual(existsSync(svcTemp) ? await readdir(svcTemp) : [], [])
    svcConnection = original
    svcPeerKnown = false
    const gone = await service.remoteProject(PEER_ID, 'p4')
    svcPeerKnown = true
    assert.equal(gone.ok, false)
    assert.match(gone.error, /找不到这台砚/)
  })

  section('requests 的服务端约束')

  await check('请求的提交必须已经推送到对应追踪引用：未推送的提交号、指向别处的提交号都是 409', async () => {
    const before = incoming.length
    for (const oid of ['1'.repeat(40), featureOid2]) {
      const response = await collabCall(conn1.connectionId, 'projects/p1/requests', { method: 'POST', json: { branch: 'topic', oid, title: 't', note: '' } })
      assert.equal(response.status, 409, `oid=${oid} 得到 ${response.status}`)
    }
    const unpushedBranch = await collabCall(conn1.connectionId, 'projects/p1/requests', { method: 'POST', json: { branch: 'never-pushed', oid: topicOid, title: 't', note: '' } })
    assert.equal(unpushedBranch.status, 409)
    assert.equal(incoming.length, before)
  })

  await check('同一设备 10 分钟内最多 20 条合并请求，超过返回 429 且不再记录', async () => {
    const statuses = []
    for (let index = 0; index < 25; index += 1) {
      const response = await collabCall(conn1.connectionId, 'projects/p1/requests', { method: 'POST', json: { branch: 'topic', oid: topicOid, title: `第 ${index} 条`, note: '' } })
      statuses.push(response.status)
    }
    assert.ok(statuses.includes(429), statuses.join(','))
    assert.ok(statuses.every((status) => status === 200 || status === 429), statuses.join(','))
    assert.equal(statuses.indexOf(429), statuses.lastIndexOf(200) + 1, '429 之后不应再有成功的请求')
    assert.equal(incoming.length, 20)
  })
} catch (error) {
  fail('测试流程异常中断', error)
} finally {
  for (const stream of streams) stream.close()
  await wait(50)
  await server?.stop().catch(() => undefined)
  grants.revokeAll()
  for (const file of bundles) await rm(file, { force: true }).catch(() => undefined)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
}

process.stdout.write(`\n${report.fail === 0 ? '✅' : '❌'} 多人协作底层：${report.pass} 通过 / ${report.fail} 失败\n`)
process.exit(report.fail === 0 ? 0 : 1)
