import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { syntheticEnvironment } from './lib/live-synthetic-isolation.mjs'
import { sampleProcessTree } from './lib/process-sample.mjs'

const bundle = await build({ entryPoints: ['scripts/lib/memory-soak.mjs'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { soakOptions, fixtureExpression, soakGrowth, summarizeMemoryDump } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const isolated = syntheticEnvironment({ OPENAI_API_KEY: 'fixture', ANTHROPIC_AUTH_TOKEN: 'fixture', YAN_CLI_TOKEN: 'fixture', ELECTRON_RENDERER_URL: 'http://fixture', ELECTRON_RUN_AS_NODE: '1', PATH: 'fixture' })
assert.equal(isolated.PI_OFFLINE, '1')
assert.deepEqual(Object.keys(isolated).sort(), ['PATH', 'PI_OFFLINE'])
assert.equal(soakOptions([]).cycles, 0)
assert.equal(soakOptions(['--soak-cycles', '2', '--soak-diagnose']).diagnose, true)
assert.throws(() => soakOptions(['--soak-diagnose']))
assert.throws(() => sampleProcessTree(0))
if (process.platform === 'win32') {
  const sample = sampleProcessTree(process.pid)
  assert.equal(sample.processSamples.find((item) => item.pid === process.pid).role, 'root')
  assert.ok(sample.processSamples.every((item) => !('commandLine' in item)))
}
assert.equal(soakOptions(['--soak-cycles', '30']).delayMs, 1500)
for (const argv of [['--soak-cycles'], ['--soak-cycles', '0'], ['--soak-cycles', '1.5'], ['--soak-delay-ms', '2'], ['--soak-cycles', '2', '--soak-delay-ms', '-1'], ['--soak-cycles', '2', '--verify']]) {
  assert.throws(() => soakOptions(argv))
}
const options = { ...soakOptions(['--soak-cycles', '2', '--soak-delay-ms', '0']), messagesPerSession: 12, imageSize: 2 }
let state = {}
const context = {
  window: { __yanStore: { setState: (patch) => { state = { ...state, ...patch } }, getState: () => state } },
  document: { createElement: () => ({ getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: () => {} }), toDataURL: () => 'data:image/png;base64,c3ludGhldGlj' }) }
}
const fixture = (action, cycle = 1, index = 0) => runInNewContext(fixtureExpression(action, options, cycle, index, 'synthetic-workspace'), context)
for (let cycle = 1; cycle <= 2; cycle++) {
  fixture('prepare', cycle)
  assert.equal(state.sessions.length, 3)
  for (let index = 0; index < 3; index++) {
    fixture('switch', cycle, index)
    assert.equal(state.messages.length, 12)
    assert.equal(state.messages.filter((message) => message.images).length, 4)
    assert.equal(state.session.sessionId, `memory-soak-${cycle}-${index}`)
    assert.equal(state.filePreview.loading, true)
    fixture('close-canvas')
    assert.equal(state.filePreview, null)
  }
  fixture('clear')
  assert.equal(state.messages.length, 0)
  assert.equal(state.sessions.length, 0)
  assert.equal(state.session, null)
  assert.equal(context.window.__memorySoakFixtures, undefined)
}
const withoutImages = { ...options, imagesPerSession: 0 }
runInNewContext(fixtureExpression('prepare', withoutImages, 3, 0, 'synthetic-workspace'), context)
runInNewContext(fixtureExpression('switch', withoutImages, 3, 0, 'synthetic-workspace'), context)
assert.equal(state.messages.filter((message) => message.images).length, 0)
fixture('clear')
const revoked = []
let blobCount = 0
context.atob = atob
context.Blob = Blob
context.URL = { createObjectURL: () => `blob:fixture-${++blobCount}`, revokeObjectURL: (url) => revoked.push(url) }
const blobs = runInNewContext(fixtureExpression('prepare', { ...options, blobImages: true }, 4, 0, 'synthetic-workspace'), context)
assert.equal(blobs.imageStats.base64Chars, 0)
runInNewContext(fixtureExpression('switch', options, 4, 0, 'synthetic-workspace'), context)
assert.ok(state.messages.filter((message) => message.images).every((message) => message.images[0].url.startsWith('blob:')))
fixture('clear')
assert.equal(revoked.length, options.sessions * options.imagesPerSession)
assert.equal(context.window.__memorySoakObjectUrls, undefined)
assert.throws(() => fixture('unknown'))
const dumps = summarizeMemoryDump([{ pid: 7, args: { dumps: { allocators: {
  'skia/gpu_resources': { attrs: { size: { type: 'scalar', units: 'bytes', value: '100000' } } },
  'unrelated': { attrs: {} }
} } } }, {}, { pid: 7, args: { dumps: { allocators: {} } } }])
assert.equal(dumps.length, 1)
assert.equal(dumps[0].pid, 7)
assert.equal(dumps[0].allocators.length, 1)
assert.equal(dumps[0].allocators[0].attributes.size.value, 1048576)
const cacheDump = [{ pid: 8, id: '0x000a', args: { dumps: { allocators: { 'web_cache/Image_resources': { attrs: { size: { type: 'scalar', value: '400', units: 'bytes' } } } } } } }]
assert.equal(summarizeMemoryDump(cacheDump)[0].allocators[0].attributes.size.value, 1024)
assert.equal(summarizeMemoryDump(cacheDump)[0].dumpId, '0x000a')
const growth = soakGrowth([
  { phase: 'baseline', cycle: 0, heapUsedMiB: 10 },
  { phase: 'busy', cycle: 1, heapUsedMiB: 100 },
  { phase: 'cleared', cycle: 1, heapUsedMiB: 12 },
  { phase: 'cleared', cycle: 2, heapUsedMiB: 14 }
])
assert.equal(growth.heapUsedMiB.delta, 4)
assert.equal(growth.heapUsedMiB.slopePerCycle, 2)
assert.equal(growth.heapUsedMiB.peakBusy, 100)
assert.equal(growth.domNodes, null)
await build({ entryPoints: ['scripts/measure-memory.mjs'], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
console.log('memory-soak: option validation, bundled renderer fixtures, cleanup, growth and entry bundling passed; no application launched')
