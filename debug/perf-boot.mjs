import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectCdp, holdProbe, killTree, launchApp, storeHelpers } from './lib/app.mjs'
import { freePort, newRunDir, parseArgs, sleep } from './lib/env.mjs'
import { startFakeModel } from './lib/fake-model.mjs'
import { memoryByKind, sampleProcessTree } from './lib/process-tree.mjs'
import { createSandbox, sandboxEnv } from './lib/sandbox.mjs'

const { flags } = parseArgs(process.argv.slice(2), new Set(['runs', 'out']))
const runs = Math.max(1, Number(flags.runs ?? 3))
const outFile = typeof flags.out === 'string' ? flags.out : null

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}

const COMPOSER_READY = `(() => { const s = window.__yanStore?.getState?.(); return !!s && s.conn === 'ready' && !!document.querySelector('.ProseMirror') })()`
const MARKS = `(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const paint = Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, Math.round(e.startTime)]))
  const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('yan:')).map((m) => [m.name, Math.round(m.startTime)]))
  return { timeOrigin: performance.timeOrigin, now: performance.now(), domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0), load: Math.round(nav?.loadEventEnd ?? 0), paint, marks }
})()`

async function waitReady(cdp, limitMs = 60000) {
  const end = Date.now() + limitMs
  while (Date.now() < end) {
    if (await cdp.evaluate(COMPOSER_READY).catch(() => false)) return Date.now()
    await sleep(10)
  }
  throw new Error('等待可输入超时')
}

async function once(index) {
  const fake = await startFakeModel()
  const runDir = newRunDir(`perf-boot-${index}`)
  const box = createSandbox(runDir, { fakePort: fake.port })
  const cdpPort = await freePort()
  const t0 = Date.now()
  const app = launchApp(sandboxEnv(box, { fake: true, cdpPort, probe: holdProbe }))
  let cdp
  const result = { run: index, runDir }
  try {
    cdp = await connectCdp(cdpPort, { shotDir: runDir })
    result.cdpMs = Date.now() - t0
    const readyAt = await waitReady(cdp)
    result.composerReadyMs = readyAt - t0
    const marks = await cdp.evaluate(MARKS)
    result.rendererStartMs = Math.round(marks.timeOrigin - t0)
    result.rendererBootMs = Math.round(readyAt - marks.timeOrigin)
    result.shellImportMs = (marks.marks['yan:shell-import-end'] ?? 0) - (marks.marks['yan:shell-import-start'] ?? 0)
    result.paint = marks.paint
    result.domContentLoaded = marks.domContentLoaded
    await sleep(3000)
    result.memory = memoryByKind(sampleProcessTree(box.userData))
    const { until } = storeHelpers(cdp)
    await until('s.conn === "ready"', 20000)
    const reloadStart = Date.now()
    await cdp.call('Page.reload')
    await sleep(200)
    const reloadReady = await waitReady(cdp)
    result.reloadToComposerMs = reloadReady - reloadStart
    const after = await cdp.evaluate(MARKS)
    result.reloadShellImportMs = (after.marks['yan:shell-import-end'] ?? 0) - (after.marks['yan:shell-import-start'] ?? 0)
    result.reloadPaint = after.paint
  } finally {
    cdp?.close()
    await sleep(300)
    result.mainLogTail = app.log().slice(-600)
    killTree(app.child.pid)
    fake.server.close()
  }
  return result
}

const results = []
for (let i = 1; i <= runs; i++) {
  const row = await once(i)
  results.push(row)
  console.log(JSON.stringify({ ...row, mainLogTail: undefined }))
}
const keys = ['cdpMs', 'composerReadyMs', 'rendererStartMs', 'rendererBootMs', 'shellImportMs', 'reloadToComposerMs', 'reloadShellImportMs']
const summary = Object.fromEntries(keys.map((key) => [key, { median: median(results.map((r) => r[key])), all: results.map((r) => r[key]) }]))
summary.memoryTotalWorkingSetMB = { median: median(results.map((r) => r.memory?.total?.workingSetMB ?? 0)), all: results.map((r) => r.memory?.total?.workingSetMB ?? 0) }
summary.fcpMs = { median: median(results.map((r) => r.paint?.['first-contentful-paint'] ?? 0)), all: results.map((r) => r.paint?.['first-contentful-paint'] ?? 0) }
console.log('SUMMARY ' + JSON.stringify(summary))
if (outFile) {
  mkdirSync(join(outFile, '..'), { recursive: true })
  writeFileSync(outFile, JSON.stringify({ results, summary }, null, 2))
}
process.exit(0)
