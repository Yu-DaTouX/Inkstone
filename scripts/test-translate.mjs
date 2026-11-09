import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dataDir = await mkdtemp(join(tmpdir(), 'yan-translate-'))
const compiled = await mkdtemp(resolve('node_modules/.inkstone-translate-'))
process.env.YAN_DATA_DIR = dataDir
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks++ }
try {
  const outfile = join(compiled, 'translate.mjs')
  await build({
    stdin: { contents: "export * from './src/main/translate.ts'; export * from './src/shared/translate.ts'", resolveDir: process.cwd() },
    outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'electron-stub', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app = { isPackaged: false, getPath: () => ${JSON.stringify(dataDir)}, getLocale: () => 'zh-CN', getVersion: () => '0' }; export default { app }` }))
    } }]
  })
  const m = await import(pathToFileURL(outfile))

  const parts = m.splitForTranslation('First paragraph.\n```js\nconst a = 1\n```\nSecond paragraph.')
  ok(parts.map((p) => p.translate).join() === 'true,false,true', 'fenced code is split out and never translated')
  ok(parts[1].text.includes('const a = 1'), 'fenced code keeps its text')
  ok(parts.map((p) => p.text).join('') === 'First paragraph.\n```js\nconst a = 1\n```\nSecond paragraph.', 'pieces rejoin to the original text')

  const prot = m.protectSpans('Run `yan image generate` on C:\\Users\\me\\a.txt and https://x.io/a/b now.')
  ok(prot.spans.length === 3 && !prot.text.includes('yan image'), 'inline code, windows paths and urls are protected')
  ok(m.restoreSpans(prot.text.replace(/Run/, '运行'), prot.spans)?.includes('`yan image generate`'), 'protected spans restore verbatim')
  ok(m.restoreSpans('<x0/> only', ['a', 'b']) === null, 'a lost placeholder is detected')
  ok(m.restoreSpans('<x0/> <x0/>', ['a']) === null, 'a duplicated placeholder is detected')
  ok(m.chunkProse('a'.repeat(50), 20).every((c) => c.length <= 20) === false || m.chunkProse('One. Two. Three.', 6).length > 1, 'long prose is chunked')

  const calls = []
  const upper = async (texts) => { calls.push(texts); return texts.map((t) => t.replace(/Hello/g, '你好').replace(/world/g, '世界').replace(/Look at/g, '看').replace(/now/g, '现在')) }
  const remotes = { bing: upper, google: async () => { throw new Error('google must not be used') } }
  const first = await m.translateText('Hello world', { service: 'bing', target: 'zh-Hans' }, remotes)
  ok(first.ok && first.text === '你好 世界', 'a translation succeeds')
  ok(first.ok && first.cached === false && calls.length === 1, 'first call hits the service')
  const again = await m.translateText('Hello world', { service: 'bing', target: 'zh-Hans' }, remotes)
  ok(again.ok && again.cached === true && calls.length === 1, 'the same text is served from the cache')
  const other = await m.translateText('Hello world', { service: 'bing', target: 'ja' }, remotes)
  ok(other.ok && other.cached === false && calls.length === 2, 'another target language misses the cache')

  const withCode = await m.translateText('Look at `foo.bar()` now\n```\nkeep me\n```\n', { service: 'bing', target: 'zh-Hans' }, remotes)
  ok(withCode.ok && withCode.text.includes('`foo.bar()`') && withCode.text.includes('keep me') && !calls.flat().some((t) => t.includes('keep me')), 'code is kept and not sent to the service')

  let attempts = 0
  const dropping = async (texts) => { attempts++; return texts.map((t) => (attempts === 1 ? 'lost it' : t.replace('Open', '打开'))) }
  const retried = await m.translateText('Open `a.b` please', { service: 'bing', target: 'zh-Hans' }, { bing: dropping, google: dropping })
  ok(retried.ok && attempts === 2 && retried.text.includes('打开'), 'when a placeholder is lost the piece is retranslated without protection')

  const failing = await m.translateText('Will fail', { service: 'bing', target: 'zh-Hans' }, { bing: async () => { throw new Error('boom') }, google: async () => ['should not run'] })
  ok(!failing.ok && failing.error === 'boom', 'a failure is reported and never falls back to another service')
  const failedAgain = await m.translateText('Will fail', { service: 'bing', target: 'zh-Hans' }, remotes)
  ok(failedAgain.ok && failedAgain.cached === false, 'a failed translation is not cached')

  ok(!(await m.translateText('   ', { service: 'bing', target: undefined }, remotes)).ok, 'blank text is rejected')
  ok(!(await m.translateText('x'.repeat(m.TRANSLATE_MAX_CHARS + 1), { service: 'bing', target: undefined }, remotes)).ok, 'over-long text is rejected')
  ok(m.resolveTranslateTarget(undefined, 'zh-CN') === 'zh-Hans' && m.resolveTranslateTarget(undefined, 'en-US') === 'en' && m.resolveTranslateTarget('ja', 'en-US') === 'ja', 'auto target follows the app language')

  await m.flushCache()
  console.log(`translate: ${checks} checks passed (no network, no model)`)
} finally {
  await rm(dataDir, { recursive: true, force: true })
  await rm(compiled, { recursive: true, force: true })
}
