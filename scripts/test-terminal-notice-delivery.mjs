#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const entryDir = await mkdtemp(join(tmpdir(), 'inkstone-terminal-notice-'))
const source = (path) => resolve(path).replace(/\\/g, '/')
const entry = join(entryDir, 'entry.ts')
await writeFile(entry, [
  `export { TerminalNoticeDelivery } from '${source('src/main/terminal-notice-delivery.ts')}'`,
  `export { addTerminalJob, resetTerminalJobs, updateTerminalJob } from '${source('src/main/terminal-jobs.ts')}'`
].join('\n'))

try {
  await runSuite(import.meta.url, async (ok, compile) => {
    const { TerminalNoticeDelivery, addTerminalJob, resetTerminalJobs, updateTerminalJob } = await compile(entry)

    const harness = (initial = {}) => {
      const env = {
        session: { stopping: false, ready: true, running: false, ...initial },
        keys: ['C:/work/s.jsonl', 's1'],
        steerResult: { ok: true },
        followUpResult: { ok: true },
        calls: [],
        waits: 0,
        onWait: undefined
      }
      const delivery = new TerminalNoticeDelivery({
        session: () => env.session,
        ownerKeys: () => env.keys,
        steer: async (text) => { env.calls.push(['steer', text]); return env.steerResult },
        followUp: async (text) => { env.calls.push(['followUp', text]); return env.followUpResult },
        submitHeld: async (text) => { env.calls.push(['held', text]) },
        wait: async () => { env.waits += 1; env.onWait?.(env.waits) }
      })
      return { delivery, env }
    }
    const owned = () => true

    {
      const { delivery, env } = harness({ running: true })
      await delivery.deliver('running notice', owned, false)
      ok(JSON.stringify(env.calls) === JSON.stringify([['steer', 'running notice']]), '回合进行中把通知插入本轮')
    }

    {
      const { delivery, env } = harness()
      await delivery.deliver('wake notice', owned, true)
      ok(JSON.stringify(env.calls) === JSON.stringify([['followUp', 'wake notice']]), '空闲且需要唤醒时作为新消息发出')
    }

    {
      const { delivery, env } = harness()
      let stillMine = true
      await delivery.deliver('held one', () => stillMine, false)
      await delivery.deliver('held two', owned, false)
      ok(env.calls.length === 0, '空闲且不唤醒时先留着不发')
      stillMine = false
      await delivery.flushHeld()
      ok(JSON.stringify(env.calls) === JSON.stringify([['held', 'held two']]), '下次发送前只补发仍属于本会话的通知')
      await delivery.flushHeld()
      ok(env.calls.length === 1, '补发后不再重复')
    }

    {
      const { delivery, env } = harness()
      for (let i = 0; i < 12; i++) await delivery.deliver(`n${i}`, owned, false)
      await delivery.flushHeld()
      ok(env.calls.length === 10 && env.calls[0][1] === 'n2' && env.calls.at(-1)[1] === 'n11', '留存的通知只保留最近 10 条')
    }

    {
      const { delivery, env } = harness({ stopping: true, running: true })
      await delivery.deliver('stopping', owned, true)
      const other = harness({ running: true })
      await other.delivery.deliver('not mine', () => false, true)
      ok(env.calls.length === 0 && other.env.calls.length === 0, '会话停止或不再归属时丢弃通知')
      ok(!delivery.hasPendingWork() && env.waits === 0, '丢弃后不再算有待投递的通知')
    }

    {
      const { delivery, env } = harness({ ready: false })
      let pendingWhileWaiting
      env.onWait = (count) => {
        pendingWhileWaiting = delivery.hasPendingWork()
        if (count === 2) env.session = { ...env.session, ready: true, running: true }
      }
      await delivery.deliver('later', owned, false)
      ok(pendingWhileWaiting === true, '等待会话就绪期间算作有待投递的通知')
      ok(env.waits === 2 && JSON.stringify(env.calls) === JSON.stringify([['steer', 'later']]), '会话就绪后再投递')
      ok(!delivery.hasPendingWork(), '投递完成后不再算忙')
    }

    {
      const { delivery, env } = harness({ running: true })
      env.steerResult = { ok: false }
      const warn = console.warn
      const warnings = []
      console.warn = (message) => warnings.push(message)
      try {
        await delivery.deliver('flaky', owned, false)
      } finally {
        console.warn = warn
      }
      ok(env.calls.length === 5 && env.waits === 5, '连续失败 5 次后放弃')
      ok(warnings.length === 1 && !delivery.hasPendingWork(), '放弃时记录一次警告并释放忙碌标记')
    }

    {
      resetTerminalJobs()
      const { delivery, env } = harness()
      const job = addTerminalJob({ terminalId: 't1', owners: ['C:\\work\\s.jsonl'], command: 'npm test', cwd: 'C:/work', startedAt: 1 })
      ok(delivery.hasPendingWork(), '本会话还有运行中的后台终端时算忙')
      env.keys = ['other']
      ok(!delivery.hasPendingWork(), '其他会话的后台终端不算本会话的忙')
      env.keys = []
      ok(!delivery.hasPendingWork(), '没有会话身份时不算忙')
      env.keys = ['s1', 'C:/work/s.jsonl']
      updateTerminalJob(job.id, { state: 'exited', endedAt: 2 })
      ok(!delivery.hasPendingWork(), '后台终端结束后不再算忙')
      resetTerminalJobs()
    }
  })
} finally {
  await rm(entryDir, { recursive: true, force: true })
}
