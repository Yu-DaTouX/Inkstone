import { readFile } from 'node:fs/promises'
import { runSuite } from './lib/test-suite.mjs'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

await runSuite(import.meta.url, async (ok, compile) => {
  const { scheduleIdleTask } = await compile('src/main/idle-schedule.ts')
  const fakeTimers = () => {
    const queue = []
    return {
      queue,
      set: (run, ms) => { const handle = { run, ms, cleared: false }; queue.push(handle); return handle },
      clear: (handle) => { if (handle) handle.cleared = true },
      async fire() {
        const next = queue.shift()
        if (!next || next.cleared) return next
        next.run()
        await new Promise((resolve) => setImmediate(resolve))
        return next
      }
    }
  }

  const timers = fakeTimers()
  let busy = true
  let runs = 0
  let failNext = false
  const logs = []
  const stop = scheduleIdleTask({
    name: 'checkpoint prune',
    firstDelayMs: MINUTE,
    intervalMs: 8 * HOUR,
    retryMs: 10 * MINUTE,
    isBusy: () => busy,
    run: async () => { runs++; if (failNext) { failNext = false; throw new Error('boom') } },
    timers,
    log: (line) => logs.push(line)
  })
  ok(timers.queue.length === 1 && timers.queue[0].ms === MINUTE, '启动后先等首轮延迟')
  await timers.fire()
  ok(runs === 0 && timers.queue[0].ms === 10 * MINUTE, '有回合在跑时不执行，推迟一段后再看')
  busy = false
  await timers.fire()
  ok(runs === 1 && timers.queue[0].ms === 8 * HOUR, '空闲时执行一次，然后按周期排下一次（不是只跑一次）')
  await timers.fire()
  ok(runs === 2 && timers.queue[0].ms === 8 * HOUR, '常驻不重启时继续周期执行')
  failNext = true
  await timers.fire()
  ok(runs === 3 && logs.length === 1 && /checkpoint prune failed: boom/.test(logs[0]) && timers.queue[0].ms === 8 * HOUR, '执行失败记日志，不中断后续周期')
  stop()
  const pending = await timers.fire()
  ok(pending.cleared && runs === 3, '停止后不再执行')

  const retryTimers = fakeTimers()
  let attempts = 0
  scheduleIdleTask({ name: 'attachments', firstDelayMs: 3 * MINUTE, intervalMs: 24 * HOUR, retryMs: 10 * MINUTE, isBusy: () => false, run: async () => ++attempts > 1, timers: retryTimers })
  await retryTimers.fire()
  ok(retryTimers.queue[0].ms === 10 * MINUTE, '任务说要重试（比如扫描期间会话有变化）时按短间隔重来')
  await retryTimers.fire()
  ok(retryTimers.queue[0].ms === 24 * HOUR, '完成后回到每天一次')

  const backoffTimers = fakeTimers()
  const outcomes = [false, false, false, false, true, false, 'busy', false]
  scheduleIdleTask({ name: 'attachments', firstDelayMs: 3 * MINUTE, intervalMs: 24 * HOUR, retryMs: 10 * MINUTE, backoffMs: [10 * MINUTE, HOUR, 6 * HOUR], isBusy: () => false, run: async () => outcomes.shift(), timers: backoffTimers })
  const delays = []
  for (let i = 0; i < 8; i++) {
    await backoffTimers.fire()
    delays.push(backoffTimers.queue[0].ms / MINUTE)
  }
  ok(JSON.stringify(delays) === JSON.stringify([10, 60, 360, 360, 1440, 10, 10, 60]), '扫描期间会话连续变化时逐次退避 10 分钟→1 小时→6 小时，成功一次后复位；回合占用只按短间隔重试', JSON.stringify(delays))

  const source = await readFile('src/main/data-maintenance.ts', 'utf8')
  ok(/run: \(\) => pruneCheckpoints\(\)/.test(source) && /intervalMs: 8 \* HOUR_MS/.test(source), '检查点清理接入周期任务，间隔 8 小时')
  ok(/firstDelayMs: 3 \* MINUTE_MS/.test(source) && /intervalMs: 24 \* HOUR_MS/.test(source) && /backoffMs: \[10 \* MINUTE_MS, HOUR_MS, 6 \* HOUR_MS\]/.test(source), '附件自动清理启动 3 分钟后首跑，之后每天一次')
  const index = await readFile('src/main/index.ts', 'utf8')
  ok(!/setTimeout\(\(\) => void pruneCheckpoints/.test(index) && /startDataMaintenance\(/.test(index) && /shell\.trashItem\(file\)/.test(index), '入口不再只跑一次检查点清理，附件清理经系统回收站')
})
