import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createServer, get as httpGet } from 'node:http'
import { sampleProcessTree } from './lib/process-sample.mjs'
import { syntheticEnvironment } from './lib/live-synthetic-isolation.mjs'
import { evidenceDir } from './lib/evidence-dir.mjs'
import { soakOptions, fixtureExpression, soakGrowth, summarizeMemoryDump } from './lib/memory-soak.mjs'

const requireEsm = createRequire(import.meta.url)
const root = process.cwd()
const argv = process.argv.slice(2)
const soak = soakOptions(argv)
const syntheticOnly = soak.cycles > 0 || process.env.YAN_TEST_SYNTHETIC_ONLY === '1'
if (soak.cycles && process.platform !== 'win32') throw new Error('Soak process-tree sampling currently requires Windows')
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const scales = flag('scales', '0,200,1000,3000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0)
const outDir = flag('out') ? resolve(flag('out')) : evidenceDir(root, 'memory-audit')
const injectMode = flag('inject', 'setstate')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const sandbox = mkdtempSync(join(tmpdir(), 'yan-mem-'))
let child
let ws
let cleanupStarted = false
const killTree = () => {
  if (cleanupStarted || !child?.pid || child.exitCode !== null || child.signalCode !== null) return
  cleanupStarted = true
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 20_000 })
}
try {
const userData = join(sandbox, 'userData')
const sessions = join(sandbox, 'sessions')
const data = join(sandbox, 'data')
const piAgent = join(sandbox, 'pi-agent')
for (const d of [userData, sessions, data, piAgent]) mkdirSync(d, { recursive: true })
for (const f of (syntheticOnly ? [] : ['auth.json', 'models.json', 'models-store.json'])) {
  const src = join(process.env.YAN_PI_DIR?.trim() || join(homedir(), '.pi', 'agent'), f)
  if (existsSync(src)) copyFileSync(src, join(piAgent, f))
}
writeFileSync(join(data, 'desktop.json'), JSON.stringify({ cwd: root, lang: 'zh-CN' }, null, 2), 'utf8')

const probe = join(sandbox, 'probe-ready.js')
writeFileSync(
  probe,
  [
    '(async () => {',
    "  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))",
    '  for (let i = 0; i < 200; i++) {',
    "    if (window.__yanStore && window.__yanStore.getState().messages) break",
    '    await sleep(100)',
    '  }',
    "  return 'ready:' + Boolean(window.__yanStore)",
    '})()',
    ''
  ].join('\n'),
  'utf8'
)

const freePort = () =>
  new Promise((done) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => done(p))
    })
  })
const port = await freePort()

const inspectPort = argv.includes('--main-heap') ? await freePort() : 0

const env = syntheticOnly ? syntheticEnvironment(process.env) : { ...process.env }
if (syntheticOnly) env.YAN_TEST_SYNTHETIC_ONLY = '1'
for (const k of ['ELECTRON_RUN_AS_NODE', 'YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID']) delete env[k]
Object.assign(env, {
  YAN_USER_DATA: userData,
  YAN_SESSIONS_DIR: sessions,
  YAN_DATA_DIR: data,
  YAN_PI_DIR: piAgent,
  YAN_DOWNLOADS_DIR: join(sandbox, 'downloads'),
  YAN_PROBE: probe,
  YAN_PROBE_DELAY: flag('probe-delay', '600000'),
  YAN_PROBE_HIDDEN: '1',
  YAN_PROBE_DEBUG_PORT: String(port)
})
mkdirSync(env.YAN_DOWNLOADS_DIR, { recursive: true })

const electronBin = requireEsm('electron')
const electronArgs = argv.includes('--main-heap') ? ['.', `--inspect=${inspectPort}`] : ['.']
child = spawn(electronBin, electronArgs, { cwd: root, env, windowsHide: true })
let spawnError
child.on('error', (error) => { spawnError = error })
let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))

const httpJson = (path) =>
  new Promise((done, fail) => {
    const req = httpGet({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          done(JSON.parse(body))
        } catch (e) {
          fail(e)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('http 超时')))
    req.on('error', fail)
  })

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method) {
        this.onEvent?.(msg)
        if (!/heapprofiler|Profiler\.|Debugger\.scriptParsed|Tracing\./.test(msg.method)) {
          console.error('  · event', msg.method, JSON.stringify(msg.params ?? {}).slice(0, 200))
        }
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

if (argv.includes('--watch-targets')) {
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      const list = await httpJson('/json/list')
      console.error(`${i} ${list.map((t) => `${t.type}:${String(t.id).slice(0, 6)}:${t.title}`).join(' | ') || '(空)'}`)
    } catch (e) {
      console.error(`${i} �— ${e.message}`)
    }
  }
  killTree()
  await sleep(1000)
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(0)
}

const target = await (async () => {
  await sleep(Number(flag('wait', '0')) * 1000)
  for (let i = 0; i < 90; i++) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`Isolated Electron exited: ${child.exitCode}`)
    try {
      const list = await httpJson('/json/list')
      if (list.length) {
        console.error('=== CDP targets ===')
        for (const t of list) console.error(`  ${t.type} | ${t.title} | ${t.url}`)
      }
      const page = list.find((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url ?? ''))
      if (page?.webSocketDebuggerUrl) return page
    } catch (e) {
      if (i % 5 === 0) console.error('  · /json/list 失败:', e?.message ?? String(e), e?.cause?.message ?? '')
    }
    await sleep(1000)
  }
  return null
})()

if (!target) {
  throw new Error(`没能连上隔离渲染进程调试口\n${log.slice(-3000)}`)
}

ws = new WebSocket(target.webSocketDebuggerUrl)
let connectTimer
try {
  await new Promise((done, fail) => {
    connectTimer = setTimeout(() => fail(new Error('CDP WebSocket connection timeout')), 15_000)
    ws.addEventListener('open', done, { once: true })
    ws.addEventListener('error', fail, { once: true })
  })
} finally {
  clearTimeout(connectTimer)
}
ws.addEventListener('close', (ev) => console.error('⚠ CDP 连接关闭', ev.code, ev.reason))
ws.addEventListener('error', (ev) => console.error('⚠ CDP 连接错误', ev?.message ?? ''))
let cdp = new Cdp(ws)

const withTimeout = async (p, ms, label) => {
  let timer
  try {
    return await Promise.race([p, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`CDP 超时 ${ms}ms: ${label}`)), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

const evaluate = async (expression) => {
  const res = await withTimeout(
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    30_000,
    'Runtime.evaluate'
  )
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? 'evaluate failed')
  return res.result?.value
}

let ready = false
for (let i = 0; i < 120; i++) {
  ready = await evaluate('Boolean(window.__yanStore && window.__yanStore.getState().messages)').catch(() => false)
  if (ready) break
  await sleep(1000)
}
if (!ready) {
  throw new Error(`隔离渲染端 store 一直没就绪\n${log.slice(-3000)}`)
}

const snapshot = async (label, extra = {}) => {
  let gcError = null
  try {
    await withTimeout(cdp.send('HeapProfiler.enable'), 20_000, 'HeapProfiler.enable')
    await withTimeout(cdp.send('HeapProfiler.collectGarbage'), 20_000, 'collectGarbage')
  } catch (error) {
    gcError = String(error)
    if (soak.cycles) throw error
  }
  await sleep(400)
  const heap = await withTimeout(cdp.send('Runtime.getHeapUsage'), 20_000, 'getHeapUsage')
  const dom = await withTimeout(cdp.send('Memory.getDOMCounters'), 20_000, 'getDOMCounters').catch(() => ({}))
  const messages = await evaluate('window.__yanStore?.getState().messages.length ?? null')
  const objectUrls = await evaluate('window.__memorySoakUrlTracker ? { created: window.__memorySoakUrlTracker.created, revoked: window.__memorySoakUrlTracker.revoked, active: window.__memorySoakUrlTracker.active.size } : null')
  const proc = sampleProcessTree(child.pid)
  const byName = {}
  for (const p of proc.processSamples) {
    byName[p.name] = byName[p.name] ?? { count: 0, workingSetMiB: 0, privateMiB: 0 }
    byName[p.name].count += 1
    byName[p.name].workingSetMiB += p.workingSetMiB
    byName[p.name].privateMiB += p.privateMiB
  }
  const row = {
    label,
    at: new Date().toISOString(),
    gcSucceeded: !gcError,
    gcError,
    processSamples: proc.processSamples,
    messages,
    objectUrls,
    heapUsedMiB: +(heap.usedSize / 1048576).toFixed(1),
    heapTotalMiB: +(heap.totalSize / 1048576).toFixed(1),
    backingStorageMiB: Number.isFinite(heap.backingStorageSize) ? +(heap.backingStorageSize / 1048576).toFixed(1) : null,
    embedderHeapMiB: Number.isFinite(heap.embedderHeapUsedSize) ? +(heap.embedderHeapUsedSize / 1048576).toFixed(1) : null,
    domNodes: dom.nodes ?? null,
    jsEventListeners: dom.jsEventListeners ?? null,
    documents: dom.documents ?? null,
    processes: proc.count,
    treeWorkingSetMiB: +proc.workingSetMiB.toFixed(1),
    treePrivateMiB: +proc.privateMiB.toFixed(1),
    byName: Object.fromEntries(
      Object.entries(byName).map(([k, v]) => [k, { count: v.count, workingSetMiB: +v.workingSetMiB.toFixed(1) }])
    ),
    ...extra
  }
  console.log(JSON.stringify(row))
  return row
}

const verifyImages = async (expected, openViewer = false) => evaluate(`(async () => {
  const wait = async (test, label) => {
    const until = performance.now() + 5000
    while (!test()) {
      if (performance.now() > until) throw new Error('Fixture image lifecycle timed out: ' + label)
      await new Promise((done) => setTimeout(done, 20))
    }
  }
  if (${Boolean(expected)}) await wait(() => document.querySelectorAll('img.v3-img-open, img.v3-md-image').length > 0, 'transcript image nodes')
  const images = [...document.querySelectorAll('img.v3-img-open, img.v3-md-image')]
  if (!${Boolean(expected)} && images.length) throw new Error('Unexpected fixture images')
  await wait(() => images.every((image) => image.getAttribute('src')), 'owned display URLs')
  await Promise.all(images.map(async (image) => {
    image.loading = 'eager'
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Fixture image has no decoded pixels')
  }))
  const sourceKinds = {}
  for (const image of images) {
    const scheme = image.getAttribute('src').split(':')[0]
    sourceKinds[scheme] = (sourceKinds[scheme] ?? 0) + 1
  }
  let viewer = null
  if (${Boolean(openViewer)}) {
    const thumbnail = images.find((image) => image.classList.contains('v3-img-open'))
    if (!thumbnail) throw new Error('Fixture thumbnail not found')
    const thumbnailUrl = thumbnail.getAttribute('src')
    thumbnail.click()
    await wait(() => document.querySelector('.imgv-image')?.getAttribute('src'), 'viewer display URL')
    const enlarged = document.querySelector('.imgv-image')
    await enlarged.decode()
    const viewerUrl = enlarged.getAttribute('src')
    const width = enlarged.naturalWidth
    const height = enlarged.naturalHeight
    if (!width || !height) throw new Error('Viewer image did not decode')
    const close = enlarged.closest('.ui-dialog')?.querySelector('.ui-dialog__close')
    if (!close) throw new Error('Viewer close button not found')
    close.click()
    await wait(() => !document.querySelector('.imgv-image'), 'viewer close')
    await wait(() => !window.__memorySoakUrlTracker.active.has(viewerUrl), 'viewer URL release')
    if (!window.__memorySoakUrlTracker.active.has(thumbnailUrl)) throw new Error('Closing viewer revoked its thumbnail')
    viewer = { decoded: true, width, height, revokedAfterClose: true, thumbnailStillActive: true }
  }
  return { images: images.length, decoded: images.length, sourceKinds, viewer }
})()`)

const buildFake = (from, to) => {
  const fake = []
  for (let i = from; i < to; i++) {
    if (i % 3 === 0) fake.push({ id: 'm' + i, role: 'user', text: `第 ${i} 条用户消息，用于内存实测。` })
    else if (i % 3 === 1)
      fake.push({
        id: 'm' + i,
        role: 'assistant',
        text: `第 ${i} 条回复\n\n- 要点一\n- 要点二\n\n\u0060\u0060\u0060bash\necho ${i}\n\u0060\u0060\u0060`,
        usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: 0.0002 }
      })
    else
      fake.push({
        id: 'm' + i,
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'c' + i, name: 'bash', args: { command: 'echo ' + i }, status: 'ok', output: 'ok\n' + 'x'.repeat(200) }]
      })
  }
  return fake
}

if (soak.cycles) {
  const rows = []
  const startedAt = new Date().toISOString()
  const file = join(outDir, `memory-soak-${Date.now()}-${process.pid}.json`)
  let failure = null
  const coverage = {
    synthetic: true, credentialsCopied: false, modelRequests: 0,
    sessions: 'renderer-store fixtures; not end-to-end session activation or model execution',
    canvas: 'store-only filePreview loading placeholder toggles; no HtmlCanvas mount or native WebContentsView lifecycle measured',
    sampling: 'renderer heap after forced GC, DOM/listeners, Windows owned process tree; busy means fixture retained, not model activity',
    interpretation: 'growth is descriptive, not a leak verdict; image raster/GPU memory is not renderer JS heap'
  }
  const nativeDumps = []
  let pressure = null
  let documentReset = null
  let inspectorReconnect = null
  let viewerVerified = false
  const scenarios = soak.diagnose ? [
    { name: 'messages-only', options: { ...soak, imagesPerSession: 0 }, render: true },
    { name: 'generated-images-only', options: { ...soak, messagesPerSession: 12 }, render: false },
    { name: 'visible-unique-images', options: { ...soak, messagesPerSession: 12 }, render: true },
    { name: 'visible-reused-images', options: { ...soak, messagesPerSession: 12 }, render: true, seed: 2000 + soak.cycles },
    { name: 'visible-blob-images', options: { ...soak, messagesPerSession: 12, blobImages: true }, render: true }
  ] : [{ name: 'combined', options: soak, render: true }]
  const growthByScenario = () => Object.fromEntries(scenarios.map(({ name }) => [name, soakGrowth(rows.filter((row) => row.scenario === name))]))
  const save = () => {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(file, JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), options: soak, coverage, failure, rows, growth: soak.diagnose ? null : soakGrowth(rows), growthByScenario: growthByScenario(), nativeDumps, pressure, inspectorReconnect, documentReset }, null, 2), 'utf8')
  }
  const fixture = (action, cycle = 0, index = 0, options = soak) => evaluate(fixtureExpression(action, options, cycle, index, sandbox))
  const nativeDump = async (label) => {
    const events = []
    let finish
    const completed = new Promise((resolve) => { finish = resolve })
    let tracing = false
    cdp.onEvent = (event) => {
      if (event.method === 'Tracing.dataCollected') events.push(...event.params.value)
      if (event.method === 'Tracing.tracingComplete') finish()
    }
    try {
      await withTimeout(cdp.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [] } }, transferMode: 'ReportEvents' }), 20_000, 'Tracing.start')
      tracing = true
      const request = await withTimeout(cdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed', deterministic: true }), 30_000, 'Tracing.requestMemoryDump')
      await withTimeout(cdp.send('Tracing.end'), 20_000, 'Tracing.end')
      await withTimeout(completed, 20_000, 'Tracing.tracingComplete')
      tracing = false
      nativeDumps.push({ label, request, processes: summarizeMemoryDump(events), dumpEvents: events.filter((event) => event.args?.dumps?.allocators).map((event) => ({ pid: event.pid, id: event.id, id2: event.id2, name: event.name, level: event.args.dumps.level_of_detail })) })
    } catch (error) {
      nativeDumps.push({ label, error: String(error) })
    } finally {
      if (tracing) await withTimeout(cdp.send('Tracing.end'), 5000, 'Tracing cleanup').catch(() => {})
      cdp.onEvent = null
    }
  }
  try {
    await evaluate(`(() => {
      const create = URL.createObjectURL.bind(URL)
      const revoke = URL.revokeObjectURL.bind(URL)
      const tracker = window.__memorySoakUrlTracker = { created: 0, revoked: 0, active: new Set() }
      URL.createObjectURL = (blob) => { const url = create(blob); tracker.created++; tracker.active.add(url); return url }
      URL.revokeObjectURL = (url) => { if (tracker.active.delete(url)) tracker.revoked++; return revoke(url) }
    })()`)
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const prefix = soak.diagnose ? `${scenario.name}-` : ''
      await fixture('clear')
      await sleep(soak.delayMs)
      rows.push(await snapshot(`soak-${prefix}baseline`, { phase: 'baseline', cycle: 0, scenario: scenario.name }))
      save()
      for (let cycle = 1; cycle <= soak.cycles; cycle++) {
        const seed = scenario.seed ?? scenarioIndex * 1000 + cycle
        const prepared = await fixture('prepare', seed, 0, scenario.options)
        const imageChecks = []
        if (scenario.render) {
          for (let index = 0; index < soak.sessions; index++) {
            const observed = await fixture('switch', seed, index)
            if (observed.messages !== scenario.options.messagesPerSession) throw new Error('Soak fixture message count mismatch')
            await sleep(soak.delayMs)
            const openViewer = !viewerVerified && scenario.options.imagesPerSession > 0 && !scenario.options.blobImages
            imageChecks.push(await verifyImages(scenario.options.imagesPerSession > 0, openViewer))
            if (openViewer) viewerVerified = true
            await fixture('close-canvas')
          }
          await fixture('switch', seed, soak.sessions - 1)
        }
        await sleep(soak.delayMs)
        rows.push(await snapshot(`soak-${prefix}${cycle}-busy`, { phase: 'busy', cycle, scenario: scenario.name, seed, imageStats: prepared.imageStats, imageChecks }))
        await fixture('clear')
        await sleep(soak.delayMs)
        const cleared = await snapshot(`soak-${prefix}${cycle}-cleared`, { phase: 'cleared', cycle, scenario: scenario.name })
        rows.push(cleared)
        if (cleared.objectUrls?.active !== 0) throw new Error('Fixture left live object URLs after cleanup')
        save()
      }
      if (soak.diagnose) await nativeDump(scenario.name)
    }
    if (soak.diagnose) {
      await sleep(15_000)
      rows.push(await snapshot('soak-idle', { phase: 'idle', cycle: soak.cycles }))
      try {
        await withTimeout(cdp.send('Memory.simulatePressureNotification', { level: 'critical' }), 20_000, 'Memory.simulatePressureNotification')
        pressure = { level: 'critical', ok: true, scope: 'isolated browser instance only' }
      } catch (error) {
        pressure = { ok: false, error: String(error) }
      }
      await sleep(5000)
      rows.push(await snapshot('soak-after-pressure', { phase: 'after-pressure', cycle: soak.cycles }))
      await nativeDump('after-pressure')
      ws.close()
      await sleep(3000)
      const detached = sampleProcessTree(child.pid)
      const detachedRow = { label: 'soak-inspector-detached', phase: 'inspector-detached', cycle: soak.cycles, at: new Date().toISOString(), gcSucceeded: false, gcError: 'Inspector intentionally detached; no JS heap measurement', heapUsedMiB: null, processSamples: detached.processSamples, processes: detached.count, treeWorkingSetMiB: +detached.workingSetMiB.toFixed(1), treePrivateMiB: +detached.privateMiB.toFixed(1) }
      rows.push(detachedRow)
      console.log(JSON.stringify(detachedRow))
      ws = new WebSocket(target.webSocketDebuggerUrl)
      await withTimeout(new Promise((done, fail) => {
        ws.addEventListener('open', done, { once: true })
        ws.addEventListener('error', fail, { once: true })
      }), 15_000, 'CDP reconnect')
      cdp = new Cdp(ws)
      inspectorReconnect = { ok: true, scope: 'same isolated renderer; no document navigation' }
      await sleep(1000)
      rows.push(await snapshot('soak-after-inspector-reconnect', { phase: 'after-inspector-reconnect', cycle: soak.cycles }))
      await nativeDump('after-inspector-reconnect')
      try {
        await withTimeout(cdp.send('Page.navigate', { url: 'about:blank' }), 20_000, 'Page.navigate about:blank')
        documentReset = { ok: true, method: 'Page.navigate about:blank', scope: 'isolated page only; destroys the fixture document' }
      } catch (error) {
        documentReset = { ok: false, error: String(error) }
      }
      await sleep(3000)
      rows.push(await snapshot('soak-after-document-reset', { phase: 'after-document-reset', cycle: soak.cycles }))
      await nativeDump('after-document-reset')
    }
  } catch (error) {
    failure = error?.stack ?? String(error)
    process.exitCode = 1
    console.error(failure)
  } finally {
    await fixture('clear').catch(() => {})
    save()
    console.log(JSON.stringify({ report: file, growth: soak.diagnose ? growthByScenario() : soakGrowth(rows), pressure, inspectorReconnect, documentReset, failure }))
  }
} else {
const idleSec = Number(flag('idle', '0'))
if (idleSec > 0) {
  for (const domain of ['Runtime.enable', 'Page.enable', 'Inspector.enable', 'Log.enable']) {
    await cdp.send(domain).catch(() => {})
  }
  for (let i = 1; i <= idleSec; i++) {
    await sleep(1000)
    const alive = await evaluate('1+1').catch((e) => '✗ ' + e.message)
    const title = await evaluate('document.title').catch(() => '✗')
    console.error(`${i}s 心跳=${alive} title=${title}`)
    if (String(alive).startsWith('✗')) break
  }
  ws.close()
  killTree()
  await sleep(1500)
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(0)
}

if (argv.includes('--steps')) {
  const steps = [
    ['1+1', '1+1'],
    ['messages.length', 'window.__yanStore.getState().messages.length'],
    ['keys', 'Object.keys(window.__yanStore.getState()).slice(0, 12).join(",")'],
    ['setState empty', "window.__yanStore.setState({ messages: [] }), 'ok'"],
    ['applyPush 1', "window.__yanStore.getState().applyPush({ ch: 'sync', payload: [{ id: 'a', role: 'user', text: 'hi' }] }), 'ok'"],
    ['messages.length after', 'window.__yanStore.getState().messages.length'],
    ['document.title', 'document.title']
  ]
  for (const [label, expr] of steps) {
    try {
      const v = await evaluate(expr)
      console.error('✓', label, '=', String(v).slice(0, 200))
    } catch (e) {
      console.error('✗', label, ':', e.message)
      break
    }
  }
  const probeCall = async (label, method, params) => {
    try {
      const r = await withTimeout(cdp.send(method, params), 25_000, method)
      console.error('✓', label, '=', JSON.stringify(r).slice(0, 160))
    } catch (e) {
      console.error('✗', label, ':', e.message)
    }
  }
  await probeCall('Runtime.getHeapUsage', 'Runtime.getHeapUsage')
  await probeCall('HeapProfiler.enable', 'HeapProfiler.enable')
  await probeCall('Memory.getDOMCounters', 'Memory.getDOMCounters')
  await probeCall('HeapProfiler.collectGarbage', 'HeapProfiler.collectGarbage')
  await probeCall('Runtime.getHeapUsage#2', 'Runtime.getHeapUsage')
  await probeCall('HeapProfiler.disable', 'HeapProfiler.disable')
  await probeCall('Runtime.getHeapUsage#3', 'Runtime.getHeapUsage')
  ws.close()
  killTree()
  await sleep(1500)
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(0)
}

const evalInject = async (from, to) => {
  const payload = JSON.stringify(buildFake(from, to))
  const expr =
    injectMode === 'push'
      ? `window.__yanStore.getState().applyPush({ ch: 'sync', payload: ${payload} }), window.__yanStore.getState().messages.length`
      : `window.__yanStore.setState({ messages: ${payload} }), window.__yanStore.getState().messages.length`
  return evaluate(expr)
}

const processBreakdown = (rootPid) => {
  const tree = sampleProcessTree(rootPid)
  const ids = tree.processSamples.map((p) => p.pid)
  if (!ids.length) return { rows: [], byKind: {} }
  const script =
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ` +
    `Get-CimInstance Win32_Process | Where-Object { @(${ids.join(',')}) -contains $_.ProcessId } | ` +
    `Select-Object ProcessId,CommandLine,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress`
  let items = []
  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000
    })
    const parsed = raw.trim() ? JSON.parse(raw) : []
    items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  } catch (error) {
    console.error('  ⚠ 进程明细查询失败:', error?.message ?? String(error))
    return { rows: [], byKind: {} }
  }
  const kindOf = (cmd) => {
    const line = String(cmd ?? '')
    if (line.includes('--mode rpc') || line.includes('mode=rpc')) return 'pi-rpc'
    const type = line.match(/--type=([a-z-]+)/)?.[1]
    if (type === 'renderer') return line.includes('--extension-process') ? 'renderer-extension' : 'renderer'
    if (type === 'gpu-process') return 'gpu'
    if (type === 'utility') {
      if (line.includes('NetworkService') || line.includes('network.mojom')) return 'network'
      if (line.includes('storage') || line.includes('StorageService')) return 'storage'
      return 'utility'
    }
    if (type === 'crashpad-handler') return 'crashpad'
    return type ? `other:${type}` : 'main'
  }
  const rows = items
    .map((p) => ({
      pid: p.ProcessId,
      kind: kindOf(p.CommandLine),
      workingSetMiB: +((p.WorkingSetSize ?? 0) / 1048576).toFixed(1),
      privateMiB: +((p.PrivatePageCount ?? 0) / 1048576).toFixed(1)
    }))
    .sort((a, b) => b.workingSetMiB - a.workingSetMiB)
  const byKind = {}
  for (const row of rows) {
    byKind[row.kind] = byKind[row.kind] ?? { count: 0, workingSetMiB: 0, privateMiB: 0 }
    byKind[row.kind].count += 1
    byKind[row.kind].workingSetMiB = +(byKind[row.kind].workingSetMiB + row.workingSetMiB).toFixed(1)
    byKind[row.kind].privateMiB = +(byKind[row.kind].privateMiB + row.privateMiB).toFixed(1)
  }
  return { rows, byKind }
}

if (argv.includes('--browser')) {
  const report = (title, b) => {
    console.error(`=== ${title} ===`)
    for (const [kind, v] of Object.entries(b.byKind).sort((a, c) => c[1].workingSetMiB - a[1].workingSetMiB)) {
      console.error(`  ${kind.padEnd(20)} x${v.count} ws=${v.workingSetMiB} private=${v.privateMiB}`)
    }
  }
  const before = processBreakdown(child.pid)
  report('打开前', before)
  const opened = await evaluate(
    `window.__yanStore.getState().openBrowser('about:blank').then(() => window.__yanStore.getState().browserState?.open ?? false)`
  ).catch((e) => '✗ ' + e.message)
  console.error('openBrowser →', opened)
  await sleep(5000)
  const after = processBreakdown(child.pid)
  report('打开后', after)
  console.error('=== 增量 ===')
  for (const kind of new Set([...Object.keys(before.byKind), ...Object.keys(after.byKind)])) {
    const b = before.byKind[kind] ?? { count: 0, workingSetMiB: 0, privateMiB: 0 }
    const a = after.byKind[kind] ?? { count: 0, workingSetMiB: 0, privateMiB: 0 }
    console.error(`  ${kind.padEnd(20)} x${a.count - b.count} ws=${(a.workingSetMiB - b.workingSetMiB).toFixed(1)} private=${(a.privateMiB - b.privateMiB).toFixed(1)}`)
  }
  ws.close()
  killTree()
  await sleep(1500)
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(0)
}

if (argv.includes('--main-heap')) {
  const inspectJson = async (path) => {
    const res = await new Promise((done, fail) => {
      const req = httpGet({ host: '127.0.0.1', port: inspectPort, path, timeout: 3000 }, (r) => {
        let body = ''
        r.setEncoding('utf8')
        r.on('data', (c) => (body += c))
        r.on('end', () => done(body))
      })
      req.on('error', fail)
      req.on('timeout', () => req.destroy(new Error('timeout')))
    })
    return JSON.parse(res)
  }
  let nodeTarget = null
  for (let i = 0; i < 30 && !nodeTarget; i++) {
    await sleep(1000)
    try {
      const list = await inspectJson('/json/list')
      nodeTarget = list.find((t) => t.webSocketDebuggerUrl)
    } catch {
    }
  }
  if (!nodeTarget) {
    console.error('✗ 连不上主进程 inspector')
    killTree()
    rmSync(sandbox, { recursive: true, force: true })
    process.exit(1)
  }
  const nodeWs = new WebSocket(nodeTarget.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    nodeWs.addEventListener('open', done, { once: true })
    nodeWs.addEventListener('error', fail, { once: true })
  })
  const nodeCdp = new Cdp(nodeWs)
  const evaluateMain = async (expression) => {
    const res = await nodeCdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? 'evaluate failed')
    return res.result?.value
  }
  const usage = JSON.parse(
    await evaluateMain('JSON.stringify(process.memoryUsage())')
  )
  const heapStats = JSON.parse(await evaluateMain('JSON.stringify(process.getHeapStatistics())'))
  const mib = (n) => +(n / 1048576).toFixed(1)
  console.error('=== 主进程内存 ===')
  console.error(`  rss ${mib(usage.rss)} MiB | heapUsed ${mib(usage.heapUsed)} | heapTotal ${mib(usage.heapTotal)}`)
  console.error(`  external ${mib(usage.external)} | arrayBuffers ${mib(usage.arrayBuffers ?? 0)}`)
  const heapLimit = heapStats.heap_size_limit ?? heapStats.heapSizeLimit * 1024
  const heapUsed = heapStats.used_heap_size ?? heapStats.usedHeapSize * 1024
  console.error(`  堆上限 ${mib(heapLimit)} MiB，已用 ${((heapUsed / heapLimit) * 100).toFixed(1)}%`)
  const breakdown = processBreakdown(child.pid)
  mkdirSync(outDir, { recursive: true })
  const report = join(outDir, `memory-main-${Date.now()}.json`)
  writeFileSync(report, JSON.stringify({ usage, heapStats, breakdown }, null, 2))
  console.error(`报告: ${report}`)
  for (const [kind, v] of Object.entries(breakdown.byKind)) console.error(`  [进程树] ${kind} x${v.count} ws=${v.workingSetMiB} private=${v.privateMiB}`)
  nodeWs.close()
  ws.close()
  killTree()
  await sleep(1500)
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(0)
}

if (argv.includes('--procs')) {
  const breakdown = processBreakdown(child.pid)
  console.error('=== 进程分解（工作集 MiB） ===')
  for (const row of breakdown.rows) console.error(`  ${row.kind.padEnd(20)} pid=${row.pid} ws=${row.workingSetMiB} private=${row.privateMiB}`)
  console.error('=== 按类型合计 ===')
  for (const [kind, v] of Object.entries(breakdown.byKind).sort((a, b) => b[1].workingSetMiB - a[1].workingSetMiB)) {
    console.error(`  ${kind.padEnd(20)} x${v.count} ws=${v.workingSetMiB} private=${v.privateMiB}`)
  }
  const dom = await cdp.send('Memory.getDOMCounters').catch(() => ({}))
  const heap = await cdp.send('Runtime.getHeapUsage').catch(() => ({}))
  const messages = await evaluate('window.__yanStore.getState().messages.length').catch(() => null)
  const sessions = await evaluate('window.__yanStore.getState().sessions.length').catch(() => null)
  const views = await evaluate(
    `(() => { const s = window.__yanStore.getState(); return JSON.stringify({ browserOpen: !!s.browserState?.open, terminals: (s.terminals ?? []).length, subagents: (s.subagents ?? []).length }) })()`
  ).catch(() => null)
  console.error('=== 渲染端内部 ===')
  console.error(`  V8 堆 ${((heap.usedSize ?? 0) / 1048576).toFixed(1)} MiB，DOM ${dom.nodes ?? '?'} 节点，监听器 ${dom.jsEventListeners ?? '?'}`)
  console.error(`  消息 ${messages} 条，会话 ${sessions} 条，视图/资源 ${views}`)
  ws.close()
  killTree()
  await sleep(1500)
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(0)
}

if (argv.includes('--verify')) {
  const want = Number(flag('files', '15'))
  const trackedFiles = (limit) => {
    const listed = spawnSync('git', ['ls-files'], { encoding: 'utf8', cwd: root }).stdout ?? ''
    const picked = []
    for (const rel of listed.split('\n')) {
      if (!/\.(ts|tsx|js|mjs|css|md|json)$/.test(rel)) continue
      if (rel.startsWith('out/') || rel.includes('node_modules/')) continue
      try {
        const size = statSync(join(root, rel)).size
        if (size < 200 || size > 300_000) continue
      } catch {
        continue
      }
      picked.push(rel)
      if (picked.length >= limit) break
    }
    return picked
  }
  const files = want > 20
    ? trackedFiles(want)
    : [
        'package.json', 'README.md', 'AGENTS.md', 'tsconfig.web.json', 'tsconfig.node.json',
        'electron.vite.config.ts', 'scripts/launch.mjs', 'scripts/test-unit.mjs',
        'scripts/test-live.mjs', 'src/main/index.ts', 'src/main/agent.ts',
        'src/shared/ipc.ts', 'src/preload/index.ts', 'src/renderer/src/state/store.ts'
      ]
  const before = await snapshot('before-open')
  for (const file of files) {
    await evaluate(`window.__yanStore.getState().previewFile(${JSON.stringify(file)}, null, ${JSON.stringify(root)}, null)`)
  }
  const after = await snapshot('after-open')
  const current = await evaluate('window.__yanStore.getState().filePreview?.path ?? null')
  console.error(`预览：依次打开 ${files.length} 个文件（当前预览 ${current}）`)
  console.error(
    `渲染端增量：堆 ${(after.heapUsedMiB - before.heapUsedMiB).toFixed(1)} MiB，` +
    `DOM ${after.domNodes - before.domNodes} 节点，监听器 ${after.jsEventListeners - before.jsEventListeners}，` +
    `树工作集 ${(after.treeWorkingSetMiB - before.treeWorkingSetMiB).toFixed(1)} MiB`
  )
  const runId = 'probe-subagent-delta'
  const fullRun = {
    id: runId, task: 'probe', model: 'probe/model', status: 'running', startedAt: 1,
    transcript: [
      { id: 'a1', role: 'assistant', text: 'A1' },
      { id: 'a2', role: 'assistant', text: 'A2' }
    ]
  }
  const patch = {
    id: runId,
    run: { ...fullRun, transcript: [{ id: 'a3', role: 'assistant', text: 'A3' }] },
    transcriptFrom: 2
  }
  await evaluate(`window.__yanStore.getState().applyPush({ ch: 'subagent', payload: ${JSON.stringify(fullRun)} })`)
  await evaluate(`window.__yanStore.getState().applyPush({ ch: 'subagent-patch', payload: ${JSON.stringify(patch)} })`)
  const merged = await evaluate(
    `JSON.stringify(window.__yanStore.getState().subagents.find(r => r.id === ${JSON.stringify(runId)})?.transcript?.map(m => m.text) ?? null)`
  )
  const deltaOk = merged === JSON.stringify(['A1', 'A2', 'A3'])
  console.error(`subagent-patch 拼接 → ${merged}`)
  console.error(deltaOk ? '✓ 增量拼接正确' : '✗ 增量拼接错误')
  const ok = afterCount <= Math.max(12, opened) && deltaOk
  ws.close()
  killTree()
  await sleep(1500)
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(ok ? 0 : 1)
}

const rows = []
for (const domain of ['Runtime.enable', 'Page.enable', 'Inspector.enable', 'Log.enable', 'Network.enable']) {
  await cdp.send(domain).catch((e) => console.error('  ⚠ ' + domain + ':', e.message))
}
try {
  rows.push(await snapshot('startup'))
  for (const n of scales) {
    if (n === 0) continue
    console.error(`  注入消息 0..${n}`)
    const okCount = await evalInject(0, n)
    console.error(`    当前消息数 ${okCount}`)
    await sleep(1200)
    rows.push(await snapshot(`messages=${n}`))
  }
} finally {
  const report = {
    at: new Date().toISOString(),
    scales,
    sandbox,
    logTail: log.slice(-2000),
    rows
  }
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `memory-baseline-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
  console.log('报告:', file)
  ws.close()
  killTree()
  await sleep(1500)
  rmSync(sandbox, { recursive: true, force: true })
}
}
} finally {
  try {
    ws?.close()
  } finally {
    killTree()
    await sleep(1500)
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
}
