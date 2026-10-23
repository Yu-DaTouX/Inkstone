import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'yan-artifact-libs-'))
let checks = 0
const ok = (condition, label) => {
  assert.ok(condition, label)
  checks++
}

try {
  const outfile = join(dir, 'libs.mjs')
  await build({
    stdin: {
      contents: [
        "export { inlineArtifactLibs, usesArtifactLibs } from './src/shared/html-artifact-libs'",
        "export { withPreviewRuntime } from './src/shared/html-artifact-preview'"
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  })
  const { inlineArtifactLibs, usesArtifactLibs, withPreviewRuntime } = await import(pathToFileURL(outfile).href)
  const lib = 'var THREE={a:"$&$1",b:"</script>"}'
  const read = (name) => (name === 'three' ? lib : null)

  const html = '<!doctype html><head><script data-yan-lib="three"></script></head><body><p>x</p></body>'
  const out = inlineArtifactLibs(html, read)
  ok(out.includes('<script data-yan-lib-inline="three">var THREE={a:"$&$1"'), 'inlines the library and keeps $ sequences literally')
  ok(out.includes('b:"<\\/script>"') && !out.slice(0, out.lastIndexOf('</head>')).includes('"</script>"'), 'escapes </script inside the library')
  ok(!out.includes('data-yan-lib="three"'), 'the placeholder tag is gone')
  ok(usesArtifactLibs(html) && !usesArtifactLibs('<script src="a.js"></script>'), 'detects placeholder tags')

  for (const variant of ["<script data-yan-lib='three'></script>", '<script type="text/javascript" data-yan-lib=three defer></script>', '<SCRIPT DATA-YAN-LIB="THREE"> </SCRIPT>']) {
    ok(inlineArtifactLibs(variant, read).includes('data-yan-lib-inline="three"'), `accepts variant ${variant}`)
  }
  const unknown = '<script data-yan-lib="d3"></script>'
  ok(inlineArtifactLibs(unknown, read) === unknown, 'unknown libraries stay untouched')
  ok(inlineArtifactLibs(html, () => null) === html, 'a missing library file leaves the tag in place')
  ok(inlineArtifactLibs('<p>plain</p>', read) === '<p>plain</p>', 'pages without placeholders are unchanged')

  const served = inlineArtifactLibs(withPreviewRuntime(html, 'n'), read)
  ok(served.includes('data-yan-lib-inline="three"'), 'still inlines after source offsets are marked')
  const bodyOffset = html.indexOf('<body>')
  ok(new RegExp(`<body[^>]*="${bodyOffset}"`).test(served), 'source offsets after the library refer to the original file')

  const real = await readFile(join(ROOT, 'resources', 'skills', 'artifact', 'vendor', 'three.min.js'), 'utf8')
  ok(!/<\/script/i.test(real) && /three\.js 0\.\d+\.\d+ \(MIT\)/.test(real.slice(0, 200)), 'bundled three.min.js is safe to inline and carries its license banner')

  console.log(`artifact-libs: ${checks} checks passed`)
} finally {
  await rm(dir, { recursive: true, force: true })
}
