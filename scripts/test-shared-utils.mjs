import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = new URL('../src/', import.meta.url)

async function load(rel) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(rel, root))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const escape = await load('shared/escape.ts')
const clamp = await load('shared/clamp.ts')
const delay = await load('shared/delay.ts')
const base64url = await load('shared/base64url.ts')

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  process.stdout.write(`  ✓ ${name}\n`)
}

await check('escapeRegExp：正则元字符全部转义，普通字符不动', () => {
  assert.equal(escape.escapeRegExp('a.b*c+?^${}()|[]\\'), 'a\\.b\\*c\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\')
  assert.equal(escape.escapeRegExp('普通 文本 123'), '普通 文本 123')
  assert.equal(new RegExp(escape.escapeRegExp('1+1=2')).test('x1+1=2y'), true)
  assert.equal(new RegExp(escape.escapeRegExp('1+1=2')).test('111=2'), false)
})

await check('escapeHtml：只转义 & < > "，单引号保持原样', () => {
  assert.equal(escape.escapeHtml('<a href="x">&y</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;')
  assert.equal(escape.escapeHtml("it's fine"), "it's fine")
  assert.equal(escape.escapeHtml(''), '')
})

await check('clamp：夹到区间内，边界值不变', () => {
  assert.equal(clamp.clamp(5, 1, 10), 5)
  assert.equal(clamp.clamp(-3, 1, 10), 1)
  assert.equal(clamp.clamp(99, 1, 10), 10)
  assert.equal(clamp.clamp(1, 1, 1), 1)
})

await check('clampRounded：取整、越界夹紧、非法值回落默认', () => {
  assert.equal(clamp.clampRounded(7.6, 1, 10, 4), 8)
  assert.equal(clamp.clampRounded(0, 1, 10, 4), 1)
  assert.equal(clamp.clampRounded(99, 1, 10, 4), 10)
  assert.equal(clamp.clampRounded(undefined, 1, 10, 4), 4)
  assert.equal(clamp.clampRounded(Number.NaN, 1, 10, 4), 4)
  assert.equal(clamp.clampRounded(Number.POSITIVE_INFINITY, 1, 10, 4), 4)
})

await check('delay：按时返回，且不会提前', async () => {
  const started = Date.now()
  await delay.delay(15)
  assert.ok(Date.now() - started >= 14, `实际 ${Date.now() - started}ms`)
  await delay.delay(0)
})

await check('base64url：与 Buffer 的 base64url 一致，解码可往返', () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 255, 62, 63])
  const encoded = base64url.encodeBase64Url(bytes)
  assert.equal(encoded, Buffer.from(bytes).toString('base64url'))
  assert.ok(!/[+/=]/.test(encoded), '不含 base64 的 + / = 字符')
  assert.deepEqual(Array.from(base64url.decodeBase64Url(encoded)), Array.from(bytes))
  assert.deepEqual(Array.from(base64url.decodeBase64Url('')), [])
})

await check('base64url：非 base64url 文本直接报错', () => {
  assert.throws(() => base64url.decodeBase64Url('a+b/c='), /不是 base64url/)
  assert.throws(() => base64url.decodeBase64Url(42), /不是 base64url/)
})

process.stdout.write(`\n${passed} 组检查通过\n`)
