/** Session export must never truncate its source through path aliases. No Electron or model. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'inkstone-export-alias-'))
let checks = 0
const verify = (value, label) => { assert.ok(value, label); checks++ }
try {
  const output = join(work, 'io.mjs')
  await build({ entryPoints: ['src/main/native-session-io.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'isolated-paths', setup(b) { b.onResolve({ filter: /^\.\/paths$/ }, () => ({ path: 'paths', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const PI_AGENT_DIR = ${JSON.stringify(work)}`, loader: 'js' })) } }] })
  const { exportSessionJsonl } = await import(pathToFileURL(output).href)
  const dir = join(work, 'source')
  await mkdir(dir)
  const source = join(dir, 'session.jsonl')
  const lines = [
    { type: 'session', version: 3, id: 'fixture', cwd: dir },
    { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'root' } },
    { type: 'message', id: 'abandoned', parentId: 'root', message: { role: 'assistant', content: 'abandoned' } },
    { type: 'message', id: 'active', parentId: 'root', message: { role: 'assistant', content: 'active' } }
  ]
  const original = lines.map(x => JSON.stringify(x)).join('\n') + '\n'
  fs.writeFileSync(source, original)
  const rejectAlias = (target, label) => {
    const result = exportSessionJsonl({ sourcePath: source, outputPath: target, overwrite: true })
    verify(!result.ok && result.code === 'invalid_path', `${label}: rejected`)
    verify(fs.readFileSync(source, 'utf8') === original, `${label}: source unchanged`)
  }
  rejectAlias(source, 'same path')
  const hard = join(work, 'hard.jsonl')
  fs.linkSync(source, hard)
  rejectAlias(hard, 'hard link')
  verify(fs.readFileSync(hard, 'utf8') === original, 'hard link contents unchanged')
  const junction = join(work, 'junction')
  fs.symlinkSync(dir, junction, process.platform === 'win32' ? 'junction' : 'dir')
  rejectAlias(join(junction, 'session.jsonl'), 'directory alias')
  const caseAlias = join(dir, 'SESSION.JSONL')
  if (fs.existsSync(caseAlias)) rejectAlias(caseAlias, 'case alias')
  else console.log('case-alias test skipped: case-sensitive filesystem')

  const branch = join(work, 'branch.jsonl')
  verify(exportSessionJsonl({ sourcePath: source, outputPath: branch }).ok, 'new branch export succeeds')
  verify(!fs.readFileSync(branch, 'utf8').includes('abandoned'), 'branch semantics preserved')
  const before = fs.readFileSync(branch, 'utf8')
  verify(!exportSessionJsonl({ sourcePath: source, outputPath: branch }).ok, 'existing output needs permission')
  verify(fs.readFileSync(branch, 'utf8') === before, 'existing output unchanged on refusal')
  fs.writeFileSync(branch, 'old tail '.repeat(2000))
  verify(exportSessionJsonl({ sourcePath: source, outputPath: branch, overwrite: true, scope: 'full' }).ok, 'full overwrite succeeds')
  verify(fs.readFileSync(branch, 'utf8') === original, 'full overwrite truncates only approved output')

  // Replace a previously absent output with a hard link immediately before open.
  const race = join(work, 'race.jsonl')
  const open = fs.openSync
  fs.openSync = (file, ...args) => {
    if (String(file) === race && !fs.existsSync(race)) fs.linkSync(source, race)
    return open(file, ...args)
  }
  syncBuiltinESMExports()
  try { rejectAlias(race, 'post-check alias race') }
  finally { fs.openSync = open; syncBuiltinESMExports() }
  verify(fs.readFileSync(source, 'utf8') === original, 'all original branches retained')
  console.log(`Session export aliases: ${checks} passed`)
} finally {
  await rm(work, { recursive: true, force: true })
}
