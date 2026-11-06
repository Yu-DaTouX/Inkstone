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
      b.onLoad({ filter: /.*/, namespace: 'usage' }, () => ({ contents: 'export const readUsageStats = async () => ({ fallback: true })', loader: 'js' }))
    }
  }]
})
const file = join(dir, 'host.mjs')
await writeFile(file, result.outputFiles[0].text)

const forks = []
class FakeProcess extends EventEmitter {
  killed = false
  postMessage(message) {
    queueMicrotask(() => this.emit('message', { id: message.id, value: { worker: true } }))
  }
  kill() {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 0))
  }
}
globalThis.__utility = { fork: () => { const proc = new FakeProcess(); forks.push(proc); return proc } }

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
await spare
host.disposeUsageStatsWorker()
console.log('usage-stats-host ok')
process.exit(0)
