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
  './title': 'export const setManualTitle = async () => ({ok:true}); export const manualTitles = async () => ({}); export const cachedTitles = async () => ({})',
  './settings': 'export const getSettings = async () => globalThis.__boundary.settings',
  './sessions': 'export const listSessions = async () => globalThis.__boundary.sessions.map(x => ({...x})); export const deleteSession = async () => ""; export const restoreSession = async () => undefined; export const sessionsToDelete = async () => []; export const SESSIONS_DIR = ""',
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
try {
  await build({ entryPoints: ['src/main/remote-host.ts'], outfile: join(root, 'remote-host.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [plugin] })
  const remote = await import(pathToFileURL(join(root, 'remote-host.mjs')).href)
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
  const activeAgent = agent
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
    blocksConcurrentRun: () => false,
    admitExecute: () => { reservations++; return { ok: true, token: 1 } },
    releaseExecute: () => { reservations-- }
  }
  let remember = async () => { remembered++ }
  const hostPorts = {
    runners: () => registry,
    ac: () => agent,
    sessionChains: { load: async () => {}, representativeOf: file => file, chains: () => [] },
    validateCwd: async cwd => ({ ok: true, cwd }),
    projectIdForCwd: () => 'P',
    rememberRunnerSession: (...args) => remember(...args),
    pushRunners: () => {},
    pushRunnerSnapshot: async () => {},
    readHistoryWithArtifacts: async () => ({ messages: [], total: 0, truncated: 0, bytes: 0 })
  }
  remote.configureRemoteHost(hostPorts)
  const send = extra => remote.executeRemoteCommand({ action: 'send', sessionId: 'A', text: 'only-A', ...extra })
  assert.equal((await send()).ok, true)
  assert.deepEqual(sends.map(x => x.sessionId), ['A'])
  assert.equal(remembered, 0)
  onSelect = async () => { sessionId = 'B'; generation++ }
  assert.equal((await send()).status, 409)
  onSelect = undefined

  onSelect = async () => { generation += 2 }
  assert.equal((await send()).status, 409)
  onSelect = undefined
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

  console.log('远程会话边界隔离回归通过：错投/ABA、模型与思考调用、热缓存移动')
} finally {
  delete globalThis.__boundary
  await rm(root, { recursive: true, force: true })
}
