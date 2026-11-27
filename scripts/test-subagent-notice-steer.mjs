import './lib/test-isolate.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runSuite } from './lib/test-suite.mjs'

const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      loader: 'js',
      contents: [
        'export const shell = { openPath: async () => "" }',
        'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
        'export const ipcMain = { handle: () => undefined }',
        'export const BrowserWindow = class {}',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (value) => Buffer.from(String(value)), decryptString: (value) => Buffer.from(value).toString() }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
        'export const session = { defaultSession: {}, fromPartition: () => ({ setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined }) }'
      ].join('\n')
    }))
  }
}

await runSuite(import.meta.url, async (ok) => {
  const root = await mkdtemp(join(tmpdir(), 'yan-notice-steer-'))
  try {
    const entry = join(root, 'entry.ts')
    const outfile = join(process.cwd(), 'out', 'test', 'subagent-notice-steer.mjs')
    const source = fileURLToPath(new URL('../src/main/agent.ts', import.meta.url)).replace(/\\/g, '/')
    await writeFile(entry, `export { AgentController } from '${source}'\nexport { StreamLoopGuard } from '${source.replace(/agent\.ts$/, 'stream-loop-guard.ts')}'`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'], plugins: [electronStub] })
    const { AgentController, StreamLoopGuard } = await import(pathToFileURL(outfile).href)

    const make = ({ running = true, fromUser = true, beforeCommit } = {}) => {
      const agent = Object.create(AgentController.prototype)
      const submitted = []
      agent.agentRunning = running
      agent.runFromUser = fromUser
      agent.loopGuard = new StreamLoopGuard()
      agent.acp = {}
      agent.rpc = { running: true }
      agent.state = { sessionId: 's1' }
      agent.capabilityOpts = { runnerGeneration: 1 }
      agent.queue = {
        run: async (fn) => { await beforeCommit?.(agent); return fn() },
        payload: (item) => ({ message: item.text }),
        submit: async (command, text) => { submitted.push({ command, text }); return { success: true } }
      }
      return { agent, submitted }
    }

    const live = make()
    const delivered = await live.agent.steerIntoUserRun('<subagent-notification id="sub-1" status="interrupted">\nx\n</subagent-notification>')
    ok(delivered.ok && live.submitted.length === 1 && live.submitted[0].command === 'steer', '用户发起的一轮正在运行：用 steer 命令插话（pi 的 steer 只排队，不开新一轮）', JSON.stringify(live.submitted))

    const ended = make({ beforeCommit: (agent) => { agent.agentRunning = false } })
    const raced = await ended.agent.steerIntoUserRun('notice')
    ok(!raced.ok && raced.idle === true && ended.submitted.length === 0, '排队等待期间这一轮结束：提交前再查一次，空闲就失败、不提交', JSON.stringify(raced))

    const auto = make({ fromUser: false })
    const skipped = await auto.agent.steerIntoUserRun('notice')
    ok(!skipped.ok && skipped.idle === true && auto.submitted.length === 0, '宿主自发的一轮（额度续跑、通知触发）不附')
    ok(!make({ running: false }).agent.userRunActive() && make().agent.userRunActive() && !make({ fromUser: false }).agent.userRunActive(), 'userRunActive 只在用户发起且正在运行时为真')

    const stopping = make()
    stopping.agent.loopGuard.stopping = true
    const blocked = await stopping.agent.steerIntoUserRun('notice')
    ok(!blocked.ok && blocked.idle === true && stopping.submitted.length === 0, '流式防护正在停止：按空闲处理，不计投递失败')
    const expired = make()
    expired.agent.queue.run = async () => { throw new Error('同一工作目录的执行入场已失效，本次操作未开始') }
    const gated = await expired.agent.steerIntoUserRun('notice')
    ok(!gated.ok && gated.idle === true && expired.submitted.length === 0, '执行入场失效等队列门禁在提交前拒绝：按空闲处理，不计投递失败', JSON.stringify(gated))
    const broken = make()
    broken.agent.queue.submit = async () => { throw new Error('rpc broke') }
    let thrown = ''
    try { await broken.agent.steerIntoUserRun('notice') } catch (error) { thrown = error.message }
    ok(thrown === 'rpc broke', '已经进入队列后提交出错：照常报错、算投递失败')

    const notice = '<subagent-notification id="sub-1" status="interrupted">\nx\n</subagent-notification>'
    const viewer = make()
    const history = []
    viewer.agent.items = { uiMessages: () => history }
    ok(!viewer.agent.noticeSeen(notice, 1_000), '转录里没有这条通知：未送达')
    history.push({ id: 'm1', role: 'user', text: notice, timestamp: 500 })
    ok(!viewer.agent.noticeSeen(notice, 1_000), '只有早于本次中断的同文通知：未送达')
    history.push({ id: 'm2', role: 'assistant', text: notice, timestamp: 2_000 })
    ok(!viewer.agent.noticeSeen(notice, 1_000), '助手消息里的同文不算')
    history.push({ id: 'm3', role: 'user', text: notice.replace('sub-1', 'sub-2'), timestamp: 2_000 })
    ok(!viewer.agent.noticeSeen(notice, 1_000), '别的子代理的通知不算')
    history.push({ id: 'm4', role: 'user', text: notice, timestamp: 2_000 })
    ok(viewer.agent.noticeSeen(notice, 1_000), '本次中断之后的用户消息里出现这条通知：已送达')
    const untimed = make()
    untimed.agent.items = { uiMessages: () => [{ id: 'm1', role: 'user', text: notice }] }
    ok(!untimed.agent.noticeSeen(notice, 1_000), '整个会话都没有时间戳：无法划出本次中断的界线，宁可重投，不判为已送达')
    untimed.agent.items = { uiMessages: () => [{ id: 'm1', role: 'user', text: notice }, { id: 'm2', role: 'user', text: notice }] }
    ok(!untimed.agent.noticeSeen(notice, 1_000), '同一子代理两次中断的同文通知都没带时间戳：不因旧通知误判已送达')
    untimed.agent.items = { uiMessages: () => [{ id: 'm1', role: 'user', text: notice.replace('interrupted', 'done') }] }
    ok(!untimed.agent.noticeSeen(notice, 1_000), '没带时间戳但状态不同：仍判为未送达')
    untimed.agent.items = { uiMessages: () => [{ id: 'm1', role: 'user', text: notice }, { id: 'm2', role: 'assistant', text: 'ok', timestamp: 500 }] }
    ok(!untimed.agent.noticeSeen(notice, 1_000), '同一子代理上一次中断的旧通知（没带时间戳，排在本次中断之前的消息前面）：不算本次已送达')
    untimed.agent.items = { uiMessages: () => [{ id: 'm1', role: 'user', text: notice }, { id: 'm2', role: 'assistant', text: 'ok', timestamp: 500 }, { id: 'm3', role: 'user', text: notice }] }
    ok(untimed.agent.noticeSeen(notice, 1_000), '排在中断之后的同文通知（没带时间戳）：已送达')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
