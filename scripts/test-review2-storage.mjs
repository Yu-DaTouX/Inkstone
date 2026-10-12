import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-review2-storage-'))
try {
  const outfile = join(dir, 'library-parser.mjs')
  const serviceFile = join(dir, 'library-service.mjs')
  const spaceFile = join(dir, 'space-store.mjs')
  const compileOnly = ['src/main/project-memory-store.ts', 'src/main/personal-memory.ts', 'src/main/learning-export.ts']
  for (const [index, entry] of compileOnly.entries()) {
    await build({ entryPoints: [entry], outfile: join(dir, `compile-${index}.mjs`), bundle: true, platform: 'node', format: 'esm' })
  }
  await build({ entryPoints: ['src/main/library-parser.ts'], outfile, bundle: true, platform: 'node', format: 'esm' })
  await build({ entryPoints: ['src/main/library-service.ts'], outfile: serviceFile, bundle: true, platform: 'node', format: 'esm' })
  await build({ entryPoints: ['src/main/space-store.ts'], outfile: spaceFile, bundle: true, platform: 'node', format: 'esm' })
  const parser = await import(pathToFileURL(outfile).href)
  const { LibraryService } = await import(pathToFileURL(serviceFile).href)
  const spaces = await import(pathToFileURL(spaceFile).href)
  const entities = parser.extractHtmlText('<p>&constructor; &#x110000; &#65;</p>')
  assert.match(entities.text, /&constructor;/)
  assert.match(entities.text, /&#x110000;/)
  assert.match(entities.text, /A/)
  const pdfText = Buffer.from('%PDF-1.4\n1 0 obj << /Length 55 >>\nstream\nBT (First stream contains enough readable text) Tj ET\nendstream\n2 0 obj << /Length 56 >>\nstream\nBT (Second stream also contains enough readable text) Tj ET\nendstream\n%%EOF', 'latin1')
  const pdf = parser.parsePdfBuffer(pdfText)
  assert.equal(pdf.status, 'ok')
  assert.match(pdf.text, /First stream contains enough readable text/)
  assert.match(pdf.text, /Second stream also contains enough readable text/)
  const badFlate = parser.parsePdfBuffer(Buffer.from('%PDF-1.4\n<< /Filter /FlateDecode >>\nstream\nnot-deflate\nendstream\n%%EOF', 'latin1'))
  assert.equal(badFlate.status, 'failed')
  assert.match(badFlate.note, /解压失败/)
  assert.match(parser.extractPdfText('BT (outer (nested) text) Tj ET'), /outer \(nested\) text/)
  assert.match(parser.decodePdfString('a\\(b\\)c'), /a\(b\)c/)
  const oversizedText = join(dir, 'large.txt')
  const { writeFile: writeTemp, truncate } = await import('node:fs/promises')
  await writeTemp(oversizedText, 'x')
  await truncate(oversizedText, parser.MAX_TEXT_BYTES + 64)
  const bounded = await parser.parseLibraryFile(oversizedText, 'file')
  assert.equal(bounded.status, 'ok')
  assert.ok(Buffer.byteLength(bounded.text) <= parser.MAX_TEXT_BYTES)
  const tooLargePdf = join(dir, 'large.pdf')
  await writeTemp(tooLargePdf, '%PDF-1.4')
  await truncate(tooLargePdf, parser.MAX_PDF_BYTES + 1)
  assert.equal((await parser.parseLibraryFile(tooLargePdf, 'file')).status, 'unsupported')
  const libraryRoot = join(dir, 'library')
  const sourceFile = join(dir, 'source.txt')
  await writeTemp(sourceFile, 'A source with sufficiently long readable content.')
  const service = new LibraryService({ root: libraryRoot })
  const imported = await service.import({ kind: 'file', ref: sourceFile, title: 'source' })
  assert.equal(imported.ok, true)
  assert.equal(imported.parse.status, 'ok')
  assert.equal((await service.openRef({ sourceId: imported.sourceId, version: imported.version })).text, 'A source with sufficiently long readable content.')
  const spaceLimit = 500
  const spaceDoc = spaces.sanitizeSpaceDocument({ spaces: Array.from({ length: spaceLimit + 1 }, (_, i) => ({ id: `s${i}`, name: `S${i}` })), links: [{ spaceId: 's0', projectId: 'p' }, { spaceId: `s${spaceLimit}`, projectId: 'p' }] })
  assert.equal(spaceDoc.links.some((link) => link.spaceId === 's0'), false)
  assert.equal(spaceDoc.spaces.length, spaceLimit)
  assert.equal(spaceDoc.links.length, 1)
  console.log('review2 storage behavioral probes passed: bounded reads, PDF extraction, import/open persistence, space-link truncation')
} finally {
  await rm(dir, { recursive: true, force: true })
}
