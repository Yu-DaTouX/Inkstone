#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = process.cwd()
const workDir = join(root, '.tmp', 'local-server-owner', 'unit')
await rm(workDir, { recursive: true, force: true })
await mkdir(workDir, { recursive: true })
await build({
  entryPoints: ['src/main/browser/local-server-owner.ts'],
  outdir: join(workDir, 'out'),
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent'
})
const mod = await import(pathToFileURL(join(workDir, 'out', 'main', 'browser', 'local-server-owner.js')).href)

let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
}
const eq = (actual, expected, label) => {
  assert.deepEqual(actual, expected, label)
  checks++
}

const rows = [
  { pid: 1, ppid: 0, name: 'System' },
  { pid: 100, ppid: 1, name: 'electron' },
  { pid: 200, ppid: 100, name: 'pi' },
  { pid: 210, ppid: 200, name: 'bash' },
  { pid: 220, ppid: 210, name: 'node' },
  { pid: 300, ppid: 100, name: 'pwsh' },
  { pid: 310, ppid: 300, name: 'npm' },
  { pid: 320, ppid: 310, name: 'node' },
  { pid: 400, ppid: 1, name: 'node' },
  { pid: 500, ppid: 999, name: 'node' },
  { pid: 600, ppid: 600, name: 'loop' }
]

eq([...mod.agentOwnedPids(rows, [200, 300])].sort((a, b) => a - b), [210, 220, 310, 320], '后代：pi 与 agent 终端下面的整棵进程树，不含根自己')
eq([...mod.agentOwnedPids(rows, [])], [], '没有根时没有归属')
ok(!mod.agentOwnedPids(rows, [200, 300]).has(400), '同级的用户进程不算 agent 起的')
ok(!mod.agentOwnedPids(rows, [200, 300]).has(500), '父进程已不在表里的孤儿不算（无法证明归属）')
ok(!mod.agentOwnedPids(rows, [100]).has(100), '根不会把自己算进去')
eq([...mod.agentOwnedPids([{ pid: 7, ppid: 8, name: 'a' }, { pid: 8, ppid: 7, name: 'b' }], [7])], [8], '环形父子关系不会死循环')

let now = 1_000_000
let reads = 0
let currentRoots = [200]
const tracker = new mod.AgentServerTracker({
  roots: () => currentRoots,
  readRows: async () => {
    reads++
    return rows
  },
  now: () => now
})
const server = (pid, port) => ({ url: `http://127.0.0.1:${port}`, port, host: '127.0.0.1', pid })

let marked = await tracker.mark([server(220, 5173), server(400, 3000)])
eq(marked.map((item) => item.agentStarted === true), [true, false], '标记：agent 进程树里的服务带 agentStarted，别的不带')
ok(reads === 1, '第一次标记读一次进程表')
await tracker.mark([server(220, 5173), server(400, 3000)])
ok(reads === 1, '已有结论的进程在窗口内不重复读进程表')
now += 31_000
await tracker.mark([server(220, 5173), server(400, 3000)])
ok(reads === 2, '否定结论超过 30 秒会重新核对，肯定结论保持')
ok(tracker.owns(220) && !tracker.owns(400), 'owns 与标记一致')

currentRoots = [200, 300]
now += 31_000
marked = await tracker.mark([server(220, 5173), server(320, 4000)])
eq(marked.map((item) => item.agentStarted === true), [true, true], '新开的 agent 终端里的服务出现后被标记')
await tracker.mark([server(320, 4000)])
ok(!tracker.owns(220), '进程不再监听后结论清掉，避免 pid 复用被误认')

currentRoots = []
const idle = new mod.AgentServerTracker({ roots: () => currentRoots, readRows: async () => { reads++; return rows }, now: () => now })
const before = reads
marked = await idle.mark([server(220, 5173)])
ok(reads === before && marked[0].agentStarted === undefined, '没有任何 agent 进程时不读进程表、不标记')

console.log(`✓ local-server-owner 测试通过（${checks} 项）`)
