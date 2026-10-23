import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-remote-boundary-'))
const stubs = {
  electron: 'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false }) }',
  './remote-approval': 'export const approvalDigest = () => "d"; export const applyHumanApproval = async () => ({ok:false}); export const remoteApprovalQuestion = x => x',
  './image-store': 'export const localizeImage = () => ""',
  './title': 'export const setManualTitle = async () => ({ok:true})',
  './settings': 'export const getSettings = async () => globalThis.__boundary.settings',
  './sessions': 'export const listSessions = async () => globalThis.__boundary.sessions.map(x => ({...x}))',
  './peer-grants': 'export class PeerGrantRegistry {}',
  './peer-client': 'export class PeerClient {}',
  './paths': 'export const YAN_DIR = "/fixture"'
}
const plugin = {
  name: 'remote-boundary-fixtures',
  setup(api) {
    api.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture' } : undefined)
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  }
}
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
let server
try {
  for (const name of ['remote-host', 'remote-server']) {
    await build({ entryPoints: [`src/main/${name}.ts`], outfile: join(root, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [plugin] })
  }
  const remote = await import(pathToFileURL(join(root, 'remote-host.mjs')).href)
  const { RemoteServer } = await import(pathToFileURL(join(root, 'remote-server.mjs')).href)
  const summary = (id, projectId = 'P') => ({ id, path: `/fixture/${id}.jsonl`, cwd: `/fixture/${projectId}`, projectId, scope: projectId ? 'project' : 'global', title: id, createdAt: 1, updatedAt: 1, messageCount: 1 })
  const state = globalThis.__boundary = { settings: { projects: [{ id: 'P', cwd: '/fixture/P' }, { id: 'Q', cwd: '/fixture/Q' }] }, sessions: [summary('A'), summary('B', 'Q')] }
  let generation = 1
  let sessionId = 'A'
  let remembered = 0
  let modelWrites = 0
  let thinkingWrites = 0
  let reservations = 0
  let onSelect
  let listModels = async () => [{ provider: 'p', id: 'm' }]
  let listThinkingLevels = async () => ['high']
  const sends = []
  const agent = {
    getState: () => ({ sessionId, cwd: '/fixture/P', model: { provider: 'p', id: 'm', input: ['text'] } }),
    hasRunningBash: () => false,
    listModels: () => listModels(),
    listThinkingLevels: () => listThinkingLevels(),
    setModel: async () => { modelWrites++; return { ok: true } },
    setThinking: async () => { thinkingWrites++; return { ok: true } },
    send: async (text, images, mode, autoContinue, expected) => {
      assert.equal(expected, generation)
      sends.push({ sessionId, generation, text })
      return { ok: true }
    }
  }
  let activeAgent = agent
  const registry = {
    select: async target => {
      sessionId = target.sessionId ?? 'new'
      generation++
      const selected = { ok: true, id: 'r1', runId: 'r1', sessionId, generation }
      await onSelect?.()
      return selected
    },
    agentOf: () => activeAgent,
    runtimeOf: () => ({ generation, sessionId }),
    statuses: () => [{ id: 'r1', runId: 'r1', sessionId, generation, projectId: 'P', cwd: '/fixture/P' }],
    hasBusyCwd: () => false,
    admitExecute: () => { reservations++; return { ok: true, token: 1 } },
    releaseExecute: () => { reservations-- }
  }
  let remember = async () => { remembered++ }
  remote.configureRemoteHost({
    runners: () => registry,
    ac: () => agent,
    sessionChains: { load: async () => {}, representativeOf: file => file, chains: () => [] },
    validateCwd: async cwd => ({ ok: true, cwd }),
    projectIdForCwd: () => 'P',
    rememberRunnerSession: (...args) => remember(...args),
    pushRunners: () => {},
    pushRunnerSnapshot: async () => {},
    readHistoryWithArtifacts: async () => ({ messages: [], total: 0, truncated: 0, bytes: 0 })
  })
  const send = extra => remote.executeRemoteCommand({ action: 'send', sessionId: 'A', text: 'only-A', ...extra })
  assert.equal((await send()).ok, true)
  assert.deepEqual(sends.map(x => x.sessionId), ['A'])
  assert.equal(remembered, 0)
  onSelect = async () => { sessionId = 'B'; generation++ }
  assert.equal((await send()).status, 409)
  onSelect = undefined

  for (const replacement of [false, true]) {
    const reached = deferred()
    const release = deferred()
    const pending = send({ authorize: async () => { reached.resolve(); await release.promise; return null } })
    await reached.promise
    sessionId = 'B'
    generation++
    if (replacement) activeAgent = { ...agent }
    release.resolve()
    assert.equal((await pending).status, 409)
    activeAgent = agent
  }
  const reached = deferred()
  const release = deferred()
  const aba = send({ authorize: async () => { reached.resolve(); await release.promise; return null } })
  await reached.promise
  generation += 2
  release.resolve()
  assert.equal((await aba).status, 409)
  assert.equal(sends.length, 1)
  assert.equal(remembered, 0)

  for (const action of ['model', 'thinking']) {
    const reached = deferred()
    const release = deferred()
    const listing = async () => { reached.resolve(); await release.promise; return action === 'model' ? [{ provider: 'p', id: 'm' }] : ['high'] }
    if (action === 'model') listModels = listing
    else listThinkingLevels = listing
    const pending = remote.executeRemoteCommand({ action, sessionId: 'A', provider: 'p', modelId: 'm', level: 'high' })
    await reached.promise
    assert.equal(reservations, 1)
    sessionId = 'B'
    generation++
    release.resolve()
    assert.equal((await pending).status, 409)
    assert.equal(reservations, 0)
  }
  assert.equal(modelWrites + thinkingWrites, 0)

  let moveAfterGate = false
  const grants = {
    check: (_connection, _device, _operation, projectId) => {
      if (projectId !== 'P') return { ok: false, status: 403, error: 'denied', code: 'peer_project_denied' }
      if (moveAfterGate) { moveAfterGate = false; state.sessions[0] = summary('A', 'Q') }
      return { ok: true, grant: { projects: [{ id: 'P', name: 'P' }] } }
    }
  }
  server = new RemoteServer({
    host: '127.0.0.1', port: 0,
    devices: { authenticate: async () => ({ id: 'peer', name: 'peer', kind: 'peer' }) },
    peers: { grants, handlers: remote.peerHostHandlers },
    handlers: { snapshot: async () => ({}), history: remote.remoteHistory, command: remote.executeRemoteCommand }
  })
  const info = await server.start()
  let requestId = 0
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${info.port}/remote/v1/peer/${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json', 'idempotency-key': `boundary-${++requestId}` }, body: body ? JSON.stringify(body) : undefined
    })
    return { status: response.status, body: await response.json() }
  }
  sessionId = 'A'
  for (const projectId of ['Q', undefined]) {
    state.sessions[0] = summary('A')
    assert.equal((await request('sessions/A')).status, 200)
    state.sessions[0] = summary('A', projectId ?? null)
    assert.equal(await remote.peerHostHandlers.projectOfSession('A'), projectId ?? null)
    assert.equal(await remote.peerHostHandlers.projectOfRun('r1'), projectId ?? null)
    assert.ok([403, 404].includes((await request('sessions/A')).status))
    assert.ok([403, 404].includes((await request('sessions/A/messages', { text: 'denied' })).status))
    assert.equal(state.sessions[0].projectId, projectId ?? null)
  }
  state.sessions[0] = summary('A')
  assert.equal((await request('sessions/A/messages', { text: 'authorized-A' })).status, 200)
  assert.equal(sends.at(-1).sessionId, 'A')
  const sentBeforeMoves = sends.length
  moveAfterGate = true
  assert.equal((await request('sessions/A/messages', { text: 'moved-during-body' })).status, 403)
  state.sessions[0] = summary('A')
  onSelect = async () => { state.sessions[0] = summary('A', 'Q') }
  assert.equal((await request('sessions/A/messages', { text: 'moved-during-select' })).status, 403)
  onSelect = undefined
  assert.equal(sends.length, sentBeforeMoves)
  assert.equal(remembered, 0)
  assert.equal(state.sessions[0].projectId, 'Q')

  remember = async () => { remembered++; sessionId = 'B'; generation++ }
  const started = await remote.peerHostHandlers.startSession('P', 'new-task')
  assert.equal(started.status, 409)
  assert.equal(sends.length, sentBeforeMoves)
  console.log('远程会话边界隔离回归通过：错投/替换/ABA、模型与思考调用、热缓存移动、请求体与选择期间移动、新任务记账竞态')
} finally {
  await server?.stop()
  delete globalThis.__boundary
  await rm(root, { recursive: true, force: true })
}
