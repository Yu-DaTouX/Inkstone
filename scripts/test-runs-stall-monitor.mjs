import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

function fakeTimers() {
  const tasks = []
  const schedule = (fn, ms) => {
    const handle = { fn, ms, cancelled: false }
    tasks.push(handle)
    return handle
  }
  const cancel = (handle) => {
    if (handle) handle.cancelled = true
  }
  const pending = () => tasks.filter((task) => !task.cancelled)
  const runDue = () => {
    for (const task of pending()) {
      task.cancelled = true
      task.fn()
    }
  }
  return { schedule, cancel, pending, runDue }
}

export async function runRunsStallMonitorTests() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-runs-stall-monitor-'))
  try {
    const { StallMonitor } = await compile('src/main/runs/stall-monitor.ts', join(dir, 'stall-monitor.mjs'))

    {
      const timers = fakeTimers()
      const tickCalls = []
      const ticks = []
      const monitor = new StallMonitor({
        tick: (now) => { tickCalls.push(now); return ticks.shift() ?? [] },
        now: () => 42,
        setInterval: timers.schedule,
        clearInterval: timers.cancel
      })
      assert.equal(monitor.started, false)
      assert.deepEqual(monitor.runOnce(), [])
      assert.deepEqual(tickCalls, [42], 'runOnce 用注入的 now')

      monitor.start()
      assert.equal(monitor.started, true)
      assert.equal(timers.pending().length, 1)
      assert.equal(timers.pending()[0].ms, 1000, '默认间隔 1000ms')
      monitor.start()
      assert.equal(timers.pending().length, 1, '已启动不重复排程')

      ticks.push(['run-1'])
      timers.runDue()
      assert.deepEqual(tickCalls, [42, 42])
      assert.equal(monitor.started, true, '排程回调用完仍视为已启动，等待下次 tick')
      assert.equal(timers.pending().length, 0, '到期任务被标记执行')

      monitor.stop()
      assert.equal(monitor.started, false)
      monitor.stop()
      assert.equal(monitor.started, false, '未启动时 stop 是空操作')
    }

    {
      const timers = fakeTimers()
      const stalled = [['run-a', 'run-b']]
      const onTickCalls = []
      const monitor = new StallMonitor({
        tick: () => stalled.shift() ?? [],
        intervalMs: 250,
        now: () => 7,
        setInterval: timers.schedule,
        clearInterval: timers.cancel,
        onTick: (ids) => onTickCalls.push(ids)
      })
      monitor.start()
      assert.equal(timers.pending()[0].ms, 250, '自定义间隔生效')
      timers.runDue()
      assert.deepEqual(onTickCalls, [['run-a', 'run-b']])
      timers.runDue()
      assert.deepEqual(onTickCalls, [['run-a', 'run-b']], '没有停滞时不触发 onTick')

      monitor.stop()
      const after = timers.pending().length
      monitor.start()
      assert.equal(timers.pending().length, after + 1, 'stop 后可以重新启动')
      monitor.stop()
      assert.equal(timers.pending().length, after, 'stop 会取消排程')
    }

    {
      const timers = fakeTimers()
      let seen = null
      const monitor = new StallMonitor({
        tick: (now) => { seen = now; return [] },
        setInterval: timers.schedule,
        clearInterval: timers.cancel
      })
      monitor.runOnce()
      assert.equal(typeof seen, 'number')
      assert.ok(Math.abs(seen - Date.now()) < 5000, '未注入 now 时用 Date.now')
    }

    {
      const timers = fakeTimers()
      const monitor = new StallMonitor({ tick: () => [], setInterval: timers.schedule, clearInterval: timers.cancel })
      monitor.start()
      monitor.stop()
      monitor.start()
      assert.equal(monitor.started, true)
      assert.equal(timers.pending().length, 1)
      monitor.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRunsStallMonitorTests()
  console.log('runs-stall-monitor: 全部通过')
}
