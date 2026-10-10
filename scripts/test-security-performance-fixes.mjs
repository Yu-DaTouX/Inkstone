/** Bounded regressions for browser provenance, archive budgets, search and remote/cache pressure. */
import assert from 'node:assert/strict'
import { build, transform } from 'esbuild'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { get } from 'node:http'
import { Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'

const previousEnv = { sessions: process.env.YAN_SESSIONS_DIR, data: process.env.YAN_DATA_DIR }
const temp = await mkdtemp(join(tmpdir(), 'inkstone-security-fixes-'))
process.env.YAN_SESSIONS_DIR = join(temp, 'sessions')
process.env.YAN_DATA_DIR = join(temp, 'data')
await mkdir(process.env.YAN_SESSIONS_DIR)
await mkdir(process.env.YAN_DATA_DIR)
async function mod(file, name) {
  const outfile = resolve('out/test/security-fixes', `${name}.mjs`)
  await build({ entryPoints: [file], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}
function zip(entries, { stored = false, fakeSize } = {}) {
  const local = [], central = []
  let offset = 0
  for (const [name, value] of entries) {
    const text = Buffer.from(value), filename = Buffer.from(name), data = stored ? text : deflateRawSync(text)
    const l = Buffer.alloc(30), c = Buffer.alloc(46)
    l.writeUInt32LE(0x04034b50); l.writeUInt16LE(stored ? 0 : 8, 8)
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(fakeSize ?? text.length, 22); l.writeUInt16LE(filename.length, 26)
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(stored ? 0 : 8, 10)
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(fakeSize ?? text.length, 24)
    c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42)
    local.push(l, filename, data); central.push(c, filename); offset += 30 + filename.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
try {
  const { ZipReader } = await mod('src/main/office/zip.ts', 'zip')
  for (const stored of [true, false]) {
    assert.throws(() => new ZipReader(zip([['x', 'x'.repeat(2 * 1024 * 1024)]], { stored, fakeSize: 1 }), 1024 * 1024).read('x'))
    assert.equal(new ZipReader(zip([['x', 'normal']], { stored })).text('x'), 'normal')
  }
  const reader = new ZipReader(zip([['a', 'a'.repeat(80)], ['b', 'b'.repeat(80)]]), 100, 100)
  assert.equal(reader.read('a').length, 80)
  assert.equal(reader.read('a').length, 80)
  assert.throws(() => reader.read('b'))
  console.log('✓ stored/deflate actual size and cumulative archive limits')

  const { extractOffice } = await mod('src/main/office/extract.ts', 'office')
  const long = zip([['ppt/slides/slide1.xml', '<a:p><a:t>' + 'x'.repeat(2 * 1024 * 1024) + '</a:t></a:p>']])
  const preview = extractOffice(long, 'pptx')
  assert.equal(preview.ok, true); assert.equal(preview.truncated, true)
  assert.equal(preview.sections[0].lines[0].length + preview.sections[0].title.length, 512 * 1024)
  assert.equal(extractOffice(zip([['word/document.xml', 'x'.repeat(9 * 1024 * 1024)]]), 'docx').ok, false)
  console.log('✓ Office response character budget and oversized XML rejection')

  const doc = join(temp, 'sample.pptx'); await writeFile(doc, long)
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  const workerResult = await new Promise((resolveRun, reject) => {
    const worker = new Worker(resolve('out/main/office-worker.js'), { workerData: { path: doc, format: 'pptx' } })
    worker.once('message', result => { void worker.terminate(); resolveRun(result) })
    worker.once('error', reject)
    worker.once('exit', code => { if (code) reject(new Error('worker exit ' + code)) })
  })
  clearInterval(timer)
  assert.equal(workerResult.ok, true); assert.ok(ticks > 0)
  console.log(`✓ built Office worker reads/extracts while parent timer runs (${ticks} ticks)`)

  const { readSessionSearchText, searchSessionText } = await mod('src/main/session-search.ts', 'search-files')
  const row = text => JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  const large = join(temp, 'large.jsonl')
  await writeFile(large, row('head-marker') + row('Synthetic history '.repeat(100)).repeat(20000) + row('tail-marker'))
  ticks = 0
  const searchTimer = setInterval(() => ticks++, 1), start = performance.now()
  const text = await readSessionSearchText(large)
  clearInterval(searchTimer)
  assert.ok(text.startsWith('head-marker') && text.endsWith('tail-marker'))
  assert.ok(text.length <= 409603 && ticks > 0)
  console.log(`✓ 37MB streaming search bounded to ${text.length} chars, ${ticks} timer ticks in ${(performance.now() - start).toFixed(1)}ms`)
  await writeFile(join(temp, 'oversize.jsonl'), row('x'.repeat(9 * 1024 * 1024)) + row('after-oversize'))
  assert.equal(await readSessionSearchText(join(temp, 'oversize.jsonl')), 'after-oversize')
  for (let i = 0; i < 30; i++) await writeFile(join(process.env.YAN_SESSIONS_DIR, `${i}.jsonl`), row('all-histories-marker ' + i))
  const searched = await searchSessionText('all-histories-marker', 100)
  assert.equal(searched.total, 30); assert.equal(searched.hits.length, 30); assert.ok(searched.indexed < searched.total)
  console.log('✓ cold histories remain searchable outside the global index cache')

  const attachments = await mod('src/main/attachments.ts', 'attachments')
  const imageDir = join(temp, 'attachments'), historyDir = join(temp, 'attachment-history')
  await mkdir(imageDir); await mkdir(join(historyDir, 'sessions'), { recursive: true })
  const hash = createHash('sha1').update('USED').digest('hex')
  const sessionFile = join(historyDir, 'sessions', 'session.jsonl')
  const validImageRow = '{ "message": { "content": [{ "type" : "image", "data" : "USED" }] } }'
  await writeFile(join(imageDir, hash + '.png'), 'synthetic image')
  await writeFile(join(imageDir, 'unreferenced.png'), 'synthetic stale image')
  await writeFile(sessionFile, validImageRow)
  const source = await readFile('src/main/ipc/files-ipc.ts', 'utf8')
  const handlerSource = source.slice(source.indexOf("  handle('yan:attachments:prune'"), source.lastIndexOf('\n}'))
  let prune, busy = true, mutate = false
  vm.runInNewContext((await transform(handlerSource, { loader: 'ts', target: 'es2022' })).code, {
    handle: (_channel, callback) => { prune = callback }, deps: { isSessionBusy: () => busy },
    join: (...parts) => parts[parts.length - 1] === 'attachments' ? imageDir : join(...parts),
    PI_AGENT_DIR: historyDir, YAN_DIR: temp, statSync, ...attachments,
    referencedAttachmentNames: async files => {
      const refs = await attachments.referencedAttachmentNames(files)
      if (mutate) await writeFile(sessionFile, validImageRow + '\n{}')
      return refs
    }
  })
  await assert.rejects(prune(), /正在运行/)
  busy = false
  await writeFile(sessionFile, '{ broken')
  await assert.rejects(prune(), /历史不完整/)
  await writeFile(sessionFile, validImageRow)
  mutate = true
  await assert.rejects(prune(), /扫描期间发生变化/)
  assert.ok(existsSync(join(imageDir, hash + '.png')) && existsSync(join(imageDir, 'unreferenced.png')))
  mutate = false
  await new Promise(done => setTimeout(done, 10))
  const cleaned = await prune()
  assert.equal(cleaned.removed, 1); assert.ok(existsSync(join(imageDir, hash + '.png')))
  console.log('✓ production attachment IPC refuses busy/corrupt/changing histories; stable scan removes only unreferenced fixture')

  const { routePush } = await mod('src/renderer/src/state/push-routing.ts', 'routing')
  const { updateSessionRuntime } = await mod('src/renderer/src/state/session-runtime.ts', 'runtime')
  let view = { runners: [], activeRunnerId: 'active', peekedSessionId: 'visible', session: null, sessionRuntimes: {}, visibleSessionIds: ['split'] }
  for (const id of ['visible', 'split', ...Array.from({ length: 80 }, (_, i) => 's' + i)]) {
    const runtime = { sessionId: id, runId: id, generation: 1 }
    const result = routePush(view, { ch: 'sync', runtime, payload: [{ id: 'm', text: 'history', role: 'assistant' }] })
    view = { ...view, ...result.patch }
    if (id === 's0') view.sessionRuntimes = updateSessionRuntime(view.sessionRuntimes, runtime, { draft: 'preserve draft' })
  }
  assert.ok(Object.values(view.sessionRuntimes).filter(s => s.messages.length).length <= 19)
  assert.equal(view.sessionRuntimes.visible.messages.length, 1); assert.equal(view.sessionRuntimes.split.messages.length, 1)
  assert.equal(view.sessionRuntimes.s0.draft, 'preserve draft'); assert.equal(view.sessionRuntimes.s0.messages.length, 0)
  console.log('✓ runtime routing bounds cold histories while preserving visible panes and drafts')

  const { RemoteServer } = await mod('src/main/remote-server.ts', 'remote')
  const server = new RemoteServer({ host: '127.0.0.1', port: 0, token: 'synthetic-fix-test-token', handlers: {} })
  const info = await server.start()
  const requests = [], responses = []
  try {
    const connect = () => new Promise((done, reject) => {
      const req = get({ hostname: '127.0.0.1', port: info.port, path: '/remote/v1/events', headers: { authorization: 'Bearer synthetic-fix-test-token' } }, res => {
        res.pause(); responses.push(res); done(res)
      })
      req.on('error', reject); requests.push(req)
    })
    const client = await connect()
    for (let i = 0; i < 200; i++) server.publish({ ch: 'msg-update', payload: { id: 'm', patch: { textDelta: 'x'.repeat(65536) } } })
    assert.equal(server.clients.size, 0)
    assert.ok(server.bufferBytes <= 8 * 1024 * 1024)
    client.destroy()
    for (let i = 0; i < 32; i++) assert.equal((await connect()).statusCode, 200)
    assert.equal((await connect()).statusCode, 429)
    console.log('✓ real HTTP paused reader disconnected; replay byte and SSE connection caps enforced')
  } finally {
    responses.forEach(res => res.destroy()); requests.forEach(req => req.destroy())
    for (const client of server.clients) client.destroy()
    await server.stop()
  }
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  for (const [key, value] of [['YAN_SESSIONS_DIR', previousEnv.sessions], ['YAN_DATA_DIR', previousEnv.data]]) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
