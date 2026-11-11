#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mock } from 'node:test'
import { build } from 'esbuild'

let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks += 1; console.log(`✓ ${message}`) }
const tick = () => new Promise((resolve) => setImmediate(resolve))
const until = async (predicate) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await tick()
  }
}

const dir = await mkdtemp(join(tmpdir(), 'inkstone-runs-code-retry-'))
try {
  const out = join(dir, 'host.mjs')
  await build({ entryPoints: ['src/main/runs-host.ts'], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { createRunsHost } = await import(pathToFileURL(out).href)
  mock.timers.enable({ apis: ['setTimeout'] })

  async function exhaust(label, pushes, host, now) {
    const failures = () => pushes.filter((m) => m.ch === 'log' && m.payload.text.includes('分配失败')).length
    const delays = [1_000, 5_000, 30_000]
    host.observerFor()({ sessionId: label }, { type: 'agent-start' })
    for (let i = 0; i < delays.length; i += 1) {
      await until(() => failures() === i + 1)
      mock.timers.tick(delays[i])
    }
    await until(() => pushes.some((m) => m.ch === 'notify'))
    return now
  }

  {
    let now = 1_000
    const root = join(dir, 'a')
    const pushes = []
    const host = await createRunsHost({ root, push: (m) => pushes.push(m), now: () => now, newRunId: () => 'run-a' })
    await mkdir(join(root, 'session-codes.json'), { recursive: true })
    await exhaust('s-a', pushes, host, now)
    const logs = () => pushes.filter((m) => m.ch === 'log').length
    check(host.snapshot().runs.length === 0, '连续失败：运行不登记')
    const before = logs()
    now += 10_000
    host.observerFor()({ sessionId: 's-a' }, { type: 'activity', activity: 'streaming' })
    await tick()
    check(logs() === before && host.snapshot().runs.length === 0, '60 秒内的普通信号不触发重试')
    await rm(join(root, 'session-codes.json'), { recursive: true, force: true })
    now += 61_000
    host.observerFor()({ sessionId: 's-a' }, { type: 'agent-start' })
    await until(() => host.snapshot().runs.some((r) => r.sessionId === 's-a'))
    check(host.snapshot().runs.find((r) => r.sessionId === 's-a').phase.kind === 'running', '超过 60 秒后下一条信号清除 failed 并重试成功')
    await host.dispose()
  }

  {
    let now = 1_000
    const root = join(dir, 'b')
    const pushes = []
    const host = await createRunsHost({ root, push: (m) => pushes.push(m), now: () => now, newRunId: () => 'run-b' })
    await mkdir(join(root, 'session-codes.json'), { recursive: true })
    await exhaust('s-b', pushes, host, now)
    await rm(join(root, 'session-codes.json'), { recursive: true, force: true })
    now += 1_000
    host.observerFor()({ sessionId: 's-b' }, { type: 'agent-start' })
    await until(() => host.snapshot().runs.some((r) => r.sessionId === 's-b'))
    check(true, '失败后不足 60 秒收到该会话 agent-start 也立即重试成功')
    await host.dispose()
  }
  mock.timers.reset()
  console.log(`runs-host-code-retry: ${checks} 项通过`)
} finally {
  mock.timers.reset()
  await rm(dir, { recursive: true, force: true })
}
