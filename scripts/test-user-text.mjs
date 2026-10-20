#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-user-text-'))
const outfile = join(dir, 'user-text.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/user-text.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const { parseUserSegments, parseUserInline, trimBareUrl, USER_TEXT_LIMITS } = await import(pathToFileURL(outfile).href)
await rm(dir, { recursive: true, force: true })

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

check('没有围栏时整段是一段文字', () => {
  const segments = parseUserSegments('  第一行\n第二行  ')
  assert.deepEqual(segments, [{ kind: 'text', text: '第一行\n第二行' }])
})

check('空文本没有分段', () => {
  assert.deepEqual(parseUserSegments(''), [])
  assert.deepEqual(parseUserSegments('   \n  '), [])
})

check('围栏前后拆成文字段，代码卡保留语言与正文', () => {
  const source = '先看这段：\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n然后就没了。'
  assert.deepEqual(parseUserSegments(source), [
    { kind: 'text', text: '先看这段：' },
    { kind: 'code', text: 'const a = 1\n\nconst b = 2', lang: 'ts' },
    { kind: 'text', text: '然后就没了。' }
  ])
})

check('无语言标注的围栏记为 text', () => {
  const segments = parseUserSegments('```\nplain\n```')
  assert.deepEqual(segments, [{ kind: 'code', text: 'plain', lang: 'text' }])
})

check('多个围栏按顺序拆段', () => {
  const segments = parseUserSegments('甲\n```js\nx\n```\n乙\n```sh\ny\n```\n丙')
  assert.deepEqual(segments.map((segment) => segment.kind), ['text', 'code', 'text', 'code', 'text'])
  assert.deepEqual(segments.filter((segment) => segment.kind === 'code').map((segment) => segment.text), ['x', 'y'])
})

check('未闭合的围栏整体保留为文字', () => {
  const segments = parseUserSegments('说明\n\n```js\nconst a = 1')
  assert.deepEqual(segments, [{ kind: 'text', text: '说明\n\n```js\nconst a = 1' }])
})

check('围栏长度不足的闭合符不结束代码', () => {
  const segments = parseUserSegments('````\n```\ninner\n```\n````\n尾')
  assert.equal(segments[0].kind, 'code')
  assert.equal(segments[0].text, '```\ninner\n```')
  assert.equal(segments[1].text, '尾')
})

check('超过围栏上限时退回整段文字', () => {
  const source = Array.from({ length: USER_TEXT_LIMITS.maxFences + 1 }, (_, index) => `\`\`\`\n${index}\n\`\`\`\n`).join('')
  const segments = parseUserSegments(source)
  assert.equal(segments.length, 1)
  assert.equal(segments[0].kind, 'text')
})

check('行内码拆出 code run，反引号不跨行', () => {
  assert.deepEqual(parseUserInline('用 `pnpm test` 跑。`没闭合\n跨行`'), [
    { kind: 'text', text: '用 ' },
    { kind: 'code', text: 'pnpm test' },
    { kind: 'text', text: ' 跑。`没闭合\n跨行`' }
  ])
})

check('裸链接与 Markdown 链接都渲染成 link run', () => {
  assert.deepEqual(parseUserInline('看 https://example.com/a 和 [文档](https://example.com/docs) 两处'), [
    { kind: 'text', text: '看 ' },
    { kind: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
    { kind: 'text', text: ' 和 ' },
    { kind: 'link', text: '文档', href: 'https://example.com/docs' },
    { kind: 'text', text: ' 两处' }
  ])
})

check('链接尾随标点与不成对括号留在文字里', () => {
  assert.deepEqual(trimBareUrl('https://example.com/a.'), { href: 'https://example.com/a', trailing: '.' })
  assert.deepEqual(trimBareUrl('https://example.com/a_(b)'), { href: 'https://example.com/a_(b)', trailing: '' })
  assert.deepEqual(trimBareUrl('https://example.com/a)'), { href: 'https://example.com/a', trailing: ')' })
  assert.deepEqual(parseUserInline('地址 https://example.com/x, 然后继续'), [
    { kind: 'text', text: '地址 ' },
    { kind: 'link', text: 'https://example.com/x', href: 'https://example.com/x' },
    { kind: 'text', text: ',' },
    { kind: 'text', text: ' 然后继续' }
  ])
})

check('非 http 协议与无效链接保持文字', () => {
  const runs = parseUserInline('[文件](file:///tmp/a.txt) 和 ftp://example.com')
  assert.equal(runs.filter((run) => run.kind === 'link').length, 0)
})

check('图片引用标记不参与行内拆分', () => {
  const runs = parseUserInline('看看 @图1 和 `x`')
  assert.deepEqual(runs[0], { kind: 'text', text: '看看 @图1 和 ' })
  assert.deepEqual(runs[1], { kind: 'code', text: 'x' })
})

check('超长文本不解析围栏', () => {
  const source = '字'.repeat(USER_TEXT_LIMITS.maxCodeUnits + 1)
  assert.deepEqual(parseUserSegments(source), [{ kind: 'text', text: source }])
})

process.stdout.write(`\n${pass} passed\n`)
