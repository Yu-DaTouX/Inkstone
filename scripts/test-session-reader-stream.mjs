import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rename, appendFile, rm, stat, utimes } from 'node:fs/promises'
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
  await build({ stdin: { contents: "export { readSessionMessages, clearSessionReadCache } from './src/main/session-reader'; export { readChainMessages } from './src/main/session-history'; export { SessionChainStore } from './src/main/session-chain-service'", resolveDir: process.cwd(), sourcefile: 'reader-fixture.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: moduleFile })
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
  const repeated = await readSessionMessages(file)
  assert.equal(opens, openAfter, 'unchanged file is served from the snapshot cache without opening')
  assert.equal(repeated, shared[0], 'cache hit returns the same frozen snapshot')
  assert.throws(() => { repeated.messages[0].text = 'changed' }, TypeError)

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
  await writeFile(file, head('retry') + msg('retry', '待替换'))
  afterRead = async ({ first, handle }) => { if (first) { replacements++; const replacement = join(dir, 'replacement'); await writeFile(replacement, head('r' + replacements) + msg('r', '再次替换')); await replaceWhileOpen(handle, replacement) } }
  assert.equal(await readSessionMessages(file), null)
  assert.equal(replacements, 2, 'at most one retry')
  afterRead = null
  assert.equal((await readSessionMessages(file)).sessionId, 'r2', 'failure clears the flight')

  afterRead = () => { throw new Error('synthetic read failure') }
  await appendFile(file, msg('bump', '换一个文件版本再验错'))
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

  const versionFile = join(dir, 'version.jsonl')
  await writeFile(versionFile, head('v1') + msg('a', '第一版'))
  assert.equal((await readSessionMessages(versionFile)).sessionId, 'v1')
  let versionOpens = opens
  assert.equal((await readSessionMessages(versionFile)).sessionId, 'v1')
  assert.equal(opens, versionOpens, 'unchanged file stays cached')
  await appendFile(versionFile, msg('b', '追加后'))
  const appended = await readSessionMessages(versionFile)
  assert.equal(opens, versionOpens + 1, 'append is reread')
  assert.equal(appended.total, 2); assert.equal(appended.messages[1].text, '追加后')

  const sameSizeFile = join(dir, 'same-size.jsonl')
  const beforeSwap = head('same1') + msg('a', 'AAAA')
  const afterSwap = head('same2') + msg('a', 'BBBB')
  assert.equal(Buffer.byteLength(beforeSwap), Buffer.byteLength(afterSwap), 'fixture keeps the byte length')
  await writeFile(sameSizeFile, beforeSwap)
  assert.equal((await readSessionMessages(sameSizeFile)).sessionId, 'same1')
  let sameSizeOpens = opens
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(sameSizeFile, afterSwap)
  const swapped = await readSessionMessages(sameSizeFile)
  assert.equal(opens, sameSizeOpens + 1, 'same-size replacement is reread')
  assert.equal(swapped.sessionId, 'same2'); assert.equal(swapped.messages[0].text, 'BBBB')

  const shrinkFile = join(dir, 'shrink.jsonl')
  await writeFile(shrinkFile, head('big') + msg('a', 'x'.repeat(4000)) + msg('b', 'y'.repeat(4000)))
  assert.equal((await readSessionMessages(shrinkFile)).total, 2)
  let shrinkOpens = opens
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(shrinkFile, head('small') + msg('a', '短'))
  const shrunk = await readSessionMessages(shrinkFile)
  assert.equal(opens, shrinkOpens + 1, 'truncation is reread')
  assert.equal(shrunk.sessionId, 'small'); assert.equal(shrunk.total, 1); assert.equal(shrunk.messages[0].text, '短')

  const localizedFile = join(dir, 'localized.jsonl')
  await writeFile(localizedFile, head('pic') + line({ type: 'message', id: 'img', message: { role: 'user', content: [{ type: 'text', text: '图' }, { type: 'image', mimeType: 'image/png', data: 'A'.repeat(80000) }] } }))
  const localizeA = (mimeType, data) => `a:${mimeType}:${data.length}`
  const localizeB = (mimeType, data) => `b:${mimeType}:${data.length}`
  const firstA = await readSessionMessages(localizedFile, { localizeImage: localizeA })
  assert.equal(firstA.messages[0].images[0].url, 'a:image/png:80000')
  let localizeOpens = opens
  assert.equal(await readSessionMessages(localizedFile, { localizeImage: localizeA }), firstA, 'same localizer hits the snapshot')
  assert.equal(opens, localizeOpens, 'same localizer does not reopen the file')
  const firstB = await readSessionMessages(localizedFile, { localizeImage: localizeB })
  assert.equal(opens, localizeOpens + 1, 'different localizer identity is not served from the cache')
  assert.equal(firstB.messages[0].images[0].url, 'b:image/png:80000')
  assert.notEqual(firstB, firstA)
  assert.equal((await readSessionMessages(localizedFile, { localizeImage: localizeA })).messages[0].images[0].url, 'a:image/png:80000')
  assert.equal(opens, localizeOpens + 1, 'first localizer snapshot survived the second one')

  const small = []
  for (let i = 1; i <= 7; i++) {
    const file7 = join(dir, `cap-${i}.jsonl`)
    await writeFile(file7, head(`cap${i}`) + msg('a', 'c'.repeat(1024 * 1024)))
    small.push(file7)
  }
  for (const file7 of small) await readSessionMessages(file7)
  const capOpens = opens
  const evicted = await readSessionMessages(small[0])
  assert.equal(opens, capOpens + 1, 'oldest snapshot is evicted once more than six files are cached')
  assert.equal(evicted.sessionId, 'cap1')
  const retained = await readSessionMessages(small[6])
  assert.equal(opens, capOpens + 1, 'most recently used snapshot is retained')
  assert.equal(retained.sessionId, 'cap7')

  const heavy = []
  for (let i = 1; i <= 2; i++) {
    const file25 = join(dir, `heavy-${i}.jsonl`)
    await writeFile(file25, head(`heavy${i}`) + msg('a', 'h'.repeat(25 * 1024 * 1024)))
    heavy.push(file25)
  }
  assert.equal((await readSessionMessages(heavy[0])).sessionId, 'heavy1')
  const heavyOpens = opens
  assert.equal((await readSessionMessages(heavy[0])).sessionId, 'heavy1')
  assert.equal(opens, heavyOpens, 'one 25MiB snapshot fits in the 48MiB budget')
  assert.equal((await readSessionMessages(heavy[1])).sessionId, 'heavy2')
  assert.equal(opens, heavyOpens + 1)
  const heavyHits = opens
  assert.equal((await readSessionMessages(heavy[1])).sessionId, 'heavy2')
  assert.equal(opens, heavyHits, 'newest heavy snapshot is retained')
  assert.equal((await readSessionMessages(heavy[0])).sessionId, 'heavy1')
  assert.equal(opens, heavyHits + 1, 'two 25MiB snapshots cannot both stay under the 48MiB budget')

  mod.clearSessionReadCache()
  const lru = []
  for (let i = 1; i <= 7; i++) {
    const lruFile = join(dir, `lru-${i}.jsonl`)
    await writeFile(lruFile, head(`lru${i}`) + msg('a', 'l'.repeat(1024 * 1024)))
    lru.push(lruFile)
  }
  for (const lruFile of lru.slice(0, 6)) await readSessionMessages(lruFile)
  const lruHits = opens
  assert.equal((await readSessionMessages(lru[0])).sessionId, 'lru1')
  assert.equal(opens, lruHits, 'cache hit does not reopen the file')
  assert.equal((await readSessionMessages(lru[6])).sessionId, 'lru7')
  assert.equal(opens, lruHits + 1, 'a seventh snapshot triggers eviction')
  const afterInsert = opens
  assert.equal((await readSessionMessages(lru[0])).sessionId, 'lru1')
  assert.equal(opens, afterInsert, 'hit refreshes recency so the oldest-touched file survives')
  assert.equal((await readSessionMessages(lru[1])).sessionId, 'lru2')
  assert.equal(opens, afterInsert + 1, 'the next-oldest snapshot is the eviction victim')

  mod.clearSessionReadCache()
  const inoFile = join(dir, 'ino.jsonl')
  const inoBefore = head('ino1') + msg('a', 'AAAA')
  const inoAfter = head('ino2') + msg('a', 'BBBB')
  await writeFile(inoFile, inoBefore)
  const inoStat = await stat(inoFile)
  await readSessionMessages(inoFile)
  const inoReplacement = join(dir, 'ino-replacement.jsonl')
  await writeFile(inoReplacement, inoAfter)
  await utimes(inoReplacement, inoStat.atime, inoStat.mtime)
  await rename(inoReplacement, inoFile)
  const inoRead = await readSessionMessages(inoFile)
  assert.equal(inoRead.sessionId, 'ino2', 'inode change alone invalidates the snapshot')

  mod.clearSessionReadCache()
  const sizeFile = join(dir, 'size.jsonl')
  const sizeBefore = head('size1') + msg('a', 'AAA')
  const sizeAfter = head('size1') + msg('a', 'AAAA')
  await writeFile(sizeFile, sizeBefore)
  const sizeStat = await stat(sizeFile)
  await readSessionMessages(sizeFile)
  await writeFile(sizeFile, sizeAfter)
  await utimes(sizeFile, sizeStat.atime, sizeStat.mtime)
  const sizeRead = await readSessionMessages(sizeFile)
  assert.equal(sizeRead.messages[0].text, 'AAAA', 'size change alone invalidates the snapshot')
  mod.clearSessionReadCache()

  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const ttlScript = fileURLToPath(new URL('./test-session-reader-ttl.mjs', import.meta.url))
  const ttlChild = spawnSync(process.execPath, [ttlScript], { cwd: process.cwd(), stdio: 'inherit' })
  assert.equal(ttlChild.status, 0, 'snapshot TTL bounds version-tuple collisions')

  assert.equal(opens, closes, 'all opened handles closed')
  fsp.open = originalOpen; syncBuiltinESMExports()
  await writeFile(file, head('isolated') + msg('u', '原内容'))
  const [rawSnapshot, hydrated] = await Promise.all([readSessionMessages(file), mod.readChainMessages(file, null, async (_file, messages) => { messages[0].text = '单次hydrate'; return messages })])
  assert.equal(rawSnapshot.messages[0].text, '原内容')
  assert.equal(hydrated.messages[0].text, '单次hydrate')
  console.log('session-reader-stream: bounded traversal, five-way sharing, immutable isolation, version-invalidated snapshot cache, append/same-size/truncate/localizer/eviction/LRU/ino/size/TTL, retry/error cleanup and UTF8/BOM/CRLF cases passed')
} finally {
  fsp.open = originalOpen; syncBuiltinESMExports()
  await rm(dir, { recursive: true, force: true })
}
