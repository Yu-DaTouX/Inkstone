import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-command-params-'))
  try {
    const { paramString, paramNumber } = await compile('src/main/command-params.ts', join(dir, 'command-params.mjs'))

    assert.equal(paramString({ a: '  hello  ' }, ['a']), 'hello')
    assert.equal(paramString({ a: '', b: 'fallback' }, ['a', 'b']), 'fallback')
    assert.equal(paramString({ a: '   ', b: 'fallback' }, ['a', 'b']), 'fallback')
    assert.equal(paramString({ a: 42, b: 'fallback' }, ['a', 'b']), 'fallback')
    assert.equal(paramString({ a: null, b: 'fallback' }, ['a', 'b']), 'fallback')
    assert.equal(paramString({ a: ['x'], b: 'fallback' }, ['a', 'b']), 'fallback')
    assert.equal(paramString({ a: 'first', b: 'second' }, ['a', 'b']), 'first')
    assert.equal(paramString({ b: 'second' }, ['a', 'b']), 'second')
    assert.equal(paramString({}, ['a']), undefined)
    assert.equal(paramString({ a: '' }, ['a']), undefined)
    assert.equal(paramString({ a: '   ' }, ['a']), undefined)

    assert.equal(paramNumber({ n: 3.5 }, 'n'), 3.5)
    assert.equal(paramNumber({ n: 0 }, 'n'), 0)
    assert.equal(paramNumber({ n: -12 }, 'n'), -12)
    assert.equal(paramNumber({ n: ' 42 ' }, 'n'), 42)
    assert.equal(paramNumber({ n: '3.5' }, 'n'), 3.5)
    assert.equal(paramNumber({ n: '-0.5' }, 'n'), -0.5)
    assert.equal(paramNumber({ n: '' }, 'n'), undefined)
    assert.equal(paramNumber({ n: '   ' }, 'n'), undefined)
    assert.equal(paramNumber({ n: 'abc' }, 'n'), undefined)
    assert.equal(paramNumber({ n: '12abc' }, 'n'), undefined)
    assert.equal(paramNumber({ n: 'Infinity' }, 'n'), undefined)
    assert.equal(paramNumber({ n: Infinity }, 'n'), undefined)
    assert.equal(paramNumber({ n: NaN }, 'n'), undefined)
    assert.equal(paramNumber({ n: -Infinity }, 'n'), undefined)
    assert.equal(paramNumber({ n: true }, 'n'), undefined)
    assert.equal(paramNumber({ n: {} }, 'n'), undefined)
    assert.equal(paramNumber({ n: [] }, 'n'), undefined)
    assert.equal(paramNumber({}, 'n'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run()
  console.log('command-params: 全部通过')
}
