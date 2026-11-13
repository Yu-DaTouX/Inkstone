import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((done) => setTimeout(done, 20))
  }
  return predicate()
}

function makeRpc() {
  const handlers = new Map()
  const rpc = {
    running: false,
    closed: false,
    background: false,
    on(event, listener) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener])
      return rpc
    },
    spawn() { rpc.running = true },
    async command(type) {
      if (type === 'get_state') return { success: true, data: {} }
      return { success: true }
    },
    async close() {
      rpc.running = false
      rpc.closed = true
    },
    hasBackgroundWork: () => rpc.background,
    emit(event, ...payload) {
      for (const listener of handlers.get(event) ?? []) listener(...payload)
    }
  }
  return rpc
}

const reply = (text) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } })

await runSuite(import.meta.url, async (ok, compile) => {
  const host = await compile('src/main/background-bash.ts')
  let idle = 0
  const bash = new host.BackgroundBashCommands({ ownerKeys: () => ['sub-1'], now: () => Date.now(), notify: () => {}, onIdle: () => { idle += 1 } }, 20)
  ok(bash.busy() === false, '没有后台命令时不忙')
  await bash.run({ action: 'watch', id: 'bg-wait1111', command: 'npm test', cwd: 'C:/p' })
  ok(bash.busy() === true && idle === 0, '监视登记后算作有后台命令')
  await bash.run({ action: 'end', id: 'bg-wait1111', exitCode: 0, notice: 'x' })
  ok(bash.busy() === false && idle === 1, '最后一条后台命令结束时通知空闲')
  bash.dispose()

  const { SubagentController } = await compile('src/main/subagents.ts')
  const archive = await mkdtemp(join(tmpdir(), 'inkstone-subagent-bg-wait-'))
  const rpcs = []
  let finished = 0
  const ctrl = new SubagentController({
    cwd: archive, archiveDir: archive,
    prepare: async (rootCwd, _id, isolation) => ({ isolation, rootCwd, cwd: rootCwd }),
    createRpc: () => { const rpc = makeRpc(); rpcs.push(rpc); return rpc },
    onChange: () => {}, onFinished: () => { finished += 1 }
  })
  try {
    const started = await ctrl.start('跑测试并报告', undefined, 'shared-cwd')
    ok(started.ok === true, '假 RPC 启动成功', started.error ?? '')
    const id = started.run.id
    const rpc = rpcs[0]
    rpc.background = true
    rpc.emit('event', reply('测试仍在后台运行，等通知后再报告'))
    rpc.emit('event', { type: 'agent_settled' })
    await new Promise((done) => setTimeout(done, 100))
    const waiting = ctrl.get(id)
    ok(waiting.status === 'running' && finished === 0 && !rpc.closed, '后台命令未结束时停下不算完成，也不通知主会话', JSON.stringify({ status: waiting.status, finished }))
    ok(waiting.latestActivity === '等待后台命令结束', '状态写明在等后台命令', waiting.latestActivity)

    rpc.background = false
    rpc.emit('event', { type: 'agent_start' })
    rpc.emit('event', reply('最终报告'))
    rpc.emit('event', { type: 'agent_settled' })
    ok(await waitFor(() => finished === 1), '后台命令结束、子代理再次停下后正常收口')
    ok(ctrl.get(id).status === 'done' && rpc.closed, '收口为完成并关闭子进程', ctrl.get(id).status)
  } finally {
    await ctrl.stopAll()
    await rm(archive, { recursive: true, force: true })
  }
})
