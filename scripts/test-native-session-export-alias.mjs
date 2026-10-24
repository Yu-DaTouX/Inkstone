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
  const { exportSessionJsonl, importSessionJsonl } = await import(pathToFileURL(output).href)
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
  const rejectAlias = async (target, label) => {
    const result = await exportSessionJsonl({ sourcePath: source, outputPath: target, overwrite: true })
    verify(!result.ok && result.code === 'invalid_path', `${label}: rejected`)
    verify(fs.readFileSync(source, 'utf8') === original, `${label}: source unchanged`)
  }
  await rejectAlias(source, 'same path')
  const hard = join(work, 'hard.jsonl')
  fs.linkSync(source, hard)
  await rejectAlias(hard, 'hard link')
  verify(fs.readFileSync(hard, 'utf8') === original, 'hard link contents unchanged')
  const junction = join(work, 'junction')
  fs.symlinkSync(dir, junction, process.platform === 'win32' ? 'junction' : 'dir')
  await rejectAlias(join(junction, 'session.jsonl'), 'directory alias')
  const caseAlias = join(dir, 'SESSION.JSONL')
  if (fs.existsSync(caseAlias)) await rejectAlias(caseAlias, 'case alias')
  else console.log('case-alias test skipped: case-sensitive filesystem')

  const branch = join(work, 'branch.jsonl')
  verify((await exportSessionJsonl({ sourcePath: source, outputPath: branch })).ok, 'new branch export succeeds')
  verify(!fs.readFileSync(branch, 'utf8').includes('abandoned'), 'branch semantics preserved')
  const before = fs.readFileSync(branch, 'utf8')
  verify(!(await exportSessionJsonl({ sourcePath: source, outputPath: branch })).ok, 'existing output needs permission')
  verify(fs.readFileSync(branch, 'utf8') === before, 'existing output unchanged on refusal')
  fs.writeFileSync(branch, 'old tail '.repeat(2000))
  verify((await exportSessionJsonl({ sourcePath: source, outputPath: branch, overwrite: true, scope: 'full' })).ok, 'full overwrite succeeds')
  verify(fs.readFileSync(branch, 'utf8') === original, 'full overwrite truncates only approved output')

  const race = join(work, 'race.jsonl')
  const open = fs.promises.open
  fs.promises.open = async (file, ...args) => {
    if (String(file) === race && !fs.existsSync(race)) fs.linkSync(source, race)
    return open(file, ...args)
  }
  syncBuiltinESMExports()
  try { await rejectAlias(race, 'post-check alias race') }
  finally { fs.promises.open = open; syncBuiltinESMExports() }
  verify(fs.readFileSync(source, 'utf8') === original, 'all original branches retained')

  const missingLeaf = join(work, 'missing-leaf.jsonl')
  const missing = await exportSessionJsonl({ sourcePath: source, outputPath: missingLeaf, leafId: 'nope' })
  verify(!missing.ok && missing.code === 'invalid_path', 'unknown leaf rejected')
  verify(!String(missing.error ?? '').includes('写入导出文件失败'), 'unknown leaf reports the leaf, not a write failure')
  verify(!fs.existsSync(missingLeaf), 'unknown leaf writes no file')
  verify((await exportSessionJsonl({ sourcePath: source, outputPath: join(work, 'count.jsonl') })).entryCount === 2, 'entryCount matches the exported branch')

  const importDir = join(work, 'imports')
  const stored = await importSessionJsonl({ sourcePath: source, sessionDir: importDir })
  verify(stored.ok, 'import stores the session file')
  const occupant = join(importDir, 'session-1.jsonl')
  fs.writeFileSync(occupant, 'occupied\n')
  const access = fs.promises.access
  let hidden = 0
  fs.promises.access = async (file, ...args) => {
    if (hidden < 1 && String(file) === occupant) {
      hidden++
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
    }
    return access(file, ...args)
  }
  syncBuiltinESMExports()
  let racedImport
  try { racedImport = await importSessionJsonl({ sourcePath: source, sessionDir: importDir }) }
  finally { fs.promises.access = access; syncBuiltinESMExports() }
  verify(racedImport.ok, 'import retries when the target name is taken between check and write')
  verify(racedImport.destinationPath !== occupant, 'import does not overwrite the raced file')
  verify(fs.readFileSync(occupant, 'utf8') === 'occupied\n', 'raced file keeps its contents')
  console.log(`Session export aliases: ${checks} passed`)
} finally {
  await rm(work, { recursive: true, force: true })
}
