#!/usr/bin/env node
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TOKEN = 'browser-overlay'

const entry = [
  "export * from './src/renderer/src/features/browser/overlay-lifecycle.ts'",
  "export * from './src/renderer/src/state/browser-visibility.ts'"
].join('\n')

const built = await build({
  stdin: {
    contents: entry,
    resolveDir: ROOT,
    sourcefile: 'v3-browser-lifecycle-test-entry.ts',
    loader: 'ts'
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const mod = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
)
const { createOverlayBlockerLifecycle, OverlayBlockers } = mod
assert.equal(typeof createOverlayBlockerLifecycle, 'function', 'overlay-lifecycle 模块未导出工厂')

let pass = 0
let fail = 0
function ok(cond, label, detail) {
  if (cond) {
    pass += 1
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    fail += 1
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : `  ← 实际: ${JSON.stringify(detail)}`}\n`)
  }
}
function group(name) {
  process.stdout.write(`\n▌${name}\n`)
}

function makeHarness(blockers, present = true) {
  const frames = []
  const cancelled = []
  let overlay = present
  const lifecycle = createOverlayBlockerLifecycle({
    hasOverlay: () => overlay,
    acquire: () => {
      blockers.acquire(TOKEN)
      return () => blockers.release(TOKEN)
    },
    requestFrame: (callback) => {
      frames.push(callback)
      return frames.length
    },
    cancelFrame: (handle) => {
      cancelled.push(handle)
    }
  })
  return {
    lifecycle,
    setOverlay: (value) => {
      overlay = value
    },
    runQueued: () => {
      for (const callback of frames.splice(0)) callback()
    },
    queued: () => frames.length,
    cancelledCount: () => cancelled.length
  }
}

group('竞态：schedule 后卸载，旧回调即使已出队也不得重新 acquire')
{
  const blockers = new OverlayBlockers()
  const h = makeHarness(blockers, true)

  h.lifecycle.schedule()
  ok(h.queued() === 1, 'schedule 排入一帧')
  ok(blockers.has(TOKEN) === false, '回调执行前尚未领取 blocker')

  h.lifecycle.dispose()
  ok(h.cancelledCount() === 1, 'dispose 取消挂起帧')
  ok(blockers.has(TOKEN) === false, 'dispose 时未持有，无需归还')

  h.runQueued()
  ok(blockers.has(TOKEN) === false, '旧回调执行后仍未 acquire，浏览器不被永久挡住')

  h.lifecycle.schedule()
  ok(h.queued() === 0, 'dispose 后 schedule 不再排帧')
}

group('归还唯一：持有 blocker 后卸载只 release 一次')
{
  const blockers = new OverlayBlockers()
  const h = makeHarness(blockers, true)

  h.lifecycle.evaluate()
  ok(blockers.has(TOKEN) === true, '有浮层时领取 blocker')
  ok(h.lifecycle.holding() === true, 'holding 报告已持有')

  h.lifecycle.schedule()
  h.lifecycle.dispose()
  ok(blockers.has(TOKEN) === false, 'dispose 归还 blocker')
  ok(h.lifecycle.holding() === false, 'holding 报告已归还')
  const sizeAfterDispose = blockers.size

  h.runQueued()
  ok(blockers.size === sizeAfterDispose, '旧回调没有二次归还 / 也没有重领')
  ok(blockers.size === 0, '最终计数回到 0')

  const second = makeHarness(blockers, true)
  second.lifecycle.evaluate()
  second.lifecycle.dispose()
  second.lifecycle.dispose()
  ok(blockers.size === 0, 'dispose 幂等，重复调用不会多 release')
}

group('正常流转：浮层开 → 关 → 开 正确领取与归还')
{
  const blockers = new OverlayBlockers()
  const h = makeHarness(blockers, true)

  h.lifecycle.evaluate()
  ok(blockers.size === 1, '开：领取一次')

  h.setOverlay(false)
  h.lifecycle.evaluate()
  ok(blockers.size === 0, '关：归还一次')
  ok(h.lifecycle.holding() === false, '关后不再持有')

  h.setOverlay(true)
  h.lifecycle.schedule()
  ok(h.queued() === 1, '再开：排一帧')
  h.runQueued()
  ok(blockers.size === 1, '再开：帧回调重新领取')
  ok(h.lifecycle.holding() === true, '重新持有')

  h.lifecycle.schedule()
  h.lifecycle.schedule()
  ok(h.queued() === 1, '重复 schedule 只排一帧')
  h.runQueued()
  ok(blockers.size === 1, '重复评估不会重复领取')

  h.lifecycle.dispose()
  ok(blockers.size === 0, '收起时归还')
}

group('StrictMode 双挂载：旧实例的旧回调不影响新实例持有的 token')
{
  const blockers = new OverlayBlockers()

  const oldHarness = makeHarness(blockers, true)
  oldHarness.lifecycle.evaluate()
  ok(blockers.size === 1, '旧挂载领取 blocker')
  oldHarness.lifecycle.schedule()

  oldHarness.lifecycle.dispose()
  ok(blockers.size === 0, '旧挂载清理归还')

  const newHarness = makeHarness(blockers, true)
  newHarness.lifecycle.evaluate()
  ok(blockers.size === 1, '新挂载领取 blocker')
  ok(newHarness.lifecycle.holding() === true, '新实例持有中')

  oldHarness.runQueued()
  ok(blockers.size === 1, '旧回调没有释放新持有者的 blocker')
  ok(newHarness.lifecycle.holding() === true, '新实例仍持有')
  ok(oldHarness.lifecycle.holding() === false, '旧实例保持不持有')

  newHarness.lifecycle.dispose()
  ok(blockers.size === 0, '新挂载卸载后正确归还')
}

process.stdout.write(`\n${fail === 0 ? '✓' : '✗'} v3 浏览器遮挡生命周期：${pass} 通过，${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
