import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['src/renderer/src/lib/file-preview-url.ts'],
  bundle: true,
  format: 'esm',
  write: false,
})
const code = result.outputFiles[0].text
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const { filePreviewUrl } = await import(moduleUrl)

assert.equal(filePreviewUrl('C:\\work\\a#b?.png'), 'file:///C:/work/a%23b%3F.png')
assert.equal(filePreviewUrl('/tmp/space here/%.png'), 'file:///tmp/space%20here/%25.png')
assert.equal(filePreviewUrl('C:\\dir\\nested#name\\x?.png'), 'file:///C:/dir/nested%23name/x%3F.png')
console.log('workspace review regression: 3 behavioral cases passed')
