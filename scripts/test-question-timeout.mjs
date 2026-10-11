import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-question-timeout-'))
try {
  const file = join(dir, 'question.mjs')
  await build({ stdin: { contents: `export * from './src/main/ui-requests'; export * from './src/shared/ui-timeout'; export * from './src/renderer/src/state/session-runtime'; export { consumeQuestionPush } from './src/renderer/src/state/push-consumers'`, resolveDir: process.cwd() }, outfile: file, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  const { UiRequests, UI_TIMEOUT_HARD, reduceSessionRuntime, consumeQuestionPush } = await import(pathToFileURL(file).href)
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const events = [], pi = []
  const ui = new UiRequests({ push: (event) => events.push(event), respondToPi: (response) => pi.push(response) })
  const ask = () => {
    const result = ui.requestHostUi({ method: 'input', title: 'question', message: 'test', timeout: 100 }).catch((error) => error)
    return { id: events.at(-1).payload.id, result }
  }
  const first = ask(), second = ask()
  ui.startHostUiTimer(first.id)
  mock.timers.tick(100)
  assert.equal((await first.result).code, 'question_timeout')
  const expired = events.at(-1)
  assert.deepEqual(expired, { ch: 'ui-resolved', payload: { id: first.id, by: 'timeout' } })
  assert.deepEqual(ui.pendingUiRequests().map((q) => q.id), [second.id])
  assert.equal(ui.payloads.has(first.id), false)
  ui.respondUi({ id: first.id, value: 'late' })
  assert.equal(pi.length, 0)

  const pendingQuestions = events.filter((e) => e.ch === 'ui-request').map((e) => e.payload)
  let patch
  consumeQuestionPush(expired, { uiRequests: pendingQuestions }, { set: (value) => { patch = value } })
  assert.deepEqual(patch.uiRequests.map((q) => q.id), [second.id])
  const runtime = { sessionId: 'A', runId: 'rA', generation: 1 }
  let cache = {}
  for (const question of pendingQuestions) cache = reduceSessionRuntime(cache, runtime, { ch: 'ui-request', payload: question })
  cache = reduceSessionRuntime(cache, runtime, expired)
  cache = reduceSessionRuntime(cache, runtime, { ch: 'todos', payload: [] })
  assert.deepEqual(cache.A.uiRequests.map((q) => q.id), [second.id])

  mock.timers.tick(UI_TIMEOUT_HARD)
  assert.equal((await second.result).code, 'question_timeout')
  assert.equal(ui.pendingUiRequests().length, 0)
  assert.equal(events.filter((e) => e.ch === 'ui-resolved' && e.payload.id === first.id).length, 1)
  assert.equal(events.at(-1).payload.id, second.id)
  consumeQuestionPush(events.at(-1), patch, { set: (value) => { patch = value } })
  assert.equal(patch.uiRequests.length, 0)

  const third = ask()
  ui.startHostUiTimer(third.id)
  ui.extendHostUi(third.id, 1000)
  mock.timers.tick(100)
  assert.equal(ui.pending.has(third.id), true)
  ui.respondUi({ id: third.id, value: 'answer' })
  assert.deepEqual(await third.result, { id: third.id, value: 'answer' })
  mock.timers.tick(UI_TIMEOUT_HARD * 2)
  assert.equal(events.filter((e) => e.ch === 'ui-resolved' && e.payload.id === third.id).length, 1)
  assert.equal(events.at(-1).payload.by, 'desktop')
  console.log('question-timeout: 16 focused checks passed')
} finally {
  mock.timers.reset()
  await rm(dir, { recursive: true, force: true })
}
