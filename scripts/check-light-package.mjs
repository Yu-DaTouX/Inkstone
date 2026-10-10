/** Verify the review package matches the tested build and selected pi generation. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, stat, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const root = resolve(process.env.YAN_PACKAGED_DIR || 'release/win-unpacked')
const archive = join(root, 'resources/app.asar')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
for (const file of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
  assert.equal(hash(asar.extractFile(archive, join(...file.split('/')))), hash(await readFile(file)), `Packaged build drift: ${file}`)
}
for (const asset of await readdir('out/renderer/assets')) {
  const file = `out/renderer/assets/${asset}`
  assert.equal(hash(asar.extractFile(archive, join(...file.split('/')))), hash(await readFile(file)), `Packaged renderer asset drift: ${asset}`)
}
for (const [source, target, files] of [
  ['resources/pi-extensions', 'resources/yan-thin', ['danger-guard.js']],
  ['integrations/hermes-inkstone', 'resources/integrations/hermes-inkstone', ['plugin.yaml','__init__.py','client.py','approvals.py','connect.py','README.md']]
]) {
  for (const file of files) assert.equal(hash(await readFile(join(root,target,file))), hash(await readFile(join(source,file))), `Packaged resource drift: ${file}`)
}
const runtime = join(root, 'resources/pi-runtime')
const selected = JSON.parse(await readFile('resources/pi-runtime/current.json', 'utf8'))
assert.equal(JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).version, selected.version)
for (const file of ['dist/bundle/cli.js', 'dist/bundle/chunks/codemode-worker.js', 'node_modules/quickjs-wasi/quickjs.wasm']) {
  assert((await stat(join(runtime, file))).size > 0, file)
}
assert(!(await readdir(root)).includes('砚数据'), 'Review package must not contain user data')
console.log(`PASS: packaged main/preload/HTML match current build; pi ${selected.version}, CLI/worker/WASM present; no portable user-data directory`)
