import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

process.env.YAN_HISTORY_CACHE_TTL_MS = '0'
const dir = await mkdtemp(join(tmpdir(), 'yan-reader-ttl-'))
const moduleFile = join(dir, 'reader.mjs')
const line = (x) => JSON.stringify(x) + '\n'
const head = (id) => line({ type: 'session', version: 3, id, cwd: 'C:/synthetic' })
const msg = (text) => line({ type: 'message', id: 'a', message: { role: 'user', content: [{ type: 'text', text }] } })
try {
  await build({
    stdin: {
      contents: "export { readSessionMessages } from './src/main/session-reader'",
      resolveDir: process.cwd(),
      sourcefile: 'reader-ttl.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: moduleFile
  })
  const { readSessionMessages } = await import(pathToFileURL(moduleFile).href)
  const file = join(dir, 'session.jsonl')
  const before = head('same1') + msg('AAAA')
  const after = head('same2') + msg('BBBB')
  assert.equal(Buffer.byteLength(before), Buffer.byteLength(after), 'fixture keeps the byte length')
  await writeFile(file, before)
  assert.equal((await readSessionMessages(file)).sessionId, 'same1')
  const info = await stat(file)
  await writeFile(file, after)
  await utimes(file, info.atime, info.mtime)
  assert.equal((await readSessionMessages(file)).sessionId, 'same2', 'TTL expiry rereads a same-size rewrite with restored mtime')
  console.log('session-reader-ttl: snapshot TTL bounds version-tuple collisions')
} finally {
  await rm(dir, { recursive: true, force: true })
}
