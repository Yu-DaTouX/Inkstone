import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export async function loadDesktopModules() {
  const built = await build({
    stdin: { contents: `export { RemoteServer } from './src/main/remote-server'; export { RemoteDeviceStore } from './src/main/remote-devices'`, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}

const fail = (status, error) => ({ ok: false, status, error })

export const defaultSessions = () => [
  { id: 's-1', title: '第一个会话', cwdName: 'repo', projectId: 'p-1', updatedAt: Date.now() - 60_000, messageCount: 2 },
  { id: 's-2', title: '要删除的会话', cwdName: 'repo', projectId: 'p-1', updatedAt: Date.now() - 120_000, messageCount: 1 }
]

export async function startFakeDesktop({ omit = [], tweak } = {}) {
  const { RemoteServer, RemoteDeviceStore } = await loadDesktopModules()
  const dir = await mkdtemp(join(tmpdir(), 'yan-mobile-fake-'))
  const devices = new RemoteDeviceStore(dir)
  const calls = []
  const state = {
    running: false,
    branch: 'main',
    sessions: defaultSessions(),
    projects: [{ id: 'p-1', name: 'repo', cwd: 'E:/work/repo' }],
    messages: [
      { id: 'u1', role: 'user', text: '你好', timestamp: Date.now() - 50_000 },
      { id: 'a1', role: 'assistant', text: '你好，我能帮你做什么？', timestamp: Date.now() - 49_000 }
    ],
    models: [{ id: 'm-a', provider: 'p', name: 'Model A', input: ['text'] }, { id: 'm-b', provider: 'p', name: 'Model B', input: ['text', 'image'] }],
    current: null,
    pending: false,
    thinking: { level: 'low', levels: ['off', 'low', 'high'] },
    stats: { tokens: 12345, cost: 0.5, toolCalls: 3, messages: 2, context: { percent: 40, tokens: 40000, window: 100000 } },
    changes: { branch: 'main', added: 3, removed: 1, total: 1, files: [{ path: 'src/a.ts', status: 'M', added: 3, removed: 1 }], truncated: false },
    branches: [{ name: 'main', current: true }, { name: 'dev', current: false }, { name: 'wt', current: false, busy: true }],
    subagents: [],
    searchHits: [],
    errors: {},
    activeSessionId: 's-1'
  }
  state.current = state.models[0]
  const guarded = (key, run) => async (...args) => {
    calls.push([key, ...args])
    const err = state.errors[key]
    if (err) return typeof err === 'function' ? err(...args) : fail(err.status ?? 500, err.error ?? '失败')
    return run(...args)
  }
  const handlers = {
    async snapshot() {
      return { sessions: state.sessions, projects: state.projects, agent: { runners: state.running ? [{ runId: 'r1', sessionId: 's-1', running: true, waiting: false, model: state.current }] : [], activeSessionId: state.activeSessionId } }
    },
    history: guarded('history', async (sessionId) => ({ ok: true, data: { sessionId, messages: state.messages, ...(state.queue?.[sessionId] ? { queue: state.queue[sessionId] } : {}), total: state.messages.length, hasMore: false } })),
    models: guarded('models', async () => ({ ok: true, data: { models: state.models, current: state.current, thinking: state.thinking, pending: state.pending } })),
    subagents: guarded('subagents', async () => ({ ok: true, data: { runs: state.subagents } })),
    stopSubagent: guarded('stopSubagent', async (sessionId, runId) => {
      const run = state.subagents.find((r) => r.id === runId)
      if (!run) return fail(404, '没有这个子代理')
      run.status = 'cancelled'
      return { ok: true, data: { id: runId } }
    }),
    insight: guarded('insight', async () => ({ ok: true, data: { stats: state.stats, changes: state.changes ? { ...state.changes, branch: state.changes.branch === null ? null : state.branch } : null } })),
    sessionFlags: guarded('flags', async (sessionId, flags) => {
      const session = state.sessions.find((s) => s.id === sessionId)
      if (!session) return fail(404, '没有这个会话')
      if (flags.archived && state.running && sessionId === 's-1') return fail(409, '运行中的会话不能归档')
      if (typeof flags.pinned === 'boolean') session.pinned = flags.pinned || undefined
      if (typeof flags.archived === 'boolean') session.archivedAt = flags.archived ? Date.now() : undefined
      return { ok: true, data: flags }
    }),
    deleteSession: guarded('delete', async (sessionId) => {
      if (sessionId === state.activeSessionId) return fail(409, '当前使用中的会话不能删除')
      state.sessions = state.sessions.filter((s) => s.id !== sessionId)
      return { ok: true, data: { sessionId } }
    }),
    compact: guarded('compact', async (sessionId) => (state.running ? fail(409, '运行中不能压缩') : { ok: true, data: { sessionId } })),
    branches: guarded('branches', async () => ({ ok: true, data: { repo: true, current: state.branch, branches: state.branches.map((b) => ({ ...b, current: b.name === state.branch })) } })),
    switchBranch: guarded('switchBranch', async (sessionId, branch) => {
      if (state.running) return fail(409, '会话运行中，不能切换分支')
      if (branch === 'conflict') return fail(409, '有未提交的改动会被覆盖')
      state.branch = branch
      return { ok: true, data: { branch } }
    }),
    search: guarded('search', async (query) => ({ ok: true, data: { hits: state.searchHits.map((hit) => ({ ...hit, snippet: hit.snippet.replace('{q}', query) })) } })),
    command: guarded('command', async (command) => {
      if (command.action === 'model') {
        state.current = state.models.find((m) => m.id === command.modelId)
        state.pending = state.running
        return { ok: true, data: { current: state.current, pending: state.pending } }
      }
      if (command.action === 'thinking') { state.thinking = { ...state.thinking, level: command.level }; state.pending = state.running; return { ok: true, data: { level: command.level, levels: state.thinking.levels, pending: state.pending } } }
      if (command.action === 'rename') { const s = state.sessions.find((x) => x.id === command.sessionId); if (s) s.title = command.name; return { ok: true, data: {} } }
      return { ok: true, data: {} }
    })
  }
  for (const key of omit) delete handlers[key]
  tweak?.(handlers, state)
  const server = new RemoteServer({ host: '127.0.0.1', port: 0, devices, handlers })
  const info = await server.start()
  const baseUrl = `http://127.0.0.1:${info.port}`
  return {
    server, devices, state, calls, baseUrl,
    startPairing: () => devices.startPairing().code,
    async stop() { await server.stop(); await rm(dir, { recursive: true, force: true }) }
  }
}
