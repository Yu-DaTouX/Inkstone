import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-review2-storage-'))
try {
  const outfile = join(dir, 'pdf-text.mjs')
  const compileOnly = ['src/main/project-memory-store.ts', 'src/main/personal-memory.ts']
  for (const [index, entry] of compileOnly.entries()) {
    await build({ entryPoints: [entry], outfile: join(dir, `compile-${index}.mjs`), bundle: true, platform: 'node', format: 'esm' })
  }
  await build({ entryPoints: ['src/main/office/pdf-text.ts'], outfile, bundle: true, platform: 'node', format: 'esm' })
  const parser = await import(pathToFileURL(outfile).href)
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
  const tooLargePdf = Buffer.alloc(parser.MAX_PDF_BYTES + 1)
  tooLargePdf.write('%PDF-1.4', 'latin1')
  assert.equal(parser.parsePdfBuffer(tooLargePdf).status, 'unsupported')
  console.log('review2 storage behavioral probes passed: PDF extraction and size bound')
} finally {
  await rm(dir, { recursive: true, force: true })
}
