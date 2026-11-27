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

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

await runSuite(import.meta.url, async (ok) => {
  const root = await mkdtemp(join(tmpdir(), 'yan-acp-dispatch-'))
  try {
    const entry = join(root, 'entry.ts')
    const outfile = join(process.cwd(), 'out', 'test', 'runner-acp-dispatch.mjs')
    const main = (name) => fileURLToPath(new URL(`../src/main/${name}`, import.meta.url)).replace(/\\/g, '/')
    await writeFile(entry, [
      `export { AgentController } from '${main('agent.ts')}'`,
      `export { AntigravityBackend } from '${main('antigravity-backend.ts')}'`,
      `export { StreamLoopGuard, AutoContinueBudget } from '${main('stream-loop-guard.ts')}'`
    ].join('\n'))
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'], plugins: [electronStub] })
    const { AgentController, AntigravityBackend, StreamLoopGuard, AutoContinueBudget } = await import(pathToFileURL(outfile).href)

    {
      const agent = Object.create(AgentController.prototype)
      const seen = []
      agent.capabilityOpts = { runnerGeneration: 1 }
      agent.pendingAborts = 0
      agent.acp = { stopTarget: false, abort: async () => { throw new Error('ACP abort must not run without a stop target') } }
      agent.settleExecutionAdmission = () => {}
      agent.abortCurrent = async function () {
        seen.push({ generation: this.capabilityOpts.runnerGeneration, pending: this.pendingAborts })
        return { steering: [], followUp: [] }
      }
      const stopping = agent.abort(1)
      agent.capabilityOpts.runnerGeneration = 2
      await stopping
      ok(seen.length === 1 && seen[0].generation === 1 && seen[0].pending === 1, '没有 ACP 停止目标时，Pi 停止在调用当拍捕获本代 runner，不会落到下一代', JSON.stringify(seen))
    }

    {
      const agent = Object.create(AgentController.prototype)
      const order = []
      agent.nativeRuntime = { navigateTree: async () => ({ cancelled: false }) }
      agent.capabilityOpts = { runnerGeneration: 1 }
      agent.state = { sessionId: 's1' }
      agent.pendingAborts = 0
      agent.agentRunning = false
      agent.bash = null
      agent.ui = { pending: new Map(), cancelPending: () => order.push('cancel-ui') }
      agent.queue = { reset: () => order.push('reset-queue') }
      agent.operations = { acquire: () => ({ ok: true, lease: 1 }), release: () => order.push('release') }
      agent.acp = { compacting: null, forgetContext: async () => { order.push('forget') } }
      agent.hydrate = async () => { order.push('hydrate') }
      await agent.nativeNavigate('e1')
      ok(order.join(',') === 'reset-queue,cancel-ui,hydrate,release', '纯 Pi 导航不经 ACP 清理，直接重置队列和问题请求', order.join(','))
    }

    {
      const calls = []
      const host = {
        withOperation: () => { throw new Error('ACP send must not run after the connection left') },
        withExecutionAdmission: (task) => task()
      }
      const backend = new AntigravityBackend(host)
      backend.connection = { sessionId: 's1', model: { id: 'flash', name: 'Flash', provider: 'antigravity' }, hasContext: false }
      const refresh = deferred()
      backend.mcpRefreshTask = refresh.promise
      const routing = backend.route('followUp', 'hi', undefined, undefined, async () => { calls.push(backend.connection); return { ok: true, error: 'pi' } })
      backend.connection = undefined
      refresh.resolve()
      const result = await routing
      ok(result.error === 'pi' && calls.length === 1 && calls[0] === undefined, 'MCP 刷新期间 ACP 已断开：route 当场转交 Pi 发送并返回它的结果', JSON.stringify(result))
    }

    {
      const pushed = []
      const backend = new AntigravityBackend({ push: (msg) => pushed.push(msg), state: null })
      backend.connection = { sessionId: 's1', model: { id: 'flash', name: 'Flash', provider: 'antigravity' }, hasContext: false }
      const image = { data: 'aGk=', mimeType: 'image/png' }
      const snapshot = { steering: ['插话'], followUp: ['排队', ''], items: { steering: [{ id: 'a', text: '插话' }], followUp: [{ id: 'b', text: '排队', images: [image] }, { id: 'c', text: '' }] } }
      const restored = backend.restoreSnapshot(snapshot)
      ok(restored.ok && backend.queue.steering.map((item) => item.text).join() === '插话' && backend.queue.followUp.length === 1 && backend.queue.followUp[0].images?.[0].data === image.data,
        'ACP 模式恢复队列快照写回 ACP 队列，保留图片、丢弃空条目', JSON.stringify(backend.queue))
      const again = backend.restoreSnapshot({ steering: ['插话'], followUp: ['排队'] })
      const other = backend.restoreSnapshot({ steering: [], followUp: ['别的'] })
      ok(again.ok && !other.ok && backend.pendingCount === 2, '已有相同排队时幂等，不同则拒绝覆盖', JSON.stringify({ again, other }))
      ok(pushed.some((msg) => msg.ch === 'queue'), '恢复后发布队列')
    }

    {
      const newSessionState = { running: null, last: { status: 'completed', reason: 'manual', startedAt: 1, endedAt: 2 } }
      const host = {
        state: { sessionId: 's1' },
        compactionState: { running: null, last: null },
        contextFrom: undefined,
        rpc: { running: true },
        cwd: process.cwd(),
        stopping: false,
        messages: [
          { id: 'u1', role: 'user', text: '旧问题', timestamp: 1 },
          { id: 'a1', role: 'assistant', text: '旧回答', timestamp: 2, entryId: 'e-a1' }
        ],
        nativeBranchView: false,
        capabilityOpts: { runnerGeneration: 1 },
        operations: { acquire: () => ({ ok: true, lease: 1 }), release: () => {} },
        nativeRuntime: {
          bridgeCapabilities: ['append_antigravity_compaction'],
          appendAntigravityCompaction: async () => {
            host.state = { sessionId: 's2' }
            host.compactionState = newSessionState
            return { entryId: 'compact-1' }
          }
        },
        push: () => {},
        asyncOwner: () => ({ rpc: host.rpc, generation: 1 }),
        ownerCurrent: () => true,
        executionActive: () => false,
        claimExecutionAdmission: () => ({ ok: true }),
        settleExecutionAdmission: () => {},
        readHistoryOf: async () => null,
        hydrate: async () => { throw new Error('stale compaction must not hydrate the new session') },
        refreshStats: async () => { throw new Error('stale compaction must not refresh the new session') }
      }
      const session = {
        context: undefined,
        onEvent: undefined,
        confirmPromptMode: async () => ({}),
        prompt: async () => { session.onEvent({ type: 'text', text: '摘要' }); return 'end_turn' },
        cancel: () => {},
        close: async () => {}
      }
      const backend = new AntigravityBackend(host)
      backend.connection = { sessionId: 's1', model: { id: 'flash', name: 'Flash', provider: 'antigravity' }, hasContext: true, session }
      const result = await backend.runCompaction('manual')
      ok(result.ok && host.compactionState === newSessionState && host.contextFrom === undefined && backend.compacting === null,
        '压缩落盘时已切到别的会话：不覆盖新会话的压缩状态和上下文起点', JSON.stringify({ result, state: host.compactionState, from: host.contextFrom }))
    }

    {
      const guard = new StreamLoopGuard()
      const budget = new AutoContinueBudget()
      guard.trip({ rule: 'repeat' }, 'text', budget.version)
      guard.abortSent = true
      ok(guard.blocking && guard.engaged && guard.resumeVersion === 0 && guard.hit.rule === 'repeat', 'trip 记下命中与触发时的续跑版本')
      guard.clear()
      ok(!guard.blocking && !guard.engaged && guard.hit === undefined && guard.resumeVersion === 0, 'clear 只清停止状态，保留续跑凭据')
      budget.consume()
      ok(budget.spent, '续跑预算一次即用完')
      budget.invalidate()
      ok(budget.spent && budget.version === 1, 'invalidate 只让旧续跑失效，不恢复额度')
      budget.restart()
      ok(!budget.spent && budget.version === 2, 'restart 开新任务：版本前进并恢复额度')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
