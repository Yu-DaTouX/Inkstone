import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runFileContentSearchTests } from './test-file-content-search.mjs'

async function load(rel) {
  const source = fileURLToPath(new URL(`../src/${rel}`, import.meta.url))
  const result = await build({
    entryPoints: [source],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const search = await load('renderer/src/features/files/files-search.ts')
const main = await load('main/file-content-search.ts')

assert.deepEqual(search.parseFilesQuery('?my'), { mode: 'content', query: 'my' }, '半角 ? 进入内容搜索')
assert.deepEqual(search.parseFilesQuery('？ my'), { mode: 'content', query: 'my' }, '中文输入法的全角 ？ 也进入内容搜索')
assert.deepEqual(search.parseFilesQuery(' my?'), { mode: 'name', query: 'my?' }, '? 不在开头时仍是文件名搜索')
assert.equal(search.isContentQuery('？'), true)
assert.equal(search.contentQueryFrom('readme'), '?readme', '名称查询可一键切到内容搜索')
assert.equal(search.contentQueryFrom('？x'), '?x')

const collapsed = search.collapseSnippetWhitespace('  a\t\t b  c ', [[6, 7]])
assert.deepEqual(collapsed, { text: 'a b c', ranges: [[2, 3]] }, '片段折叠空白并换算匹配区间')

const short = search.contentSnippet('    return value', [[4, 10]])
assert.equal(short.ellipsis, false)
assert.deepEqual(short.parts, [{ text: 'return', hit: true }, { text: ' value', hit: false }], '匹配在开头附近不截断')

const longLine = 'const someVeryLongIdentifierName = anotherLongName + targetWord + tail'
const at = longLine.indexOf('targetWord')
const cut = search.contentSnippet(longLine, [[at, at + 10]])
assert.equal(cut.ellipsis, true, '匹配离行首较远时前面加省略号')
assert.ok(cut.text.length < longLine.length && cut.text.includes('targetWord'))
assert.ok(cut.text.indexOf('targetWord') <= 26, '截断后匹配前保留不超过 26 个字符')
assert.deepEqual(cut.parts.find((part) => part.hit), { text: 'targetWord', hit: true })
assert.ok(cut.lead.startsWith('…') && !cut.lead.includes('targetWord'), '片段拆成前导、首个匹配与尾部，前导带省略号')
assert.deepEqual(cut.hit, [{ text: ' ', hit: false }, { text: 'targetWord', hit: true }], '首个匹配连同前面的空白不收缩')
assert.equal(cut.tail.map((part) => part.text).join(''), ' + tail')
const multi = search.contentSnippet('a my b my', [[2, 4], [7, 9]])
assert.deepEqual(multi.tail, [{ text: ' b ', hit: false }, { text: 'my', hit: true }], '尾部保留其余匹配高亮')

const hits = []
for (let line = 1; line <= 7; line += 1) hits.push({ path: 'src/a.ts', name: 'a.ts', line, text: `a ${line}`, ranges: [[0, 1]] })
hits.push({ path: 'b.md', name: 'b.md', line: 2, text: 'a', ranges: [[0, 1]] })
const grouped = search.groupContentHits(hits)
assert.deepEqual(
  grouped.rows.map((row) => `${row.kind}:${row.path}:${row.line ?? ''}${row.more ? '+' : ''}`),
  ['entry:src/a.ts:', 'line:src/a.ts:1', 'line:src/a.ts:2', 'line:src/a.ts:3', 'line:src/a.ts:4', 'line:src/a.ts:5+', 'entry:b.md:', 'line:b.md:2'],
  '按文件分组，每个文件最多 5 条，超出的在最后一条标记还有更多'
)
assert.equal(grouped.rows[0].parent, 'src', '文件行带相对目录')
assert.equal(grouped.shown, 6)
assert.equal(grouped.truncated, false)

const capped = search.groupContentHits(hits, 3, 5)
assert.equal(capped.shown, 3)
assert.equal(capped.truncated, true, '超过全局显示上限时标记截断')

const result = (extra) => ({ request: { cwd: '/p', generation: 0, requestId: 'r', query: 'x' }, hits: [], status: 'ok', truncated: false, scannedFiles: 0, skippedFiles: 0, ...extra })
assert.equal(search.contentSearchError(result({ status: 'pattern' })), 'pattern')
assert.equal(search.contentSearchError(result({ status: 'permission' })), 'permission')
assert.equal(search.contentSearchError(result({ status: 'error' })), 'error')
assert.equal(search.contentSearchError(result({ status: 'empty' })), null, '没有命中不是失败')
assert.equal(search.contentSearchError(result({ status: 'partial' })), null)
assert.equal(search.contentSearchLimit(result({ truncated: true, truncation: ['result-limit'] }), grouped), 'results')
assert.equal(search.contentSearchLimit(result({ truncated: true, truncation: ['scan-limit'] }), grouped), 'scan')
assert.equal(search.contentSearchLimit(result({}), capped), 'results')
assert.equal(search.contentSearchLimit(result({}), grouped), null)

const rows = grouped.rows
assert.equal(search.resultDestination('ArrowDown', 0, rows), 1)
assert.equal(search.resultDestination('ArrowDown', rows.length - 1, rows), rows.length - 1)
assert.equal(search.resultDestination('ArrowUp', 0, rows), 'input', '首行上键回到输入框')
assert.equal(search.resultDestination('ArrowLeft', 4, rows), 0, '匹配行左键跳到所属文件行')
assert.equal(search.resultDestination('ArrowLeft', 7, rows), 6)
assert.equal(search.resultDestination('ArrowLeft', 0, rows), null)
assert.equal(search.resultDestination('End', 0, rows), rows.length - 1)
assert.equal(search.resultDestination('Enter', 0, rows), null)

const matcher = main.compileContentMatcher('ab', { wholeWord: true })
assert.deepEqual(matcher.match('ab abc ab_ (ab)'), [[0, 2], [12, 14]], '全字匹配以字母数字下划线为词界')
assert.deepEqual(main.compileContentMatcher('文件', { wholeWord: true }).match('文件 文件夹'), [[0, 2]], '全字匹配支持中文词界')
assert.deepEqual(main.compileContentMatcher('.x', { wholeWord: true }).match('a.x .xy'), [[1, 3]], '首字符不是单词字符时不加前置词界')
assert.equal(main.compileContentMatcher('[', { regexp: true }), null, '非法正则编译失败')
assert.equal(main.compileContentMatcher('a\nb', {}), null, '字面量不跨行')
assert.equal(main.compileContentMatcher('a', { regexp: true }).skips('a'.repeat(1001)), true, '正则模式跳过超长行')
assert.equal(main.compileContentMatcher('a', {}).skips('a'.repeat(5000)), false)

let failures = 0
await runFileContentSearchTests((condition, label) => {
  if (!condition) {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}, main)
assert.equal(failures, 0, '主进程内容搜索用例全部通过')

console.log('✓ files-search：? 解析、片段、分组、键盘与主进程搜索选项')
