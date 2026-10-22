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

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-quit-guard-'))
  try {
    const guard = await compile('src/main/quit-guard.ts', join(dir, 'quit-guard.mjs'))
    const { runShutdownSteps } = await compile('src/main/shutdown.ts', join(dir, 'shutdown.mjs'))
    const shutdown = await import(pathToFileURL(join(dir, 'shutdown.mjs')).href)

    const idle = { sessionsBusy: false, runningSubagents: 0, terminalWorking: false }
    assert.deepEqual(guard.quitReasons(idle), [])
    assert.deepEqual(guard.quitReasons({ ...idle, sessionsBusy: true }), ['sessions'])
    assert.deepEqual(guard.quitReasons({ sessionsBusy: true, runningSubagents: 2, terminalWorking: true, unsavedFiles: 1 }), ['sessions', 'subagents', 'terminal', 'unsaved'])
    assert.deepEqual(guard.quitReasons({ ...idle, runningSubagents: 3 }), ['subagents'])

    const prompt = guard.quitPrompt({ ...idle, runningSubagents: 2, terminalWorking: true })
    assert.match(prompt.message, /2 个子代理正在运行/)
    assert.match(prompt.message, /终端/)
    assert.equal(prompt.buttons.length, 3)

    assert.equal(guard.choiceFromResponse(0), 'cancel')
    assert.equal(guard.choiceFromResponse(1), 'save')
    assert.equal(guard.choiceFromResponse(2), 'interrupt')
    assert.equal(guard.choiceFromResponse(-1), 'cancel')

    assert.equal(guard.parseProbeChoice('save'), 'save')
    assert.equal(guard.parseProbeChoice('nope'), undefined)
    assert.equal(guard.parseProbeChoice(undefined), undefined)

    assert.equal(guard.needsQuitConfirm({ quitting: false, reasons: ['sessions'], hasWindow: true }), true)
    assert.equal(guard.needsQuitConfirm({ quitting: true, reasons: ['sessions'], hasWindow: true }), false)
    assert.equal(guard.needsQuitConfirm({ quitting: false, reasons: [], hasWindow: true }), false)
    assert.equal(guard.needsQuitConfirm({ quitting: false, reasons: ['terminal'], hasWindow: false }), false)

    const order = []
    const failures = []
    const outcomes = await runShutdownSteps(
      [
        { name: 'a', run: () => { order.push('a') } },
        { name: 'b', run: async () => { order.push('b'); throw new Error('boom') } },
        { name: 'c', run: () => new Promise(() => {}), timeoutMs: 30 },
        { name: 'd', run: async () => { order.push('d') } }
      ],
      (outcome) => failures.push(outcome.name)
    )
    assert.deepEqual(order, ['a', 'b', 'd'])
    assert.deepEqual(outcomes.map((o) => o.ok), [true, false, false, true])
    assert.equal(outcomes[2].timedOut, true)
    assert.deepEqual(failures, ['b', 'c'])

    assert.ok(shutdown.DEFAULT_STEP_TIMEOUT_MS > 8_000, '关机单步超时默认值应大于旧的固定 8 秒')
    assert.ok(shutdown.DEFAULT_TOTAL_TIMEOUT_MS > shutdown.DEFAULT_STEP_TIMEOUT_MS)

    const generous = await runShutdownSteps(
      [{ name: 'slow', run: () => new Promise((resolve) => setTimeout(resolve, 120)) }],
      undefined,
      { defaultTimeoutMs: 2_000 }
    )
    assert.deepEqual(generous.map((o) => o.ok), [true])

    const warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    let cappedElapsed = 0
    let capped
    try {
      const startedAt = Date.now()
      capped = await runShutdownSteps(
        [{ name: 'stuck-cleanup', run: () => new Promise(() => {}) }],
        undefined,
        { defaultTimeoutMs: 5_000, totalTimeoutMs: 40 }
      )
      cappedElapsed = Date.now() - startedAt
    } finally {
      console.warn = originalWarn
    }
    assert.equal(capped[0].ok, false)
    assert.equal(capped[0].timedOut, true)
    assert.ok(cappedElapsed < 1_500, `总预算应压住单步超时，实际 ${cappedElapsed}ms`)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /stuck-cleanup/)
    assert.match(warnings[0], /超时|超过/)

    const events = []
    const first = runShutdownSteps([
      { name: 'drain-subagents', run: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); events.push('drain') } },
      { name: 'release-data-root', run: () => { events.push('unlock') } }
    ])
    assert.equal(shutdown.shutdownPending(), first)
    const repeated = runShutdownSteps([{ name: 'second-exit', run: () => { events.push('second-exit') } }])
    assert.equal(repeated, first, '清理期间再次退出应拿到同一个进行中的清理，而不是立刻返回')
    assert.equal(shutdown.shutdownPending(), first)
    const drained = await shutdown.shutdownPending()
    assert.deepEqual(events, ['drain', 'unlock'])
    assert.deepEqual(drained.map((o) => o.name), ['drain-subagents', 'release-data-root'])
    assert.deepEqual((await repeated).map((o) => o.name), ['drain-subagents', 'release-data-root'])
    assert.equal(shutdown.shutdownPending(), undefined)
    assert.deepEqual((await runShutdownSteps([{ name: 'fresh', run: () => 'ok' }])).map((o) => o.ok), [true])

    console.log('test-quit-guard: 全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
