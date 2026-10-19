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

    console.log('test-quit-guard: 全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run()
