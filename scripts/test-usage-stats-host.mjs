import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'usage-host-'))
const source = process.env.USAGE_HOST_SOURCE ?? 'src/main/usage-stats-host.ts'
const result = await build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [{
    name: 'stub',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const utilityProcess = globalThis.__utility', loader: 'js' }))
      b.onResolve({ filter: /usage-stats$/ }, () => ({ path: 'usage', namespace: 'usage' }))
      b.onLoad({ filter: /.*/, namespace: 'usage' }, () => ({ contents: 'export const readUsageStats = async () => { globalThis.__scans = (globalThis.__scans ?? 0) + 1; return { fallback: true } }', loader: 'js' }))
    }
  }]
})
const file = join(dir, 'host.mjs')
await writeFile(file, result.outputFiles[0].text)

const forks = []
class FakeProcess extends EventEmitter {
  killed = false
  postMessage(message) {
    globalThis.__posts = (globalThis.__posts ?? 0) + 1
    if ((globalThis.__dieOnPost ?? 0) > 0) {
      globalThis.__dieOnPost -= 1
      queueMicrotask(() => this.emit('exit', 1))
      return
    }
    if (globalThis.__workerError) {
      queueMicrotask(() => this.emit('message', { id: message.id, error: globalThis.__workerError }))
      return
    }
    queueMicrotask(() => this.emit('message', { id: message.id, value: { worker: true } }))
  }
  kill() {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0))
  }
}
globalThis.__utility = { fork: () => { if (globalThis.__forkFails) throw new Error('fork failed'); const proc = new FakeProcess(); forks.push(proc); return proc } }

const host = await import(pathToFileURL(file).href)
const [a, b] = await Promise.all([host.readUsageStatsOffThread('7d'), host.readUsageStatsOffThread('7d')])
assert.deepEqual([a.worker, b.worker], [true, true])
assert.equal(forks.length, 1, '并发请求只启动一个用量进程')

host.disposeUsageStatsWorker()
assert.equal(forks[0].killed, true)
await new Promise((resolve) => setTimeout(resolve, 5))

const before = forks.length
const first = host.readUsageStatsOffThread('7d')
host.disposeUsageStatsWorker()
const reply = await first
assert.equal(reply.fallback, true, '退出过程中的请求回退到主线程')
await new Promise((resolve) => setTimeout(resolve, 5))
assert.ok(forks.slice(before).every((proc) => proc.killed || false) || forks.length === before, '退出后不遗留进程')

const again = await host.readUsageStatsOffThread('7d')
assert.equal(again.worker, true)
const last = forks[forks.length - 1]
const spare = host.readUsageStatsOffThread('7d')
last.emit('exit', 1)
const spareReply = await spare
assert.equal(spareReply.worker, true, '进程在请求前退出后仍返回结果')
assert.equal(globalThis.__scans ?? 0, 1, '进程退出不触发主进程扫描')
host.disposeUsageStatsWorker()
await new Promise((resolve) => setTimeout(resolve, 5))

globalThis.__dieOnPost = 1
const forksBeforeDie = forks.length
const retried = await host.readUsageStatsOffThread('30d')
assert.equal(retried.worker, true, '第一个 worker 退出、第二个成功时返回新结果')
assert.equal(forks.length, forksBeforeDie + 2)
assert.equal(globalThis.__scans ?? 0, 1)
host.disposeUsageStatsWorker()
await new Promise((resolve) => setTimeout(resolve, 5))

globalThis.__dieOnPost = 2
const forksBeforeTwice = forks.length
const twice = await host.readUsageStatsOffThread('7d')
assert.equal(twice.worker, true, '连续两次退出返回该范围上次成功结果')
assert.equal(forks.length, forksBeforeTwice + 2, '只重试一次')
assert.equal(globalThis.__scans ?? 0, 1, '连续退出也不触发主进程扫描')
globalThis.__dieOnPost = 2
host.disposeUsageStatsWorker()
await new Promise((resolve) => setTimeout(resolve, 5))
globalThis.__dieOnPost = 0
host.disposeUsageStatsWorker()
await new Promise((resolve) => setTimeout(resolve, 5))

globalThis.__workerError = 'scan blew up'
const scansBefore = globalThis.__scans ?? 0
const postsBefore = globalThis.__posts ?? 0
const stale = await host.readUsageStatsOffThread('7d')
assert.equal(stale.worker, true, 'worker 扫描出错时返回该范围上次成功结果')
await assert.rejects(() => host.readUsageStatsOffThread('all'), /scan blew up/, '没有成功结果时把扫描错误交给调用方')
assert.equal(globalThis.__scans ?? 0, scansBefore, 'worker 扫描出错不触发主进程全量扫描')
assert.equal((globalThis.__posts ?? 0) - postsBefore, 2, '扫描错误不重试：两次请求各只发一次')
globalThis.__workerError = undefined
host.disposeUsageStatsWorker()
await new Promise((resolve) => setTimeout(resolve, 5))

globalThis.__forkFails = true
const base = globalThis.__scans ?? 0
const [f1, f2] = await Promise.all([host.readUsageStatsOffThread('all'), host.readUsageStatsOffThread('all')])
assert.equal(f1.fallback && f2.fallback, true, 'fork 失败时回退主进程扫描')
assert.equal((globalThis.__scans ?? 0) - base, 1, '并发回退共享同一次扫描')
await host.readUsageStatsOffThread('all')
assert.equal((globalThis.__scans ?? 0) - base, 1, '限流窗口内重复回退复用结果')
globalThis.__forkFails = false
host.disposeUsageStatsWorker()
console.log('usage-stats-host ok')
process.exit(0)
