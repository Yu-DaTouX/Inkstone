#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const dataDir = await mkdtemp(join(tmpdir(), 'inkstone-queue-coordinator-'))
process.env.YAN_DATA_DIR = dataDir

try {
  await runSuite(import.meta.url, async (ok, compile) => {
    const { QueueCoordinator } = await compile('src/main/queue-coordinator.ts')
    const red = { data: 'cmVk', mimeType: 'image/png' }
    const blue = { data: 'Ymx1ZQ==', mimeType: 'image/png' }

    const harness = (options = {}) => {
      const pushes = []
      const deferred = []
      const env = {
        owner: { rpc: options.rpc ?? null, sessionId: options.sessionId ?? 's1', generation: 1 },
        loopStopping: false,
        admitted: true,
        suppress: false
      }
      const queue = new QueueCoordinator({
        owner: () => env.owner,
        push: (message) => pushes.push(message),
        pushAfterScope: (emit) => (env.suppress ? deferred.push(emit) : emit()),
        loopStopping: () => env.loopStopping,
        confirmAdmission: () => env.admitted
      })
      return { queue, pushes, deferred, env }
    }
    const fakeRpc = (handler) => {
      const calls = []
      return { calls, running: true, command: async (command, payload) => { calls.push([command, payload]); return handler(command, payload, calls) } }
    }
    const started = async (queue, promise) => {
      let entered = false
      const running = queue.run(() => { entered = true; return promise })
      for (let i = 0; i < 50 && !entered; i++) await new Promise((resolve) => setTimeout(resolve, 1))
      return { running }
    }
    const gate = () => {
      let open
      const promise = new Promise((resolve) => { open = resolve })
      return { promise, open }
    }

    {
      const { queue, pushes } = harness()
      queue.publish(['a'], ['b', 'c'])
      ok(queue.state.steering.length === 1 && queue.state.followUp.length === 2, 'publish 按 pi 文本建立队列项')
      const ids = queue.state.followUp.map((item) => item.id)
      queue.publish(['a'], ['b', 'c'])
      ok(JSON.stringify(queue.state.followUp.map((item) => item.id)) === JSON.stringify(ids), '同样的文本再次发布时保留队列项身份')
      queue.publish([], ['<subagent-notification id="a" status="done">\n完成\n这是宿主自动发出的通知，不是用户的新消息：请据此继续原任务或汇总结果，不要复述本通知。'])
      ok(pushes.at(-1).ch === 'queue' && pushes.at(-1).payload.followUp.length === 0, '推给界面的队列过滤子代理通知')
    }

    {
      const { queue } = harness()
      queue.state = { steering: [], followUp: [{ id: 'r', text: 'same', images: [red] }, { id: 'b', text: 'same', images: [blue] }] }
      queue.consume('same', [blue])
      ok(queue.state.followUp.map((item) => item.id).join() === 'r', '同文本按图片消费对应的那一项')
      queue.consume('same', [])
      ok(queue.state.followUp.length === 1, '图片不匹配时不误消费')
    }

    {
      const { queue, env } = harness()
      const first = gate()
      const { running } = await started(queue, first.promise)
      let lateRan = false
      const late = queue.run(async () => { lateRan = true }).catch((error) => error.message)
      env.owner = { ...env.owner, generation: 2 }
      first.open()
      await running
      ok(/会话已切换/.test(await late) && !lateRan, '排队等待的操作在代次变化后被拒绝且不执行')
    }

    {
      const { queue, env } = harness()
      const first = gate()
      const { running } = await started(queue, first.promise)
      queue.applyUpdate({ steering: [], followUp: ['late'], sessionId: 's1', generation: 1 })
      ok(queue.state.followUp.length === 0, '操作进行中收到的队列帧先挂起')
      first.open()
      await running
      ok(queue.state.followUp.map((item) => item.text).join() === 'late', '操作结束后挂起的帧按原归属落地')

      const second = gate()
      const { running: again } = await started(queue, second.promise)
      queue.applyUpdate({ steering: [], followUp: ['other-session'], sessionId: 's1', generation: 1 })
      env.owner = { ...env.owner, sessionId: 's2' }
      second.open()
      await again
      ok(!queue.state.followUp.some((item) => item.text === 'other-session'), '会话已切换时挂起的旧帧被丢弃')
    }

    {
      const { queue, env } = harness()
      env.loopStopping = true
      ok(/流式防护/.test(await queue.run(async () => 1).catch((error) => error.message)), '流式防护终止中拒绝普通队列操作')
      ok((await queue.run(async () => 1, true)) === 1, '流式防护自己的操作可以进入')
      env.loopStopping = false
      env.admitted = false
      ok(/入场已失效/.test(await queue.run(async () => 1).catch((error) => error.message)), '执行入场失效时操作不开始')
    }

    {
      const rpc = fakeRpc(() => ({ success: false, error: 'rejected' }))
      const { queue } = harness({ rpc })
      const res = await queue.run(() => queue.submit('follow_up', 'x', [red], 'followUp', queue.payload({ text: 'x', images: [red] })))
      ok(res.success === false && queue.isEmpty(), '提交失败时撤回预先放入的队列项')
      ok(rpc.calls[0][1].images?.[0]?.type === 'image', '提交载荷带上图片')
    }

    {
      const rpc = fakeRpc((command) => command === 'clear_queue' ? { success: false, error: '注入失败' } : { success: true, data: {} })
      const { queue } = harness({ rpc })
      queue.state = { steering: [], followUp: [{ id: 'k1', text: 'keep', images: [red] }, { id: 'k2', text: 'two' }] }
      const res = await queue.editItem('k1', false)
      ok(!res.ok && /注入失败/.test(res.error) && queue.state.followUp.map((item) => item.id).join() === 'k1,k2', 'clear_queue 失败时队列原样保留')
    }

    {
      let live = []
      const rpc = fakeRpc((command, payload) => {
        if (command === 'clear_queue') { const data = { steering: [], followUp: live.map((item) => item.text) }; live = []; return { success: true, data } }
        live.push({ text: payload.message })
        return { success: true, data: {} }
      })
      const { queue } = harness({ rpc })
      queue.state = { steering: [], followUp: [{ id: 'm1', text: 'one' }, { id: 'm2', text: 'two' }] }
      live = [{ text: 'one' }, { text: 'two' }]
      const removed = await queue.editItem('m1', false)
      ok(removed.ok && removed.text === 'one' && queue.state.followUp.map((item) => item.text).join() === 'two', '撤回一条：返回原文，其余重新排队')
      ok(live.map((item) => item.text).join() === 'two', 'pi 侧只剩未撤回的消息')
    }

    {
      const { queue, pushes } = harness({ sessionId: 'persist-1' })
      queue.publish([], ['saved text'])
      await queue.written
      const file = join(dataDir, 'queue-recovery', 'persist-1.json')
      ok(existsSync(file) && (await readFile(file, 'utf8')).includes('saved text'), '队列变化后写入恢复文件')
      queue.reset(true)
      queue.clearSaved()
      await queue.written
      ok(!existsSync(file), '清空并清除保存后恢复文件被删除')
      ok(pushes.at(-1).ch === 'queue' && pushes.at(-1).payload.followUp.length === 0, 'reset(true) 推送空队列')
    }

    {
      const writer = harness({ sessionId: 'reclaim-1' })
      writer.queue.publish(['steer me'], ['later'])
      await writer.queue.flush()
      const { queue, pushes, deferred, env } = harness({ sessionId: 'reclaim-1' })
      env.suppress = true
      await queue.reclaimSaved()
      ok(!pushes.some((message) => message.ch === 'queue-reclaimed') && deferred.length === 1, '会话切换期间回收通知延后推送')
      deferred[0]()
      const reclaimed = pushes.find((message) => message.ch === 'queue-reclaimed')
      ok(reclaimed?.payload.steering.join() === 'steer me' && reclaimed.payload.followUp.join() === 'later', '回收通知带回保存的插话与排队')
    }

    {
      const rpc = fakeRpc((command) => command === 'clear_queue' ? { success: true, data: { steering: ['s'], followUp: ['f'] } } : { success: true })
      const { queue } = harness({ rpc, sessionId: 'stop-1' })
      queue.publish(['s'], ['f'])
      const cleared = await queue.clearForStop()
      await queue.written
      ok(cleared.steering.join() === 's' && cleared.followUp.join() === 'f' && queue.isEmpty(), '停止时清空并交回原队列内容')
    }
  })
} finally {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
