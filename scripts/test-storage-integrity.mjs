import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
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
  const { createDataBackup, readDataBackup } = require('../src/main/data-backup.ts')
  const { restoreDataBackup } = require('../src/main/data-restore.ts')
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
