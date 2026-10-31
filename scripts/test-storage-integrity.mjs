import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, utimes } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const output = resolve('.tmp/full-audit-fixes/storage')
await mkdir(output, { recursive: true })
const run = await mkdtemp(join(output, 'run-'))
const previous = Module._extensions['.ts']
Module._extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const results = []
async function test(name, action) {
  await action()
  results.push(name)
  console.log(`PASS ${name}`)
}
try {
  const { SyncService } = require('../src/main/sync/service.ts')
  const { LocalStore, defaultSyncPaths } = require('../src/main/sync/local-store.ts')
  const { buildConflictCopy } = require('../src/main/sync/resolve.ts')
  const { createDataBackup, readDataBackup } = require('../src/main/data-backup.ts')
  const { restoreDataBackup } = require('../src/main/data-restore.ts')
  await test('unresolved conflicts block both directions and refresh versions', async () => {
    const cloud = join(run, 'cloud')
    const aDir = join(run, 'a')
    const bDir = join(run, 'b')
    for (const dir of [cloud, aDir, bDir]) await mkdir(join(dir, 'prompts'), { recursive: true })
    const a = new SyncService({ dataDir: aDir, syncRoot: cloud, deviceId: 'a', deviceName: 'A' })
    const b = new SyncService({ dataDir: bDir, syncRoot: cloud, deviceId: 'b', deviceName: 'B' })
    const af = join(aDir, 'prompts', 'note.md')
    const bf = join(bDir, 'prompts', 'note.md')
    await writeFile(af, 'base')
    assert.equal((await a.sync()).ok, true)
    await b.sync()
    await writeFile(af, 'A1')
    await writeFile(bf, 'B1')
    await a.sync()
    const first = await b.sync()
    assert.equal(first.conflicts.length, 1)
    const baseline = await readFile(join(bDir, 'sync-state.json'), 'utf8')
    await writeFile(bf, 'B2')
    const second = await b.sync()
    assert.deepEqual(second.pushed, [])
    assert.deepEqual(second.pulled, [])
    assert.equal(second.conflicts[0].localPayload, 'B2')
    assert.equal(await readFile(join(bDir, 'sync-state.json'), 'utf8'), baseline)
    await writeFile(af, 'A2')
    await a.sync()
    const third = await b.sync()
    assert.deepEqual(third.pulled, [])
    assert.equal(await readFile(bf, 'utf8'), 'B2')
    assert.equal(third.conflicts[0].remotePayload, 'A2')
    assert.equal((await b.resolveConflict(first.conflicts[0].id, 'both')).ok, false)
    assert.equal((await b.resolveConflict(third.conflicts[0].id, 'both')).ok, true)
    assert.equal((await b.listConflicts()).length, 0)
    assert.equal(readdirSync(join(bDir, 'prompts')).length, 2)
    await a.sync()
    await writeFile(af, 'A3')
    await writeFile(bf, 'B3')
    await a.sync()
    const fourth = await b.sync()
    assert.equal((await b.resolveConflict(fourth.conflicts[0].id, 'both')).ok, true)
    const payloads = readdirSync(join(bDir, 'prompts')).map((name) => readFileSync(join(bDir, 'prompts', name), 'utf8'))
    assert(payloads.includes('A2') && payloads.includes('A3') && payloads.includes('B3'))
  })
  await test('keep-both copies are unique and reject existing destinations for every kind', async () => {
    const store = new LocalStore(defaultSyncPaths(join(run, 'copies')))
    for (const kind of ['prompt', 'skill', 'bookmark', 'schedule']) {
      const key = `${kind}:sample`
      const payload = kind === 'bookmark' ? JSON.stringify({ session: '/fixture/session.jsonl', key: 'bookmark:test', value: 'remote' }) : kind === 'schedule' ? JSON.stringify({ id: 'sample', prompt: 'remote' }) : 'remote'
      const conflict = { id: '11111111-1111-4111-8111-111111111111', key, kind, remoteDeviceName: 'same-device', remotePayload: payload, remoteModifiedAt: 1 }
      const copy = buildConflictCopy(conflict)
      const other = buildConflictCopy({ ...conflict, id: '22222222-2222-4222-8222-222222222222' })
      assert.notEqual(copy.key, other.key)
      await store.applyCopy(copy)
      await assert.rejects(store.applyCopy({ ...copy, payload: copy.payload.replace('remote', 'changed') }))
      const attempts = await Promise.allSettled([store.applyCopy(other), store.applyCopy(other)])
      assert.equal(attempts.filter((entry) => entry.status === 'fulfilled').length, 1)
      const all = await store.readAll()
      assert.equal(all.skipped.length, 0)
      assert.equal(all.records.filter((entry) => entry.kind === kind).length, 2)
      assert(all.records.filter((entry) => entry.kind === kind).every((entry) => !entry.payload.includes('changed')))
    }
  })
  await test('pre-existing keep-both copy leaves conflict and both originals untouched', async () => {
    const dataDir = join(run, 'preset-copy')
    const cloud = join(run, 'preset-cloud')
    await mkdir(join(dataDir, 'prompts'), { recursive: true })
    await mkdir(cloud)
    const service = new SyncService({ dataDir, syncRoot: cloud, deviceId: 'preset', deviceName: 'preset' })
    const { SyncFolder } = require('../src/main/sync/sync-folder.ts')
    const { sha256Hex } = require('../src/main/sync/canonical.ts')
    const folder = new SyncFolder(cloud)
    await writeFile(join(dataDir, 'prompts', 'note.md'), 'local')
    await folder.writeRecord({ key: 'prompt:note', kind: 'prompt', payload: 'remote', hash: sha256Hex('remote'), deviceId: 'other', deviceName: 'other', modifiedAt: 1 })
    const conflict = (await service.sync()).conflicts[0]
    const copy = buildConflictCopy(conflict)
    const file = join(dataDir, 'prompts', copy.key.slice('prompt:'.length) + '.md')
    await writeFile(file, 'pre-existing-copy')
    assert.equal((await service.resolveConflict(conflict.id, 'both')).ok, false)
    assert.equal(await readFile(file, 'utf8'), 'pre-existing-copy')
    assert.equal(await readFile(join(dataDir, 'prompts', 'note.md'), 'utf8'), 'local')
    assert.equal((await folder.readRecords()).records.get('prompt:note').payload, 'remote')
    for (let i = 0; i < 3; i++) {
      const report = await service.sync()
      assert.equal(report.conflicts.length, 1)
      assert.deepEqual(report.pushed, i === 0 ? [copy.key] : [])
      assert.deepEqual(report.pulled, [])
    }
    assert.equal(await readFile(file, 'utf8'), 'pre-existing-copy')
  })
  await test('settings keep-both snapshots reject an existing destination', async () => {
    const dataDir = join(run, 'settings-copy')
    await mkdir(dataDir)
    const service = new SyncService({ dataDir, syncRoot: run })
    const conflict = { id: 'settings-fixture', remoteModifiedAt: 1, remotePayload: '{"theme":"dark"}' }
    await service.preserveSettingsSnapshot(conflict)
    await assert.rejects(service.preserveSettingsSnapshot({ ...conflict, remotePayload: '{"theme":"light"}' }))
    const files = readdirSync(dataDir)
    assert.equal(files.length, 1)
    assert.equal(await readFile(join(dataDir, files[0]), 'utf8'), conflict.remotePayload)
  })
  await test('session quote backup checksums and restore attachment path rebasing', async () => {
    const source = join(run, 'backup-source')
    const sessions = join(source, 'sessions')
    const yan = join(source, 'yan')
    const quote = join(yan, 'session-quotes', '20261029-fixture', 'quote.jsonl')
    await mkdir(sessions, { recursive: true })
    await mkdir(resolve(quote, '..'), { recursive: true })
    const body = '{"title":"fixture"}\n{"role":"user","text":"saved history"}\n'
    await writeFile(quote, body)
    await writeFile(join(sessions, 'fixture.jsonl'), JSON.stringify({ type: 'message', attachment: { path: quote } }) + '\n')
    const backup = await createDataBackup(run, sessions, yan)
    const { manifest } = await readDataBackup(backup.path)
    assert(manifest.files.some((entry) => entry.path === 'yan/session-quotes/20261029-fixture/quote.jsonl'))
    const restored = await restoreDataBackup(backup.path, run)
    const rebound = join(restored.path, 'pi-agent', 'yan', 'session-quotes', '20261029-fixture', 'quote.jsonl')
    assert.equal(await readFile(rebound, 'utf8'), body)
    const session = JSON.parse(await readFile(join(restored.path, 'pi-agent', 'sessions', 'fixture.jsonl'), 'utf8'))
    assert.equal(session.attachment.path, rebound)
  })
  for (const scenario of ['source-change', 'target-change', 'success']) {
    await test(`migration ${scenario}: content validation and retained backup`, async () => {
      const root = join(run, scenario)
      const home = join(root, 'home')
      const appdata = join(root, 'appdata')
      const from = join(home, '.pi', 'agent')
      const target = join(root, 'target')
      await mkdir(from, { recursive: true })
      await mkdir(join(appdata, 'yan-desktop'), { recursive: true })
      await writeFile(join(from, 'note.txt'), 'old!')
      await writeFile(join(from, 'future.txt'), 'mask')
      await utimes(join(from, 'future.txt'), new Date('2099-01-01'), new Date('2099-01-01'))
      await writeFile(join(appdata, 'yan-desktop', 'storage-move.json'), JSON.stringify({ target }))
      const file = resolve('src/main/storage-move.ts')
      const mod = new Module(file)
      mod.filename = file
      mod.paths = Module._nodeModulePaths(resolve('src/main'))
      const nativeRequire = mod.require.bind(mod)
      mod.require = (id) => id === 'node:os' ? { homedir: () => home } : id === './paths' ? { PI_AGENT_DIR: from } : nativeRequire(id)
      Module._extensions['.ts'](mod, file)
      const saved = { ...process.env }
      process.env.APPDATA = appdata
      delete process.env.PORTABLE_EXECUTABLE_DIR
      delete process.env.YAN_PI_DIR
      try {
        const result = await mod.exports.runPendingStorageMove((progress) => {
          if (progress.phase === 'verify' && scenario !== 'success') writeFileSync(join(scenario === 'source-change' ? from : target, 'note.txt'), 'new!')
          if (progress.phase === 'cleanup') {
            const name = readdirSync(resolve(from, '..')).find((entry) => entry.startsWith('agent.迁移前备份-'))
            writeFileSync(join(resolve(from, '..'), name, 'late.txt'), 'late writer')
          }
        })
        assert.equal(result.ok, scenario === 'success')
        if (scenario === 'success') {
          assert(result.leftover)
          assert.equal(await readFile(join(result.leftover, 'note.txt'), 'utf8'), 'old!')
          assert.equal(await readFile(join(result.leftover, 'late.txt'), 'utf8'), 'late writer')
        } else {
          assert.equal(await readFile(join(from, 'note.txt'), 'utf8'), scenario === 'source-change' ? 'new!' : 'old!')
          assert.equal(existsSync(target), false)
        }
      } finally {
        process.env = saved
      }
    })
  }
  await writeFile(join(run, 'result.json'), JSON.stringify({ passed: results.length, results }, null, 2))
  console.log(`PASS ${results.length} scenarios; artifacts: ${run}`)
} finally {
  if (previous) Module._extensions['.ts'] = previous
  else delete Module._extensions['.ts']
}
