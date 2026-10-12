import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'inkstone-files-voice-'))
async function load(entry) {
  const outfile = join(root, `${entry.replaceAll('/', '-')}.mjs`)
  await build({ entryPoints: [`src/main/${entry}.ts`], outfile, bundle: true, platform: 'node', format: 'esm', external: ['node-pty'] })
  return import(pathToFileURL(outfile).href)
}
try {
  const sources = await load('sources')
  const sourceDir = join(root, 'data')
  sources.configureSources({ dir: sourceDir })
  const image = Buffer.from('behavioral fixture image bytes')
  const encoded = image.toString('base64')
  const saved = sources.saveImage({ sessionId: 's1', name: 'x.png', mimeType: 'image/png', base64: encoded })
  assert.ok(saved)
  assert.deepEqual(await readFile(saved.ref), image)
  await writeFile(saved.ref, 'partial')
  assert.ok(sources.saveImage({ sessionId: 's1', name: 'x.png', mimeType: 'image/png', base64: encoded }))
  assert.deepEqual(await readFile(saved.ref), image, 'truncated content-addressed image is repaired')
  assert.equal(sources.saveImage({ sessionId: 's1', name: 'large.png', mimeType: 'image/png', base64: 'A'.repeat(28 * 1024 * 1024) }), null)
  const dir = sources.sourcesDir('s1')
  const disappearing = join(dir, 'a.png')
  await writeFile(disappearing, image)
  await rm(disappearing)
  assert.equal(sources.listImagesForSession('s1').ok, true)

  const refs = await load('file-refs')
  const cwd = join(root, 'cwd')
  await mkdir(cwd)
  const textFile = join(cwd, 'tail.txt')
  await writeFile(textFile, 'before')
  assert.equal((await refs.readPreview('tail.txt', cwd)).text, 'before')
  assert.equal((await refs.readPreview('../outside.txt', cwd)).error, '路径越界')

  await build({ entryPoints: ['src/main/voice/voice-service.ts'], outfile: join(root, 'voice-service-compiled.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] })
  const terminal = await load('terminal')
  const boundary = terminal.safeTerminalCut('abcdef\nrest', 2)
  assert.equal('abcdef\nrest'.slice(boundary), 'rest')
  const surrogate = 'abc😀tail'
  const surrogateCut = terminal.safeTerminalCut(surrogate, 4)
  assert.notEqual(surrogate.charCodeAt(surrogateCut - 1) >= 0xd800 && surrogate.charCodeAt(surrogateCut - 1) <= 0xdbff, true)

  const storageMove = await load('storage-move')
  const origin = join(root, 'agent')
  assert.match(storageMove.checkTarget(origin, join(origin, '..-named-sibling')), /不能迁移到原数据目录里面/)
  assert.equal(storageMove.checkTarget(origin, join(root, 'target')), undefined)

  const taskPlans = await load('task-plan-store')
  const taskOpts = { dir: join(root, 'plans') }
  const writes = Array.from({ length: 20 }, (_, index) => taskPlans.applyTaskPlanOperation({
    sessionId: 'session-queue', round: 1, opts: taskOpts,
    request: { action: 'add', operationId: `parallel-${index}`, items: [{ text: `item-${index}` }] }
  }))
  const results = await Promise.all(writes)
  assert.ok(results.every((result) => result.ok))
  const plan = await taskPlans.currentTaskPlan('session-queue', taskOpts)
  assert.equal(plan.state.revision, 20)
  assert.equal(plan.state.todos.length, 20)

  const inbox = await load('task-inbox-sources')
  const stateRoot = join(root, 'inbox')
  const dismissed = Array.from({ length: 510 }, (_, i) => `session-${i}`)
  await inbox.writeInboxState({ dismissed, readUntil: {} }, stateRoot)
  const state = await inbox.readInboxState(stateRoot)
  assert.equal(state.dismissed.length, 500)
  assert.equal(state.dismissed[0], 'session-10')
  assert.equal(JSON.parse(await readFile(join(stateRoot, 'task-inbox.json'), 'utf8')).dismissed.length, 500)
  console.log('review2 files-voice isolated probes passed: source image repair/size cap, disappearing-file listing, file preview boundary, terminal safe cut, migration segment validation, concurrent task-plan queue ordering, inbox latest-500 persistence; voice module compiled without launching Electron/network')
} finally {
  await rm(root, { recursive: true, force: true })
}
