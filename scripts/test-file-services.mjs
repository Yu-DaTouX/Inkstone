import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function tryLink(target, path, type) {
  try {
    await symlink(target, path, type)
    return true
  } catch {
    return false
  }
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-file-services-'))
  try {
    const gate = await compile('src/main/file-path-gate.ts', join(dir, 'gate.mjs'))
    const classify = await compile('src/main/file-preview-classify.ts', join(dir, 'classify.mjs'))
    const refs = await compile('src/main/file-refs.ts', join(dir, 'refs.mjs'))
    const files = await compile('src/main/files.ts', join(dir, 'files.mjs'))
    const unsaved = await compile('src/main/unsaved-files.ts', join(dir, 'unsaved.mjs'))

    assert.equal(gate.isWithin('C:/a/b', 'C:/a/b/c', 'win32'), true)
    assert.equal(gate.isWithin('C:/a/b', 'c:\\A\\B\\c', 'win32'), true)
    assert.equal(gate.isWithin('C:/a/b', 'C:/a/bc', 'win32'), false)
    assert.equal(gate.isStrictlyWithin('/a/b', '/a/b', 'linux'), false)
    assert.equal(gate.isStrictlyWithin('/a/b', '/a/b/c', 'linux'), true)
    assert.equal(gate.lexicalJoin('/root', '../x'), null)
    assert.equal(gate.lexicalJoin('/root', 'a\0b'), null)
    assert.equal(gate.lexicalJoin('/root', 'C:/x'), null)

    const root = join(dir, 'root')
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'sub', 'a.txt'), 'hello\n')
    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'secret')

    const ok = await gate.scopedPath(root, 'sub/a.txt')
    assert.equal(ok.ok, true)
    const missing = await gate.scopedPath(root, 'sub/new.txt')
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'missing')
    assert.equal(missing.creatable, true)
    const missingDeep = await gate.scopedPath(root, 'nope/new.txt')
    assert.equal(missingDeep.creatable, false)
    assert.equal((await gate.scopedPath(root, '../outside/secret.txt')).reason, 'outside_root')
    assert.equal((await gate.scopedPath(root, join(outside, 'secret.txt'))).reason, 'invalid')
    assert.equal((await gate.scopedPath(root, join(outside, 'secret.txt'), { allowAbsolute: true })).reason, 'outside_root')

    const utf8 = classify.decodeText(Buffer.from('中文 ok', 'utf8'))
    assert.equal(utf8.encoding, 'utf8')
    assert.equal(utf8.text, '中文 ok')
    const bom = classify.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x')]))
    assert.equal(bom.encoding, 'utf8-bom')
    assert.equal(bom.text, 'x')
    const utf16 = classify.decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]))
    assert.equal(utf16.encoding, 'utf16le')
    assert.equal(utf16.text, 'hi')
    const gbBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
    const gb = classify.decodeText(gbBytes)
    assert.equal(gb.encoding, 'gb18030')
    assert.equal(gb.text, '中文')
    assert.equal(classify.decodeText(Buffer.from([0x61, 0x00, 0x62])).issue, 'binary')
    const cut = Buffer.from('ab中', 'utf8').subarray(0, 4)
    assert.equal(classify.decodeText(cut, false).text, 'ab')
    assert.equal(classify.mediaOf('clip.MP4'), 'video')
    assert.equal(classify.mediaOf('song.flac'), 'audio')
    assert.equal(classify.mediaOf('doc.pdf'), 'pdf')
    assert.equal(classify.mediaOf('a.ts'), undefined)

    await writeFile(join(root, 'bin.txt'), Buffer.from([0x41, 0x00, 0x42]))
    await writeFile(join(root, 'gbk.txt'), gbBytes)
    await writeFile(join(root, 'movie.mp4'), Buffer.from([0, 1, 2]))
    const text = await refs.readPreview('sub/a.txt', root)
    assert.equal(text.ok, true)
    assert.equal(text.text, 'hello\n')
    assert.equal(text.encoding, 'utf8')
    assert.equal(text.issue, undefined)
    const created = await refs.readPreview('sub/new.md', root)
    assert.equal(created.ok, false)
    assert.equal(created.issue, 'missing')
    assert.equal(created.creatable, true)
    const escaped = await refs.readPreview('../outside/secret.txt', root)
    assert.equal(escaped.issue, 'outside_root')
    const absoluteOutside = await refs.readPreview(join(outside, 'secret.txt'), root)
    assert.equal(absoluteOutside.ok, true)
    assert.equal(absoluteOutside.outsideRoot, true)
    const binary = await refs.readPreview('bin.txt', root)
    assert.equal(binary.issue, 'binary')
    assert.equal(binary.kind, 'binary')
    assert.equal(binary.text, undefined)
    const gbPreview = await refs.readPreview('gbk.txt', root)
    assert.equal(gbPreview.encoding, 'gb18030')
    assert.equal(gbPreview.text, '中文')
    const movie = await refs.readPreview('movie.mp4', root)
    assert.equal(movie.media, 'video')
    assert.equal(movie.issue, 'media')
    const folder = await refs.readPreview('sub', root)
    assert.equal(folder.issue, 'directory')

    assert.equal(files.classifyLink('/r', '/r/a', null), 'dangling')
    assert.equal(files.classifyLink('/r', '/r/a', '/elsewhere'), 'external')
    assert.equal(files.classifyLink('/r', '/r/a/b', '/r/a'), 'cycle')
    assert.equal(files.classifyLink('/r', '/r/a', '/r/b'), 'ok')

    const linked = await tryLink(join(root, 'sub'), join(root, 'sub-link'), 'junction')
    const externalLinked = await tryLink(outside, join(root, 'out-link'), 'junction')
    const loopLinked = await tryLink(root, join(root, 'sub', 'loop'), 'junction')
    const listing = await files.listDir(root, '', true)
    const byName = new Map(listing.entries.map((entry) => [entry.name, entry]))
    if (linked) {
      assert.equal(byName.get('sub-link')?.link?.state, 'ok')
      assert.equal(byName.get('sub-link')?.dir, true)
      const through = await files.listDir(root, 'sub-link', true)
      assert.equal(through.status, 'ok')
      assert.ok(through.entries.some((entry) => entry.name === 'a.txt'))
    }
    if (externalLinked) {
      assert.equal(byName.get('out-link')?.link?.state, 'external')
      assert.equal(byName.get('out-link')?.dir, false)
      assert.equal((await files.listDir(root, 'out-link', true)).status, 'invalid')
    }
    if (loopLinked) {
      const subListing = await files.listDir(root, 'sub', true)
      const loop = subListing.entries.find((entry) => entry.name === 'loop')
      assert.equal(loop?.link?.state, 'cycle')
      assert.equal(loop?.dir, false)
    }
    assert.equal(byName.get('sub')?.link, undefined)

    const registry = new unsaved.UnsavedFilesRegistry()
    assert.equal(registry.report(1, ['C:/a.txt', 'C:/a.txt', 7, '']), 1)
    assert.equal(registry.report(2, ['C:/a.txt', 'C:/b.txt']), 2)
    assert.equal(registry.count(), 2)
    registry.forget(2)
    assert.equal(registry.count(), 1)
    assert.equal(registry.report(1, []), 0)
    assert.equal(registry.report(3, 'nope'), 0)

    console.log(`test-file-services: 全部通过${linked && externalLinked && loopLinked ? '' : '（部分符号链接用例因系统限制跳过）'}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
