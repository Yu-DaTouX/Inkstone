import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rename, appendFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const dir = await mkdtemp(join(tmpdir(), 'yan-reader-stream-'))
const fsp = createRequire(import.meta.url)('node:fs/promises')
const originalOpen = fsp.open
let opens = 0, reads = 0, closes = 0, afterRead
const line = x => JSON.stringify(x) + '\n'
const head = id => line({ type: 'session', version: 3, id, cwd: 'C:/synthetic' })
const msg = (id, text) => line({ type: 'message', id, message: { role: 'user', content: [{ type: 'text', text }] } })
try {
  const moduleFile = join(dir, 'reader.mjs')
  await build({ stdin: { contents: "export { readSessionMessages } from './src/main/session-reader'; export { readChainMessages } from './src/main/session-history'; export { SessionChainStore } from './src/main/session-chain-service'", resolveDir: process.cwd(), sourcefile: 'reader-fixture.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: moduleFile })
  fsp.open = async (...args) => {
    const handle = await originalOpen(...args); opens++
    const read = handle.read.bind(handle), close = handle.close.bind(handle)
    let first = true, closed = false
    handle.read = async (...args) => { reads++; const result = await read(...args); if (afterRead) await afterRead({ first, handle }); first = false; return result }
    handle.close = async () => { if (!closed) { closed = true; closes++ } return close() }
    return handle
  }
  syncBuiltinESMExports()
  const mod = await import(pathToFileURL(moduleFile))
  const { readSessionMessages } = mod
  const file = join(dir, 'session.jsonl')
  const raw = head('shared') + msg('system-like', 'x'.repeat(65000) + '中文🙂'.repeat(1000)) + msg('tail', '尾部')
  await writeFile(file, raw)
  const baseOpens = opens, baseReads = reads, baseCloses = closes
  const shared = await Promise.all(Array.from({ length: 5 }, () => readSessionMessages(file)))
  assert.equal(opens - baseOpens, 1, 'five reads share one file handle')
  assert.equal(reads - baseReads, Math.ceil(Buffer.byteLength(raw) / 65536), 'one bounded traversal')
  assert.equal(closes - baseCloses, 1)
  for (const result of shared) assert.equal(result, shared[0])
  assert.equal(shared[0].messages[1].text, '尾部')
  assert.throws(() => { shared[0].messages[0].text = 'changed' }, TypeError)
  const copy = structuredClone(shared[0]); copy.messages[0].text = 'changed'
  assert.notEqual(shared[0].messages[0].text, copy.messages[0].text)
  const openAfter = opens
  await readSessionMessages(file)
  assert.equal(opens, openAfter + 1, 'completed reads are not cached')

  await writeFile(file, head('grow') + msg('complete', '完整') + msg('partial', '有效JSON但未终止行').trimEnd())
  const initialBytes = (await readFile(file)).length
  let changed = false
  afterRead = async ({ first }) => { if (first && !changed) { changed = true; await appendFile(file, '\n' + msg('new', '新增')) } }
  const growth = await readSessionMessages(file)
  assert.equal(growth.total, 1); assert.equal(growth.bytes, initialBytes)
  afterRead = null
  assert.equal((await readSessionMessages(file)).total, 3, 'new version is reread')

  await writeFile(file, head('old') + msg('old', '旧文件'))
  changed = false
  async function replaceWhileOpen(handle, replacement) {
    try { await rename(replacement, file) }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      // Windows may deny replacing an open destination. Invalidate that handle
      // to exercise the bounded read-error/replacement retry rather than fake inode metadata.
      await handle.close(); await rename(replacement, file)
    }
  }
  afterRead = async ({ first, handle }) => { if (first && !changed) { changed = true; const replacement = join(dir, 'replacement'); await writeFile(replacement, head('replacement') + msg('new', '新文件')); await replaceWhileOpen(handle, replacement) } }
  const replaced = await readSessionMessages(file)
  assert.equal(replaced.sessionId, 'replacement'); assert.equal(replaced.messages[0].text, '新文件')

  afterRead = null
  await writeFile(file, head('long') + msg('large', 'a'.repeat(300000)))
  changed = false
  afterRead = async ({ first }) => { if (first && !changed) { changed = true; await writeFile(file, head('short') + msg('short', '缩短')); await utimes(file, new Date(), new Date(Date.now() + 1000)) } }
  const shortened = await readSessionMessages(file)
  assert.equal(shortened.sessionId, 'short'); assert.equal(shortened.total, 1)

  let replacements = 0
  afterRead = async ({ first, handle }) => { if (first) { replacements++; const replacement = join(dir, 'replacement'); await writeFile(replacement, head('r' + replacements) + msg('r', '再次替换')); await replaceWhileOpen(handle, replacement) } }
  assert.equal(await readSessionMessages(file), null)
  assert.equal(replacements, 2, 'at most one retry')
  afterRead = null
  assert.equal((await readSessionMessages(file)).sessionId, 'r2', 'failure clears the flight')

  afterRead = () => { throw new Error('synthetic read failure') }
  const beforeClose = closes
  assert.equal(await readSessionMessages(file), null)
  assert.equal(closes, beforeClose + 2, 'both bounded error attempts close handles')
  afterRead = null
  assert.ok(await readSessionMessages(file))

  await writeFile(file, '\uFEFF' + head('bom') + msg('u', 'BOM后').replaceAll('\n', '\r\n') + '{broken')
  const malformed = await readSessionMessages(file)
  assert.equal(malformed.sessionId, undefined); assert.equal(malformed.total, 1)
  assert.equal(malformed.messages[0].entryId, 'u')
  assert.equal(await readSessionMessages(join(dir, 'missing')), null)
  assert.equal(opens, closes, 'all opened handles closed')
  fsp.open = originalOpen; syncBuiltinESMExports()
  await writeFile(file, head('isolated') + msg('u', '原内容'))
  const [rawSnapshot, hydrated] = await Promise.all([readSessionMessages(file), mod.readChainMessages(file, null, async (_file, messages) => { messages[0].text = '单次hydrate'; return messages })])
  assert.equal(rawSnapshot.messages[0].text, '原内容')
  assert.equal(hydrated.messages[0].text, '单次hydrate')
  console.log('session-reader-stream: bounded traversal, five-way sharing, immutable isolation, append/replace/truncate/retry/error cleanup and UTF8/BOM/CRLF cases passed')
} finally {
  fsp.open = originalOpen; syncBuiltinESMExports()
  await rm(dir, { recursive: true, force: true })
}
