import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build, transform } from 'esbuild'

async function bundled(path) {
  const input = path.endsWith('page-store.ts') ? { stdin: { contents: "export * from './src/main/search/page-store'; export { ReadPageError } from './src/main/search/page-types'", resolveDir: process.cwd() } } : { entryPoints: [path] }
  const result = await build({ ...input, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' })
  const module = { exports: {} }
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: (await import('node:module')).createRequire(import.meta.url), process, URL })
  return module.exports
}
const { PageStore, pageRange, findInPage, ReadPageError } = await bundled('src/main/search/page-store.ts')
const { executionBusy } = await bundled('src/core/run-state.ts')
const { isWithin } = await bundled('src/main/file-path-gate.ts')
let checks = 0
const failures = []
async function check(name, fn) {
  try { await fn(); checks++; console.log('PASS ' + name) }
  catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message) }
}
const lookupSource = (await readFile('src/main/lookup-commands.ts', 'utf8')).replace(/^import .*$/gm, '')
class CommandError extends Error { constructor(code, message) { super(message); this.code = code } }
const lookupModule = { exports: {} }
runInNewContext((await transform(lookupSource, { loader: 'ts', format: 'cjs' })).code, {
  module: lookupModule, exports: lookupModule.exports, PageStore, pageRange, findInPage, ReadPageError,
  CapabilityCommandError: CommandError, TtlCache: class {}, SourceCooldown: class {}, Date
})
const lookup = new lookupModule.exports.LookupCommands({})
const links = Array.from({ length: 150 }, (_, index) => ({ url: `https://example.com/${index}`, text: String(index) }))
const snapshot = lookup.pages.put({ url: 'https://example.com', finalUrl: 'https://example.com', title: 'short', text: 'tiny', totalChars: 4, truncated: false, links }, 'local')
const fetch = params => lookup.runSearchCommand('fetch', { pageRef: snapshot.pageRef, action: 'links', ...params })
await check('short body, 150 links, two pages and text summary', async () => {
  const first = await fetch({})
  assert.equal(first.data.links.length, 100)
  const second = await fetch({ offset: first.data.nextOffset })
  assert.equal(second.data.links.length, 50)
  assert.equal(second.data.links[0].url, links[100].url)
  assert.equal(second.data.nextOffset, undefined)
  assert.equal(second.summary.chars, 4)
  assert.equal(second.summary.totalChars, 4)
  assert.equal(second.summary.offset, 0)
  assert.equal(second.summary.endOffset, 4)
  assert.equal(second.summary.truncated, false)
})
await check('link offset boundaries and empty body', async () => {
  assert.equal((await fetch({ offset: 150 })).data.links.length, 0)
  for (const offset of [-1, 1.5, 151]) await assert.rejects(fetch({ offset }), error => error.code === 'search_fetch_bad_offset')
  const empty = lookup.pages.put({ ...snapshot, text: '', links }, 'local')
  assert.equal((await lookup.runSearchCommand('fetch', { pageRef: empty.pageRef, action: 'links', offset: 100 })).data.links.length, 50)
  await assert.rejects(lookup.runSearchCommand('fetch', { pageRef: snapshot.pageRef, offset: 100 }), error => error.code === 'search_fetch_bad_offset')
  await assert.rejects(lookup.runSearchCommand('fetch', { pageRef: snapshot.pageRef, action: 'find', find: 'tiny', offset: 100 }), error => error.code === 'search_fetch_bad_offset')
})
const source = await readFile('src/main/index.ts', 'utf8')
const start = source.indexOf('  configureWriteContext({')
assert.notEqual(start, -1)
const snippet = source.slice(start, source.indexOf('\n  })', start) + '\n  })'.length)
const samePathKind = (a, b) => a === b
let guard
let states = [], children = []
const runners = {
  statuses: () => states,
  agentOf: id => {
    const st = states.find(st => st.id === id)
    return { getState: () => st.state ?? {}, hasRunningBash: () => !!st.bash, getPendingUiCount: () => st.ui ?? 0 }
  },
  hasExecutionAdmission: cwd => states.some(st => st.cwd === cwd && st.admission)
}
runInNewContext((await transform(snippet, { loader: 'ts' })).code, {
  configureWriteContext: context => { guard = context.hasRunningTask }, runners,
  subagentService: { current: () => ({ list: () => children }) }, samePathKind, executionBusy, isWithin, resolve
})
const root = resolve('fixture/repo')
for (const [name, extra] of [
  ['agent', { running: true, state: { isAgentRunning: true } }],
  ['bash', { bash: true }], ['UI approval', { ui: 1 }],
  ['compaction', { state: { isCompacting: true } }], ['streaming', { state: { isStreaming: true } }],
  ['pending message', { state: { pendingMessageCount: 1 } }], ['admission', { admission: true }]
]) await check('Git blocks subdirectory ' + name, () => {
  states = [{ id: 'run', cwd: resolve(root, 'src'), ...extra }]
  assert.equal(guard(root), true)
  assert.equal(guard(resolve('fixture/unrelated')), false)
  assert.equal(guard(root + '-other'), false)
})
await check('Git idle and same-root controls', () => {
  states = [{ id: 'run', cwd: root }]
  assert.equal(guard(root), false)
  states[0].bash = true
  assert.equal(guard(root), true)
})
await check('Git running/starting subagents scoped to actual cwd', () => {
  states = []
  for (const status of ['running', 'starting']) {
    children = [{ status, cwd: resolve(root, 'src') }]
    assert.equal(guard(root), true)
    assert.equal(guard(resolve('fixture/unrelated')), false)
  }
  children = [{ status: 'done', cwd: root }]
  assert.equal(guard(root), false)
})
console.log(`${checks} passed; ${failures.length} failed`)
if (failures.length) process.exitCode = 1
