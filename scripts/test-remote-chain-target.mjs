import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

let passed = 0
const failures = []
function ok(condition, label) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(label)
  console.error(`  ✗ ${label}`)
}

const stubModules = {
  electron: 'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false }) }',
  './remote-approval': 'export const approvalDigest = () => \'d\'; export const applyHumanApproval = async () => ({ ok: false, status: 403, error: \'stub\' }); export const remoteApprovalQuestion = (request) => request',
  './image-store': 'export const localizeImage = () => \'\'',
  './title': 'export const setManualTitle = (...args) => globalThis.__rh.setManualTitle(...args)',
  './settings': 'export const getSettings = (...args) => globalThis.__rh.getSettings(...args)',
  './sessions': 'export const listSessions = (...args) => globalThis.__rh.listSessions(...args)',
  './peer-grants': 'export class PeerGrantRegistry { constructor() {} }',
  './peer-client': 'export class PeerClient { constructor() {} }',
  './paths': 'export const YAN_DIR = \'/tmp/yan-remote-chain-fixture\'',
  './project-memory-store': 'export const listKnowledge = async () => []'
}

const stubPlugin = {
  name: 'yan-remote-chain-stubs',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, (args) =>
      Object.prototype.hasOwnProperty.call(stubModules, args.path)
        ? { path: args.path, namespace: 'yan-stub' }
        : undefined)
    buildApi.onLoad({ filter: /.*/, namespace: 'yan-stub' }, (args) => ({
      contents: stubModules[args.path],
      loader: 'js'
    }))
  }
}

const norm = (file) => String(file).trim().replace(/\\/g, '/').replace(/\/+$/, '')

const now = Date.now()
const P = 'C:/fixture/sessions'
const summary = (id, file, projectId, extra = {}) => ({
  id,
  path: `${P}/${file}`,
  cwd: `C:/fixture/${projectId}`,
  projectId,
  scope: 'project',
  title: extra.title ?? file,
  named: !!extra.title,
  createdAt: now,
  updatedAt: now,
  messageCount: 1,
  ...extra
})

const oldP1 = summary('s-old', 'old.jsonl', 'p1', { title: '第一条' })
const repP1 = summary('s-new', 'new.jsonl', 'p1', { title: '' })
const lonely = summary('s-lonely', 'lonely.jsonl', 'p1', { title: '独立会话' })
const oldCross = summary('s-cross-old', 'cross-old.jsonl', 'p1', { title: '跨项目链' })
const repCross = summary('s-cross-new', 'cross-new.jsonl', 'p2', { title: '跨项目代表' })
const allSessions = [oldP1, repP1, lonely, oldCross, repCross]

const chains = [
  {
    chainId: norm(oldP1.path),
    segments: [
      { sessionFile: norm(oldP1.path), startedAt: 1, handoffId: null },
      { sessionFile: norm(repP1.path), startedAt: 2, handoffId: 'h1' }
    ],
    updatedAt: 2
  },
  {
    chainId: norm(oldCross.path),
    segments: [
      { sessionFile: norm(oldCross.path), startedAt: 1, handoffId: null },
      { sessionFile: norm(repCross.path), startedAt: 2, handoffId: 'h2' }
    ],
    updatedAt: 2
  }
]

const chainOf = (file) => {
  const key = norm(file)
  return chains.find((chain) => chain.segments.some((seg) => norm(seg.sessionFile) === key)) ?? null
}
const chainStore = {
  load: async () => {},
  chains: () => chains,
  chainOf,
  isRepresentative: (file) => {
    const chain = chainOf(file)
    if (!chain) return true
    return norm(chain.segments[chain.segments.length - 1].sessionFile) === norm(file)
  },
  representativeOf: (file) => {
    const chain = chainOf(file)
    return chain ? norm(chain.segments[chain.segments.length - 1].sessionFile) : norm(file)
  }
}

const messageStore = {
  [norm(oldP1.path)]: [{ id: 'a1', role: 'user', text: '旧段消息' }],
  [norm(repP1.path)]: [{ id: 'b1', role: 'assistant', text: '代表段消息' }],
  [norm(oldCross.path)]: [{ id: 'x1', role: 'user', text: '跨项目旧段消息' }],
  [norm(repCross.path)]: [{ id: 'y1', role: 'assistant', text: '跨项目代表段消息' }]
}

const selectCalls = []
const sendCalls = []
const titleCalls = []
const historyCalls = []

const agent = {
  getState: () => ({
    sessionId: 's-new',
    model: { id: 'm1', provider: 'prov', name: 'M1', input: ['text'] },
    isStreaming: false,
    isAgentRunning: false,
    isCompacting: false,
    thinkingLevel: 'off'
  }),
  send: async (text, images, mode) => {
    sendCalls.push({ text, images, mode })
    return { ok: true }
  },
  listModels: async () => [
    { id: 'm1', provider: 'prov', name: 'M1', input: ['text'] },
    { id: 'm2', provider: 'prov', name: 'M2', input: ['text'] }
  ],
  setModel: async () => ({ ok: true }),
  setThinking: async () => ({ ok: true }),
  listThinkingLevels: async () => ['off', 'high'],
  hasRunningBash: () => false,
  pendingUiRequests: () => [],
  abort: async () => ({ ok: true })
}

const runners = {
  select: async (target) => {
    selectCalls.push(target)
    return { ok: true, id: 'run-rep', sessionId: target.sessionId ?? 'sess', runId: 'r1', generation: 1 }
  },
  hasBusyCwd: () => false,
  blocksConcurrentRun: () => false,
  runtimeOf: () => ({ generation: 1, sessionId: 's-new' }),
  admitExecute: () => ({ ok: true, token: 1 }),
  releaseExecute: () => {},
  agentOf: () => agent,
  statuses: () => [{
    id: 'r1',
    runId: 'r1',
    sessionId: 's-new',
    projectId: 'p1',
    generation: 1,
    cwd: 'C:/fixture/p1',
    running: false,
    waiting: false,
    failed: false,
    conn: 'open',
    createdAt: now,
    lastActiveAt: now,
    isActive: true
  }]
}

const readHistoryWithArtifacts = async (file) => {
  historyCalls.push(file)
  const chain = chainOf(file)
  const files = chain ? chain.segments.map((seg) => norm(seg.sessionFile)) : [norm(file)]
  const messages = files.flatMap((each) => (messageStore[each] ?? []).map((message) => ({ ...message })))
  return { messages, total: messages.length, truncated: 0, bytes: 1 }
}

const fakeHost = {
  runners: () => runners,
  ac: () => null,
  sessionChains: chainStore,
  push: () => {},
  pushRunners: () => {},
  pushRunnerSnapshot: async () => {},
  validateCwd: async (cwd) => ({ ok: true, cwd }),
  startAgent: async () => ({ ok: true }),
  rememberRunnerSession: async () => {},
  readHistoryWithArtifacts,
  projectIdForCwd: () => 'p1',
  win: () => null,
  remoteAccess: () => null,
  approvals: { list: () => [], answer: () => false }
}

globalThis.__rh = {
  getSettings: async () => ({ projects: [], cwd: 'C:/fixture/p1', piBin: 'pi' }),
  listSessions: async () => allSessions,
  setManualTitle: async (sessionId, name) => {
    titleCalls.push({ sessionId, name })
    return { ok: true }
  }
}

const outDir = await mkdtemp(join(tmpdir(), 'yan-remote-chain-'))
let mod
try {
  const built = await build({
    entryPoints: [join(ROOT, 'src/main/remote-host.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent',
    plugins: [stubPlugin]
  })
  const bundlePath = join(outDir, 'remote-host.bundle.mjs')
  await writeFile(bundlePath, built.outputFiles[0].text, 'utf8')
  mod = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
  mod.configureRemoteHost(fakeHost)

  console.log('--- F09 远程 / peer 会话链代表段归一化 ---')

  const snapshot = await mod.remoteSnapshot()
  const snapshotIds = snapshot.sessions.map((session) => session.id)
  ok(snapshotIds.includes('s-new'), '远程列表包含链代表段')
  ok(snapshotIds.includes('s-lonely'), '远程列表包含孤立会话')
  ok(!snapshotIds.includes('s-old'), '远程列表隐藏链旧段')
  ok(snapshot.sessions.find((session) => session.id === 's-new')?.title === '第一条', '代表段空标题回填链首标题')

  const peerSessions = await mod.peerHostHandlers.sessions(['p1'])
  const peerIds = peerSessions.map((session) => session.id)
  ok(peerIds.includes('s-new') && peerIds.includes('s-lonely'), 'peer 列表含已授权项目的代表段与孤立会话')
  ok(!peerIds.includes('s-old'), 'peer 列表隐藏已授权项目的链旧段')
  ok(!peerIds.includes('s-cross-new'), 'peer 列表不返回未授权项目 p2 的代表段')
  ok(await mod.peerHostHandlers.projectOfSession('s-cross-old') === 'p1', 'peer 授权按请求段项目判定，不跨项目归一')

  const settingsBefore = globalThis.__rh.getSettings
  globalThis.__rh.getSettings = async () => ({
    cwd: 'C:/fixture/p1',
    piBin: 'pi',
    projectNames: { 'C:/fixture/aliased': '别名项目' },
    projects: [
      { id: 'named', name: '手动命名', cwd: 'C:/fixture/named' },
      { id: 'aliased', name: '', cwd: 'C:/fixture/aliased' },
      { id: 'unnamed', name: '  ', cwd: 'C:\\fixture\\pi-desktop' },
      { id: 'gone', name: '已归档', cwd: 'C:/fixture/gone', archived: true }
    ]
  })
  const peerProjects = await mod.peerHostHandlers.projects()
  globalThis.__rh.getSettings = settingsBefore
  ok(JSON.stringify(peerProjects.map((project) => [project.id, project.name])) === JSON.stringify([['named', '手动命名'], ['aliased', '别名项目'], ['unnamed', 'pi-desktop']]), 'peer 申请弹窗的项目名回退到别名或文件夹名，不留空白')

  selectCalls.length = 0
  const selected = await mod.remoteSelectSession('s-old')
  ok(selected.ok, '选择旧段成功')
  ok(selectCalls.length === 1 && norm(selectCalls[0].sessionFile) === norm(repP1.path), '选择旧段落到代表段文件')
  ok(selectCalls[0].sessionId === 's-new', '选择旧段使用代表段 id')

  selectCalls.length = 0
  sendCalls.length = 0
  const sent = await mod.executeRemoteCommand({ action: 'send', sessionId: 's-old', text: 'hello' })
  ok(sent.ok && sent.data.sessionId === 's-new', '发送旧段返回代表段 id')
  ok(selectCalls.length === 1 && norm(selectCalls[0].sessionFile) === norm(repP1.path), '发送旧段落到代表段文件')
  ok(sendCalls.length === 1 && sendCalls[0].text === 'hello', '消息实际交给代表段实例')
  ok(selectCalls.every((call) => norm(call.sessionFile) !== norm(oldP1.path)), '发送路径从未选择旧段文件')

  sendCalls.length = 0
  const steered = await mod.executeRemoteCommand({ action: 'send', sessionId: 's-old', text: 'wrap up', mode: 'steer' })
  ok(steered.ok && sendCalls[0]?.mode === 'steer' && sent.ok && sendCalls.length === 1, '远程发送可指定插话，交给实例时带上 steer')

  selectCalls.length = 0
  const modeled = await mod.executeRemoteCommand({ action: 'model', sessionId: 's-old', provider: 'prov', modelId: 'm2' })
  ok(modeled.ok && norm(selectCalls[0]?.sessionFile) === norm(repP1.path), '改模型旧段落到代表段')

  selectCalls.length = 0
  const thought = await mod.executeRemoteCommand({ action: 'thinking', sessionId: 's-old', level: 'high' })
  ok(thought.ok && norm(selectCalls[0]?.sessionFile) === norm(repP1.path), '改思考档旧段落到代表段')

  titleCalls.length = 0
  const renamed = await mod.executeRemoteCommand({ action: 'rename', sessionId: 's-old', name: '新名字' })
  ok(renamed.ok && renamed.data.sessionId === 's-new', '改名旧段返回代表段 id')
  ok(titleCalls.length === 1 && titleCalls[0].sessionId === 's-new', '改名写入代表段 id')

  selectCalls.length = 0
  const models = await mod.remoteModels('s-old')
  ok(models.ok && models.data.current?.id === 'm1', '模型列表归一后仍返回代表段当前模型')

  selectCalls.length = 0
  sendCalls.length = 0
  const crossSend = await mod.executeRemoteCommand({ action: 'send', sessionId: 's-cross-old', text: 'x' })
  ok(!crossSend.ok && crossSend.status === 409, '跨项目链发送明确拒绝')
  ok(selectCalls.length === 0 && sendCalls.length === 0, '跨项目拒绝时不选实例、不发送')

  selectCalls.length = 0
  const crossSelect = await mod.remoteSelectSession('s-cross-old')
  ok(!crossSelect.ok && crossSelect.status === 409, '跨项目链选择明确拒绝')
  ok(selectCalls.length === 0, '跨项目拒绝时不动运行实例')

  historyCalls.length = 0
  const history = await mod.remoteHistory('s-old', 50)
  const historyTexts = history.ok ? history.data.messages.map((message) => message.text) : []
  ok(history.ok, '旧段 id 仍可读历史')
  ok(historyTexts.includes('旧段消息') && historyTexts.includes('代表段消息'), '历史按完整链拼接（旧段 + 代表段）')
  ok(historyCalls.length === 1 && norm(historyCalls[0]) === norm(oldP1.path), '历史读取仍把请求段交给链感知读取')
} finally {
  await rm(outDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\nF09 定向回归：${passed} 项通过，${failures.length} 项失败`)
if (failures.length) {
  console.error(failures.map((label) => `  ✗ ${label}`).join('\n'))
  process.exitCode = 1
}
