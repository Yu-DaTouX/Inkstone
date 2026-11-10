#!/usr/bin/env node
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-session-core-audit-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_ATTACHMENTS_DIR = join(root, 'attachments')

const outfile = join(process.cwd(), '.tmp', 'session-core-audit-20261110', 'bundle', 'session-core.mjs')
await mkdir(dirname(outfile), { recursive: true })
await build({
  stdin: {
    contents: `
      export { AgentController } from './src/main/agent'
      export { submitQuickAsk } from './src/main/windows/quick-ask-submit'
      export * as move from './src/main/session-move'
      export { RunnerRegistry } from './src/main/runners'
      export { addTerminalJob, resetTerminalJobs, updateTerminalJob } from './src/main/terminal-jobs'
      export { writePendingModelSwitch, readPendingModelSwitch } from './src/main/pending-model-switch'
      export { saveQueue } from './src/main/queue-persistence'
    `,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [
    {
      name: 'session-core-electron-boundary',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'session-core-electron' }))
        builder.onLoad({ filter: /.*/, namespace: 'session-core-electron' }, () => ({
          loader: 'js',
          contents: `
            export class BrowserWindow {}
            export const session = { fromPartition() {} }
            export const app = { getLocale: () => 'zh-CN', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0.0.0', isPackaged: false }
            export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }
            export const safeStorage = { isEncryptionAvailable: () => false }
            export const shell = { openPath: async () => '' }
          `
        }))
      }
    }
  ],
  logLevel: 'silent'
})

const { AgentController, submitQuickAsk, move, RunnerRegistry, addTerminalJob, resetTerminalJobs, writePendingModelSwitch, readPendingModelSwitch, saveQueue } = await import(pathToFileURL(outfile).href)

let passed = 0
let failed = 0
function ok(condition, name, extra) {
  if (condition) {
    passed += 1
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.error(`✗ ${name}${extra === undefined ? '' : `（${extra}）`}`)
  }
}

const emptyHistory = { messages: [], total: 0, truncated: 0, bytes: 0 }

function controller(state, commands) {
  const pushes = []
  const holder = {}
  const ctl = new AgentController({ push: (msg) => pushes.push({ ...msg, suppressed: holder.ctl?.suppressPush === true }), cwd: process.cwd() })
  holder.ctl = ctl
  ctl.state = state
  ctl.capabilityOpts = { runnerGeneration: 1 }
  ctl.refreshState = async () => {}
  ctl.refreshStats = async () => {}
  ctl.refreshTodos = async () => {}
  ctl.maybeGenerateTitle = async () => {}
  ctl.pushQuestionLog = () => {}
  ctl.pushApprovalLog = () => {}
  ctl.reclaimSavedQueue = async () => {}
  ctl.readHistory = async () => emptyHistory
  ctl.readHistoryOf = async () => emptyHistory
  ctl.rpc = { running: true, command: async (type) => commands(type) }
  return { ctl, pushes }
}

async function writeSession(file, { id, cwd }) {
  await writeFile(file, `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":"hi"}}\n`, 'utf8')
}

console.log('--- A1 切换会话后核对目标身份 ---')
{
  const oldFile = join(root, 'old.jsonl')
  const newFile = join(root, 'new.jsonl')
  await writeSession(oldFile, { id: 'old', cwd: root })
  await writeSession(newFile, { id: 'target-new', cwd: root })

  const state = { sessionId: 'old', sessionFile: oldFile, cwd: root, isStreaming: false, isCompacting: false }
  const { ctl } = controller(state, (type) => (type === 'get_state' ? { success: false, error: 'rpc down' } : { success: false }))
  const reads = []
  ctl.readHistoryOf = async (file) => { reads.push(file); return emptyHistory }
  const res = await ctl.hydrate({ sessionFile: newFile })
  ok(res.ok === false && !!res.error, 'get_state 失败时不宣告成功')
  ok(reads.length === 0, 'get_state 失败时不再按旧身份读历史', reads.join(','))

  const stale = controller(state, (type) => (type === 'get_state'
    ? { success: true, data: { sessionId: 'old', sessionFile: oldFile } }
    : { success: false }))
  const staleReads = []
  stale.ctl.readHistoryOf = async (file) => { staleReads.push(file); return emptyHistory }
  const mismatch = await stale.ctl.hydrate({ sessionFile: newFile })
  ok(mismatch.ok === false && /不一致/.test(mismatch.error ?? ''), '状态仍是旧会话时不宣告成功', mismatch.error)
  ok(staleReads.length === 0 || staleReads.every((file) => file === oldFile), '核对失败前不读目标以外的历史', staleReads.join(','))

  const sw = controller(state, (type) => (type === 'switch_session'
    ? { success: true, data: {} }
    : type === 'get_state' ? { success: false } : { success: false }))
  const switched = await sw.ctl.switchSession(newFile)
  ok(switched.ok === false && /没能确认/.test(switched.error ?? ''), 'switchSession 在状态读不到时返回失败', switched.error)

  const stateFor = (sessionFile) => controller(state, (type) => {
    if (type === 'switch_session') return { success: true, data: {} }
    if (type === 'get_state') return { success: true, data: { sessionId: 'target-new', sessionFile } }
    return { success: false }
  })

  const aliasState = stateFor(newFile.replace(/\\/g, '/').toUpperCase())
  const alias = await aliasState.ctl.switchSession(newFile)
  ok(alias.ok === true, 'Windows 大小写与斜杠写法不同时按同一路径接受', alias.error)

  const missing = stateFor(join(root, 'elsewhere.jsonl'))
  const rejected = await missing.ctl.switchSession(newFile)
  ok(rejected.ok === false, '状态指向同一个 id 但另一个不存在的文件时拒绝', rejected.error)

  const copyFile = join(root, 'imported-copy.jsonl')
  await writeSession(copyFile, { id: 'target-new', cwd: root })
  const copy = stateFor(copyFile)
  const rejectedCopy = await copy.ctl.switchSession(newFile)
  ok(rejectedCopy.ok === false, '不同真实路径的同样 id 副本不被当成切换成功', rejectedCopy.error)

  const linkFile = join(root, 'hardlink-alias.jsonl')
  let linked = true
  try {
    await link(newFile, linkFile)
  } catch {
    linked = false
  }
  if (linked) {
    const linkedState = stateFor(linkFile)
    const acceptedLink = await linkedState.ctl.switchSession(newFile)
    ok(acceptedLink.ok === true, '同一文件的不同路径（硬链接）按文件身份接受', acceptedLink.error)
  } else {
    ok(false, '无法创建硬链接，跳过了文件身份别名用例')
  }

  const fresh = controller(state, (type) => (type === 'new_session'
    ? { success: true, data: {} }
    : type === 'get_state' ? { success: true, data: { sessionId: 'old', sessionFile: oldFile } } : { success: false }))
  const unchanged = await fresh.ctl.newSession()
  ok(unchanged.ok === false, '新建会话后身份没变则返回失败', unchanged.error)

  const created = controller(state, (type) => (type === 'new_session'
    ? { success: true, data: {} }
    : type === 'get_state' ? { success: true, data: { sessionId: 'brand-new', sessionFile: undefined } } : { success: false }))
  const newOk = await created.ctl.newSession()
  ok(newOk.ok === true, '新建会话后身份变化则成功', newOk.error)
}

console.log('--- 终端任务归属按真实路径核对 ---')
{
  resetTerminalJobs()
  const state = { sessionId: 's-1', sessionFile: 'C:\\work\\proj\\s.jsonl', cwd: 'C:\\work\\proj' }
  const { ctl } = controller(state, () => ({ success: false }))
  const job = addTerminalJob({ terminalId: 't1', owners: ['C:/work/proj/s.jsonl'], command: 'npm test', cwd: 'C:/work/proj', startedAt: 1 })
  ok(ctl.hasPendingTerminalWork() === true, '斜杠方向不同也认得同一个会话的后台终端')
  const other = controller({ sessionId: 's-2', sessionFile: 'C:\\work\\other.jsonl' }, () => ({ success: false }))
  ok(other.ctl.hasPendingTerminalWork() === false, '其他会话的后台终端不算本会话的忙')
  resetTerminalJobs()
  ok(ctl.hasPendingTerminalWork() === false, '任务结束后不再算忙', job.id)
}

console.log('--- A4 快捷提问：新建会话失败时清理创建结果 ---')
{
  const abandons = []
  const previous = { sessionId: 'prev-session', sessionFile: '/work/prev.jsonl' }
  const fakeAgent = (state, sent) => ({
    send: async () => sent,
    getState: () => state
  })
  const deps = (applyModel, sent) => ({
    activeRunId: () => 'r1',
    agentOf: (id) => (id === 'r1' ? fakeAgent(previous, { ok: false }) : id === 'r2' ? fakeAgent({ sessionId: 'created', sessionFile: '/work/created.jsonl' }, sent) : null),
    start: async () => ({ ok: true }),
    createSession: async () => ({ ok: true, id: 'r2' }),
    applyModel,
    abandonSession: async (runId, prev) => { abandons.push({ runId, prev }) }
  })

  const modelFailed = await submitQuickAsk(deps(async () => ({ ok: false, error: '模型不可用' }), { ok: true }), { prompt: '写个函数', target: 'new', model: { provider: 'p', id: 'm' } })
  ok(modelFailed.ok === false && modelFailed.code === 'model-failed', '模型准备失败返回 model-failed')
  ok(abandons.length === 1 && abandons[0].runId === 'r2' && abandons[0].prev.runId === 'r1', '失败后要求收回新建的会话并带回原实例')
  ok(abandons[0].prev.sessionId === 'prev-session' && abandons[0].prev.sessionFile === '/work/prev.jsonl', '带回原会话身份')

  abandons.length = 0
  const sendFailed = await submitQuickAsk(deps(async () => ({ ok: true }), { ok: false, error: '发送被拒绝' }), { prompt: '写个函数', target: 'new', model: { provider: 'p', id: 'm' } })
  ok(sendFailed.ok === false && sendFailed.code === 'send-failed', '发送失败返回 send-failed')
  ok(abandons.length === 1, '发送失败也收回新建的空会话')

  abandons.length = 0
  const existing = await submitQuickAsk({
    activeRunId: () => 'r1',
    agentOf: () => fakeAgent(previous, { ok: false, error: '发送被拒绝' }),
    start: async () => ({ ok: true }),
    createSession: async () => ({ ok: false }),
    abandonSession: async (runId, prev) => { abandons.push({ runId, prev }) }
  }, { prompt: '写个函数', target: 'current' })
  ok(existing.ok === false && abandons.length === 0, '当前会话发送失败不收回任何东西')

  abandons.length = 0
  const sends = []
  const running = await submitQuickAsk({
    activeRunId: () => 'r1',
    agentOf: (id) => (id === 'r1'
      ? { send: async (text) => { sends.push(text); return { ok: true } }, getState: () => previous }
      : fakeAgent({ sessionId: 'created' }, { ok: true })),
    start: async () => ({ ok: true }),
    createSession: async () => ({ ok: true, id: 'r2' }),
    applyModel: async () => ({ ok: true }),
    abandonSession: async (runId, prev) => { abandons.push({ runId, prev }) }
  }, { prompt: '  写个函数  ', target: 'current' })
  ok(running.ok === true && sends.length === 1 && sends[0] === '写个函数', '正常路径原样发送去掉首尾空白的提问')
  ok(abandons.length === 0, '正常路径不收回会话')
}

console.log('--- B4 会话移动：文件锁与逐字节保留 ---')
{
  const dir = join(root, 'move')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  const header = Buffer.from(`${JSON.stringify({ type: 'session', version: 3, id: 'abc', cwd: 'C:\\old\\proj' })}\r\n`, 'utf8')
  const body = Buffer.concat([Buffer.from('{"type":"message","id":"1","message":{"role":"user","content":"hi"}}\r\n', 'utf8'), Buffer.from([0x80, 0xff, 0x0a])])
  await writeFile(file, Buffer.concat([header, body]))

  const rewritten = await move.rewriteSessionCwd(file, 'D:\\new\\proj')
  const after = await readFile(file)
  ok(rewritten.previousCwd === 'C:\\old\\proj', '返回原来的工作目录')
  const firstLineEnd = after.indexOf(0x0a)
  const firstLine = after.subarray(0, firstLineEnd).toString('utf8')
  ok(JSON.parse(firstLine).cwd === 'D:\\new\\proj', '会话头改到新目录')
  ok(firstLine.endsWith('\r'), '会话头的 CRLF 保持')
  ok(Buffer.compare(after.subarray(firstLineEnd + 1), body) === 0, '首行之后逐字节保留（含非法 UTF-8 字节）')
  ok((await readdir(dir)).filter((name) => name.includes('.tmp')).length === 0, '没有留下临时文件')

  const lease = move.beginSessionMove(file)
  ok(!!lease && move.sessionMoveInProgress(file) === true, '拿到会话移动锁')
  ok(move.beginSessionMove(file) === null, '同一会话不能同时拿两把锁')
  let rejected = false
  try {
    await move.rewriteSessionCwd(file, 'E:\\x')
  } catch {
    rejected = true
  }
  ok(rejected, '锁被占用时无租约改写被拒绝')
  const withLease = await move.rewriteSessionCwd(file, 'E:\\x', lease)
  ok(withLease.previousCwd === 'D:\\new\\proj' && move.sessionMoveInProgress(file) === true, '持租约时改写成功且锁仍在')
  const restored = await move.restoreSessionHeaderCwd(file, 'C:\\old\\proj', lease)
  ok(restored && move.sessionHeaderCwd(await readFile(file, 'utf8')) === 'C:\\old\\proj', '失败回滚能把工作目录改回去')
  lease.release()
  ok(move.sessionMoveInProgress(file) === false, '释放后锁消失')
  await move.rewriteSessionCwd(file, 'E:\\y')
  ok(move.sessionHeaderCwd(await readFile(file, 'utf8')) === 'E:\\y', '释放后可以直接改写')

  const bad = join(dir, 'bad.jsonl')
  const badBytes = Buffer.from('{"type":"message"}\n{"type":"message"}\n', 'utf8')
  await writeFile(bad, badBytes)
  let threw = false
  try {
    await move.rewriteSessionCwd(bad, 'E:\\z')
  } catch {
    threw = true
  }
  ok(threw && Buffer.compare(await readFile(bad), badBytes) === 0, '不是会话文件时拒绝改写且原字节不动')
  ok(move.sessionMoveInProgress(bad) === false, '拒绝后不留锁')
}

console.log('--- A3 重启保护用的完整忙状态 ---')
{
  const states = new Map()
  const makeAgent = (id) => {
    const state = {
      sessionId: `session-${id}`,
      isAgentRunning: false,
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      bash: false,
      terminal: false,
      pendingUi: 0,
      queue: { steering: [], followUp: [] }
    }
    states.set(id, state)
    return {
      getState: () => ({
        sessionId: state.sessionId,
        isAgentRunning: state.isAgentRunning,
        isStreaming: state.isStreaming,
        isCompacting: state.isCompacting,
        pendingMessageCount: state.pendingMessageCount
      }),
      getConn: () => ({ state: 'ready' }),
      getPendingUiCount: () => state.pendingUi,
      hasRunningBash: () => state.bash,
      hasPendingTerminalWork: () => state.terminal,
      queueSnapshot: () => state.queue,
      start: async () => ({ ok: true }),
      newSession: async () => ({ ok: true }),
      switchSession: async () => ({ ok: true }),
      stop: async () => {},
      setRunnerGeneration: () => {}
    }
  }
  const registry = new RunnerRegistry({ createAgent: (id) => makeAgent(id) })
  const project = join(root, 'work', 'proj')
  const created = await registry.select({ cwd: project })
  ok(created.ok === true, '测试用运行实例已建立', created.error)
  const nested = await registry.select({ cwd: join(project, 'packages', 'app') })
  ok(nested.ok === true, '重叠目录的第二个运行实例已建立', nested.error)
  const state = states.get(created.id)
  const other = nested.id
  ok(registry.hasPendingWorkExcept(other) === false, '空闲时没有待完成的活')
  ok(registry.busyRoots().length === 0, '空闲时没有忙的工作根', registry.busyRoots().join(','))
  state.bash = true
  ok(registry.hasPendingWorkExcept(other) === true, '用户 bash 在跑算忙')
  ok(registry.hasPendingWorkExcept(created.id) === false && registry.hasBusy() === true, '被排除的实例自己不算「其他会话在忙」')
  ok(registry.hasBusyWorkspace(join(project, 'packages', 'app')) === true, '父目录的忙实例也算子目录重叠')
  ok(registry.hasBusyCwd(join(project, 'packages', 'app')) === false, '旧的目录相等判断本身不会命中子目录')
  ok(registry.hasBusyWorkspace(join(root, 'work', 'sibling')) === false, '兄弟目录不算重叠')
  ok(registry.busyRoots().length === 1 && registry.busyRoots()[0] === project, '忙根集合只含真正在写的目录', registry.busyRoots().join(','))
  state.bash = false
  state.queue = { steering: ['留着等下发'], followUp: [] }
  ok(registry.hasPendingWorkExcept(other) === true, '还有排队消息算忙')
  ok(registry.busyRoots().includes(project), '有排队消息的目录也算忙根', registry.busyRoots().join(','))
  state.queue = { steering: [], followUp: [] }
  state.terminal = true
  ok(registry.hasPendingWorkExcept(other) === true, '后台终端任务算忙')
  state.terminal = false
  state.pendingMessageCount = 2
  ok(registry.hasPendingWorkExcept(other) === true, 'pi 侧待处理消息算忙')
  state.pendingMessageCount = 0
  state.isCompacting = true
  ok(registry.hasPendingWorkExcept(other) === true, '压缩中算忙')
  state.isCompacting = false
  state.pendingUi = 1
  ok(registry.hasBusy() === true, '待答复的审批算忙')
  state.pendingUi = 0
  ok(registry.busyRoots().length === 0, '状态清空后忙根集合也清空', registry.busyRoots().join(','))
  const admission = registry.admitExecute(created.id)
  ok(admission.ok === true, '取得执行入场名额', admission.error)
  ok(registry.busyRoots().includes(project), '已入场但尚未返回的工作也算忙根', registry.busyRoots().join(','))
  registry.releaseExecute(created.id, admission.token)
  ok(registry.busyRoots().length === 0, '释放入场名额后忙根消失', registry.busyRoots().join(','))
  await registry.stopAll()
}

console.log('--- 延后模型切换失败时不发出消息 ---')
{
  const sessionId = 'sess-deferred'
  const sessionFile = join(root, 'deferred.jsonl')
  const calls = []
  const model = { provider: 'p', id: 'm', name: 'M' }
  const { ctl } = controller({ sessionId, sessionFile, cwd: root, isStreaming: false, isCompacting: false }, (type) => {
    calls.push(type)
    if (type === 'set_model') return { success: false, error: '模型不可用' }
    if (type === 'get_state') return { success: true, data: { sessionId, sessionFile, model: { provider: 'old', id: 'old', name: 'Old' }, thinkingLevel: 'off' } }
    return { success: true, data: {} }
  })
  writePendingModelSwitch(sessionId, { provider: 'p', id: 'm' })
  ctl.deferredModelSwitch = { sessionId, model, previousModel: undefined, previousThinkingLevel: 'off' }
  const failed = await ctl.send('帮我改一下')
  ok(failed.ok === false && /p\/m/.test(failed.error ?? ''), '切换失败时返回带模型名的失败', failed.error)
  ok(!calls.includes('prompt'), '切换失败不再发送消息', calls.join(','))
  ok(readPendingModelSwitch(sessionId) === null, '失败的待切换记录已清掉')

  calls.length = 0
  const okCtl = controller({ sessionId, sessionFile, cwd: root, isStreaming: false, isCompacting: false }, (type) => {
    calls.push(type)
    if (type === 'set_model') return { success: true, data: {} }
    if (type === 'get_state') return { success: true, data: { sessionId, sessionFile, model: { provider: 'p', id: 'm', name: 'M' }, thinkingLevel: 'off' } }
    return { success: true, data: {} }
  })
  writePendingModelSwitch(sessionId, { provider: 'p', id: 'm' })
  okCtl.ctl.deferredModelSwitch = { sessionId, model, previousModel: undefined, previousThinkingLevel: 'off' }
  const sentOk = await okCtl.ctl.send('帮我改一下')
  ok(sentOk.ok === true, '切换成功后才发送消息', sentOk.error)
  ok(calls.includes('set_model') && calls.indexOf('set_model') < calls.indexOf('prompt'), '先切模型再发 prompt', calls.join(','))
}

console.log('--- set_model 抛错时返回失败、不发消息 ---')
{
  const sessionId = 'sess-throw'
  const sessionFile = join(root, 'throw.jsonl')
  const calls = []
  const model = { provider: 'p', id: 'm', name: 'M' }
  const throwing = (type) => {
    calls.push(type)
    if (type === 'set_model') throw new Error('ipc timeout')
    if (type === 'get_state') return { success: true, data: { sessionId, sessionFile, model: { provider: 'old', id: 'old', name: 'Old' }, thinkingLevel: 'off' } }
    return { success: true, data: {} }
  }
  const direct = controller({ sessionId, sessionFile, cwd: root, isStreaming: false, isCompacting: false }, throwing)
  const directRes = await direct.ctl.setModel('p', 'm')
  ok(directRes.ok === false && /ipc timeout/.test(directRes.error ?? ''), '直连 setModel 遇到 set_model 抛错时返回失败而不是抛异常', directRes)

  calls.length = 0
  const deferring = controller({ sessionId, sessionFile, cwd: root, isStreaming: false, isCompacting: false }, throwing)
  writePendingModelSwitch(sessionId, { provider: 'p', id: 'm' })
  deferring.ctl.deferredModelSwitch = { sessionId, model, previousModel: undefined, previousThinkingLevel: 'off' }
  const failed = await deferring.ctl.send('帮我改一下')
  ok(failed.ok === false && /ipc timeout/.test(failed.error ?? ''), '延后切换遇到 set_model 抛错时返回失败', failed.error)
  ok(!calls.includes('prompt'), '抛错时不发 prompt', calls.join(','))
}

console.log('--- 换会话后回填保存的排队消息 ---')
{
  const targetId = 'sess-queue-target'
  const targetFile = join(root, 'queue-target.jsonl')
  const oldFile = join(root, 'queue-old.jsonl')
  await writeSession(targetFile, { id: targetId, cwd: root })
  await writeSession(oldFile, { id: 'queue-old', cwd: root })
  await saveQueue({ sessionId: targetId, steering: ['排队的插话'], followUp: [] })
  const { ctl, pushes } = controller({ sessionId: 'queue-old', sessionFile: oldFile, cwd: root, isStreaming: false, isCompacting: false }, (type) => {
    if (type === 'switch_session') return { success: true, data: {} }
    if (type === 'get_state') return { success: true, data: { sessionId: targetId, sessionFile: targetFile } }
    return { success: false }
  })
  delete ctl.reclaimSavedQueue
  const switched = await ctl.switchSession(targetFile)
  ok(switched.ok === true, '切到目标会话', switched.error)
  const reclaimed = pushes.find((item) => item.ch === 'queue-reclaimed')
  ok(!!reclaimed && reclaimed.payload.sessionId === targetId, '发出回填排队消息的推送', reclaimed ? reclaimed.ch : 'none')
  ok(reclaimed?.payload?.items?.steering?.[0]?.text === '排队的插话', '回填内容正确')
  ok(reclaimed?.suppressed === false, '回填推送在换会话的静默窗口之后发出', pushes.map((item) => `${item.ch}${item.suppressed ? '(suppressed)' : ''}`).join(','))
}

await rm(root, { recursive: true, force: true })
console.log(`\n会话核心：${passed} 项通过${failed ? `，${failed} 项失败` : ''}`)
process.exit(failed ? 1 : 0)
