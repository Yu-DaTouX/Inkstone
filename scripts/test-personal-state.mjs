import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-personal-state-'))
let checks = 0
try {
  await build({ entryPoints: ['src/main/data-backup.ts'], outfile: join(root, 'backup.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { createDataBackup, verifyDataBackup } = await import(pathToFileURL(join(root, 'backup.mjs')).href)
  const yan = join(root, 'yan')
  const stateDir = join(yan, 'interaction-state')
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, 'a'.repeat(64) + '.json'), '{"version":1,"values":{}}')
  await writeFile(join(stateDir, 'b'.repeat(64) + '.json'), '{"version":1,"values":{}}')

  const sessions = join(root, 'sessions')
  const dest = join(root, 'backups')
  await mkdir(sessions)
  await mkdir(dest)
  await writeFile(join(sessions, 'one.jsonl'), '{"id":"A"}\n')
  await writeFile(join(yan, 'desktop.json'), '{"theme":"dark"}')
  await writeFile(join(yan, 'auth.json'), '{"token":"not-backed-up"}')
  const backup = await createDataBackup(dest, sessions, yan)
  assert.equal(backup.files, 4); checks++
  const manifestPath = join(backup.path, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.ok(manifest.files.every((f) => !f.path.includes('auth'))); checks++
  assert.equal(manifest.files.find((f) => f.path.includes('one.jsonl')).sha256.length, 64); checks++
  await verifyDataBackup(backup.path); checks++
  await assert.rejects(createDataBackup(yan, sessions, yan)); checks++
  await writeFile(join(backup.path, 'sessions', 'one.jsonl'), 'tampered')
  await assert.rejects(verifyDataBackup(backup.path)); checks++
  manifest.files[0].path = '../outside.jsonl'
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(verifyDataBackup(backup.path)); checks++
  console.log(`personal-state: ${checks} focused checks passed`)
} finally {
  await rm(root, { recursive: true, force: true })
}
