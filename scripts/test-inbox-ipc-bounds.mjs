import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build, transform } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-inbox-bounds-'))
try {
  const outfile = join(root, 'sources.mjs')
  await build({ entryPoints: ['src/main/task-inbox-sources.ts'], outfile, bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'paths', setup(api) {
    api.onResolve({ filter: /^\.\/paths$/ }, () => ({ path: 'paths', namespace: 'fixture' }))
    api.onLoad({ filter: /^paths$/, namespace: 'fixture' }, () => ({ contents: `export const YAN_DIR=${JSON.stringify(root)}; export const PI_AGENT_DIR=${JSON.stringify(root)};`, loader: 'js' }))
  } }] })
  const sources = await import(pathToFileURL(outfile).href)
  const initial = { dismissed: Array.from({ length: 500 }, (_, i) => `s${i}`), readUntil: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`old${i}`, i + 1])) }
  await sources.writeInboxState(initial, root)
  const source = await readFile('src/main/ipc/task-inbox-ipc.ts', 'utf8')
  const snippet = source.slice(source.indexOf('export function registerTaskInboxIpc')).replace('export function', 'function')
  const { code } = await transform(snippet + '\nregisterTaskInboxIpc(ipc, deps)', { loader: 'ts' })
  const handlers = new Map()
  let fail = false, projection
  runInNewContext(code, {
    ipc: { handle: (name, callback) => handlers.set(name, callback) }, deps: { runnerStatuses: () => [] }, questionLog: {},
    currentTaskPlan: async () => ({ state: { todos: [] } }),
    createTaskInboxSources: options => { projection = options; return options },
    createTaskInboxService: () => ({ invalidate: () => {}, page: async () => ({}) }),
    readInboxState: () => sources.readInboxState(root),
    writeInboxState: async state => { if (fail) throw new Error('fixture write failure'); return sources.writeInboxState(state, root) },
    Date, console
  })
  const dismiss = handlers.get('yan:taskinbox:dismiss'), seen = handlers.get('yan:taskinbox:seen')
  assert.equal((await dismiss('new')).dismissed.length, 500)
  assert.equal(projection.dismissed()[0], 's1')
  assert.equal(projection.dismissed().includes('new'), true)
  await seen('seen-new')
  const disk = JSON.parse(await readFile(join(root, 'task-inbox.json'), 'utf8'))
  assert.equal(disk.dismissed.length, 500)
  assert.equal(Object.keys(disk.readUntil).length, 200)
  fail = true
  await assert.rejects(dismiss('failed'), /fixture write failure/)
  assert.equal(projection.dismissed().includes('failed'), false)
  assert.equal(projection.dismissed().length, 500)
  fail = false
  await handlers.get('yan:taskinbox:restore')('new')
  assert.equal(projection.dismissed().length, 499)
  console.log('inbox-ipc-bounds: 9 assertions passed')
} finally { await rm(root, { recursive: true, force: true }) }
