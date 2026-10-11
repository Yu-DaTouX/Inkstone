import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import vm from 'node:vm'

const root = await mkdtemp(join(tmpdir(), 'inkstone-personal-state-'))
let checks = 0
const check = (fn) => { fn(); checks++ }
try {
  for (const [name, entry] of Object.entries({ state: 'src/main/interaction-state.ts', backup: 'src/main/data-backup.ts', bridge: 'src/renderer/src/lib/widget-state-bridge.ts' })) {
    await build({ entryPoints: [entry], outfile: join(root, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  }
  const { InteractionStore } = await import(pathToFileURL(join(root, 'state.mjs')).href)
  const { createDataBackup, verifyDataBackup } = await import(pathToFileURL(join(root, 'backup.mjs')).href)
  const { WIDGET_STATE_BRIDGE } = await import(pathToFileURL(join(root, 'bridge.mjs')).href)
  const yan = join(root, 'yan')
  const stateDir = join(yan, 'interaction-state')
  const state = new InteractionStore(stateDir)
  check(() => assert.deepEqual(state.get('A'), {}))
  state.set('A', 'bookmark:message', '1')
  state.set('B', 'bookmark:message', '1')
  state.set('A', 'widget:one', '{"fields":[],"custom":{"count":2}}')
  check(() => assert.equal(new InteractionStore(stateDir).get('A')['bookmark:message'], '1'))
  state.set('A', 'bookmark:message', null)
  check(() => assert.equal(state.get('A')['bookmark:message'], undefined))
  check(() => assert.equal(state.get('B')['bookmark:message'], '1'))
  check(() => assert.equal(JSON.parse(state.get('A')['widget:one']).custom.count, 2))
  check(() => assert.throws(() => state.set('A', '__proto__', 'x')))
  check(() => assert.throws(() => state.set('A', 'widget:large', '字'.repeat(30000))))
  const before = JSON.stringify(state.get('A'))
  check(() => assert.throws(() => state.set('A', 'widget:large', '字'.repeat(30000))))
  check(() => assert.equal(JSON.stringify(state.get('A')), before))

  const blockedRoot = join(root, 'blocked-state')
  await writeFile(blockedRoot, 'not-a-directory')
  check(() => assert.throws(() => new InteractionStore(blockedRoot).set('A', 'bookmark:message', '1')))
  check(() => assert.equal(JSON.stringify(state.get('A')), before))

  const identityRoot = join(root, 'identity-state')
  const identityStore = new InteractionStore(identityRoot)
  identityStore.set('A', 'bookmark:message', '1')
  const identityFile = join(identityRoot, (await readdir(identityRoot)).find((name) => name.endsWith('.json')))
  const wrongIdentity = JSON.stringify({ version: 1, session: 'B', values: { 'bookmark:message': '1' } })
  await writeFile(identityFile, wrongIdentity)
  check(() => assert.throws(() => identityStore.get('A'), /Invalid interaction state/))
  check(() => assert.throws(() => identityStore.set('A', 'bookmark:other', '1'), /Invalid interaction state/))
  const identityAfter = await readFile(identityFile, 'utf8')
  check(() => assert.equal(identityAfter, wrongIdentity))

  const sessions = join(root, 'sessions')
  const dest = join(root, 'backups')
  await mkdir(sessions)
  await mkdir(dest)
  await writeFile(join(sessions, 'one.jsonl'), '{"id":"A"}\n')
  await writeFile(join(yan, 'desktop.json'), '{"theme":"dark"}')
  await writeFile(join(yan, 'auth.json'), '{"token":"not-backed-up"}')
  const backup = await createDataBackup(dest, sessions, yan)
  check(() => assert.equal(backup.files, 4))
  const manifestPath = join(backup.path, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  check(() => assert.ok(manifest.files.every((f) => !f.path.includes('auth'))))
  check(() => assert.equal(manifest.files.find((f) => f.path.includes('one.jsonl')).sha256.length, 64))
  await verifyDataBackup(backup.path); checks++
  await assert.rejects(createDataBackup(yan, sessions, yan)); checks++
  await writeFile(join(backup.path, 'sessions', 'one.jsonl'), 'tampered')
  await assert.rejects(verifyDataBackup(backup.path)); checks++
  manifest.files[0].path = '../outside.jsonl'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(verifyDataBackup(backup.path)); checks++

  const handlers = []
  const posted = []
  const controls = [
    { id: 'amount', name: 'amount', type: 'range', value: '25', dispatchEvent() {} },
    { id: 'password', name: 'password', type: 'password', value: 'secret', dispatchEvent() {} }
  ]
  const parent = { postMessage: (data) => posted.push(data) }
  const context = vm.createContext({ parent, window: { dispatchEvent() {} }, document: { querySelectorAll: () => controls }, addEventListener: (_, fn) => handlers.push(fn), Event: class {}, CustomEvent: class {} })
  vm.runInContext(WIDGET_STATE_BRIDGE, context)
  const send = (data, source = parent) => handlers[0]({ source, data: { yanWidgetState: 1, ...data } })
  send({ type: 'capture', request: 'wrong-parent' }, {})
  check(() => assert.equal(posted.length, 0))
  context.window.setInkstoneState({ count: 7 })
  send({ type: 'capture', request: 'r1' })
  const captured = JSON.parse(posted[0].text)
  check(() => assert.equal(captured.fields.length, 1))
  check(() => assert.equal(captured.fields[0].value, '25'))
  check(() => assert.equal(captured.custom.count, 7))
  controls[0].value = '1'
  send({ type: 'restore', state: captured })
  check(() => assert.equal(controls[0].value, '25'))
  check(() => assert.equal(controls[1].value, 'secret'))

  const file = (await readdir(stateDir)).find((name) => name.endsWith('.json'))
  await writeFile(join(stateDir, file), '{broken')
  const damaged = new InteractionStore(stateDir)
  check(() => assert.ok(['A', 'B'].some((id) => { try { damaged.get(id); return false } catch { return true } })))
  console.log(`personal-state: ${checks} focused checks passed`)
} finally {
  await rm(root, { recursive: true, force: true })
}
