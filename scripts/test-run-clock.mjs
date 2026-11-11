#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { parseHTML } from 'linkedom'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(ROOT, 'node_modules', '.test-run-clock-'))
const outfile = join(dir, 'run-clock.mjs')
await build({
  entryPoints: [join(ROOT, 'src/renderer/src/features/session/run-clock.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
  external: ['react']
})

const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
globalThis.window = window
globalThis.document = window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const timers = new Map()
let nextTimer = 1
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = (fn, ms) => {
  const id = realSetInterval(fn, ms)
  timers.set(id, fn)
  return id
}
globalThis.clearInterval = (id) => {
  timers.delete(id)
  realClearInterval(id)
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

try {
  const { subscribeRunNow, runNow, useRunNow, elapsedSince } = await import(pathToFileURL(outfile).href)

  assert.equal(elapsedSince(1_000, 6_000), 5_000, '思考起点按已有的毫秒时间戳计算')
  assert.equal(elapsedSince(7_000, 6_000), 0, '起点晚于当前时钳到 0，不显示负时长')
  assert.equal(elapsedSince(undefined, 6_000), null, '没有起点时不猜时长')
  assert.equal(elapsedSince(0, 6_000), null, '起点 0 视为无效')
  assert.equal(elapsedSince(Number.NaN, 6_000), null, '非法起点回 null')

  let firstTicks = 0
  let secondTicks = 0
  const offFirst = subscribeRunNow(() => {
    firstTicks += 1
  })
  assert.equal(timers.size, 1, '第一个订阅者启动唯一一块秒表')
  const startedAt = runNow()
  const offSecond = subscribeRunNow(() => {
    secondTicks += 1
  })
  assert.equal(timers.size, 1, '第二个订阅者复用同一块秒表，不再开定时器')
  await delay(1150)
  assert.ok(firstTicks >= 1 && secondTicks >= 1, '同一个 tick 通知所有订阅者')
  assert.ok(runNow() >= startedAt + 1000, '共享时钟按 1 秒推进')
  offFirst()
  assert.equal(timers.size, 1, '还有订阅者时秒表不停')
  offSecond()
  assert.equal(timers.size, 0, '最后一个订阅者离开后停表')
  const ticked = firstTicks + secondTicks
  await delay(1150)
  assert.equal(firstTicks + secondTicks, ticked, '停表后不再通知')
  const offAgain = subscribeRunNow(() => {})
  assert.ok(runNow() >= startedAt + 2000, '停表一段时间后重新订阅立刻对齐当前时间，不沿用冻结值')
  offAgain()

  const React = (await import('react')).default
  const { createRoot } = await import('react-dom/client')
  const { act } = React
  const seen = []
  function Probe({ id, active }) {
    const now = useRunNow(active)
    seen.push([id, now])
    return null
  }
  const latest = (id) => [...seen].reverse().find((entry) => entry[0] === id)?.[1]
  const root = createRoot(document.getElementById('root'))

  await act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(Probe, { id: 'a', active: true }),
      React.createElement(Probe, { id: 'b', active: true })))
  })
  assert.equal(timers.size, 1, '两个运行中的钩子共用一个定时器')
  const before = runNow()
  await act(async () => {
    await delay(1150)
  })
  assert.ok(runNow() >= before + 1000, '钩子跟随共享时钟')
  assert.equal(latest('a'), latest('b'), '同一次 tick 后所有钩子读到同一个 now')

  await act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(Probe, { id: 'a', active: false }),
      React.createElement(Probe, { id: 'b', active: true })))
  })
  assert.equal(timers.size, 1, '只停掉不再活跃的订阅')
  await act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(Probe, { id: 'a', active: false }),
      React.createElement(Probe, { id: 'b', active: false })))
  })
  assert.equal(timers.size, 0, '全部不活跃后停表')
  const rendered = seen.length
  await delay(1150)
  assert.equal(seen.length, rendered, '停表后钩子不再重渲染')

  await act(async () => {
    root.unmount()
  })
  assert.equal(timers.size, 0, '卸载后没有遗留定时器')
  console.log('run-clock：全部通过')
} finally {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  await rm(dir, { recursive: true, force: true })
}
