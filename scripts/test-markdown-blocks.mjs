#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-md-blocks-'))
const outfile = join(dir, 'markdown-blocks.mjs')
const kbdOutfile = join(dir, 'markdown-kbd.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/markdown-blocks.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/markdown-kbd.ts')], bundle: true, platform: 'node', format: 'esm', outfile: kbdOutfile, logLevel: 'error' })
const { splitMarkdownBlocks, prepareStreamingMarkdown } = await import(pathToFileURL(outfile).href)
const { rehypeKbd } = await import(pathToFileURL(kbdOutfile).href)
await rm(dir, { recursive: true, force: true })

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

const html = (text) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text)).replace(/\n(?=<)|(?<=>)\n/g, '')
const blockHtml = (text) => splitMarkdownBlocks(text).map((b) => html(b.text)).join('')
const texts = (text) => splitMarkdownBlocks(text).map((b) => b.text)
const kbdHtml = (text) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeKbd] }, text)).replace(/\n(?=<)|(?<=>)\n/g, '')
const footnoteHtml = kbdHtml('脚注[^1]。\n\n[^1]: 定义内容。\n')
const baseCss = await readFile(join(ROOT, 'src/renderer/src/design/base.css'), 'utf8')

const answer = [
  '## 结论', '', '可以，按下面三步走：', '', '1. 先确认输入格式', '2. 写分帧函数', '3. 补边界测试', '',
  '```ts', 'export function frame(input: string): string[] {', '', '  return input.split(/\\r?\\n/).filter(Boolean)', '}', '```', '',
  '| 场景 | 处理 |', '| --- | --- |', '| 空行 | 丢弃 |', '', '> 这是引用', '> 第二行', '', '- 要点 **一**', '- 要点 `二`', '', '---', '', '最后一段，含 [链接](https://example.com)。', ''
].join('\n')

check('分块拼接还原原文，偏移正确', () => {
  const blocks = splitMarkdownBlocks(answer)
  assert.equal(blocks.map((b) => b.text).join(''), answer)
  for (const b of blocks) assert.equal(answer.slice(b.offset, b.offset + b.text.length), b.text)
  assert.ok(blocks.length >= 6, `blocks=${blocks.length}`)
})

check('任意前缀下已闭合块与最终分块一致（流式缓存可命中）', () => {
  const final = splitMarkdownBlocks(answer)
  for (let n = 0; n <= answer.length; n++) {
    const part = splitMarkdownBlocks(answer.slice(0, n))
    for (const closed of part.slice(0, -1)) {
      const same = final.find((b) => b.offset === closed.offset)
      assert.ok(same && same.text === closed.text, `prefix ${n} offset ${closed.offset}`)
    }
  }
})

check('代码块内的空行不切分', () => {
  const t = '前言\n\n```js\nconst a = 1\n\nconst b = 2\n\n// end\n```\n\n后记\n'
  const blocks = texts(t)
  assert.ok(blocks.some((b) => b.includes('const a = 1') && b.includes('// end')), JSON.stringify(blocks))
})

check('未闭合代码块之后的内容都留在末块', () => {
  const t = '前言\n\n```py\nprint(1)\n\nprint(2)\n\nstill code'
  const blocks = texts(t)
  assert.equal(blocks[blocks.length - 1], '```py\nprint(1)\n\nprint(2)\n\nstill code')
})

check('松散列表与缩进续行不切分', () => {
  const t = '- 第一项\n\n- 第二项\n\n  续行段落\n\n1. 甲\n\n2. 乙\n\n结尾\n'
  const blocks = texts(t)
  assert.ok(blocks[0].includes('第一项') && blocks[0].includes('续行段落') && blocks[0].includes('2. 乙'), JSON.stringify(blocks))
})

check('引用定义不切分，HTML 块切分后渲染不变', () => {
  assert.equal(texts('见 [文档][d]\n\n[d]: https://example.com\n').length, 1)
  const htmlBlock = '<div>\n\n内容\n\n</div>\n'
  assert.equal(blockHtml(htmlBlock), html(htmlBlock))
})

check('未换行的末行不触发切分', () => {
  assert.equal(texts('段一\n\n段二').length, 1)
  assert.equal(texts('段一\n\n段二\n').length, 2)
})

check('行内 <kbd> 渲染成元素，其余原始标签仍是文字', () => {
  const keys = kbdHtml('按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 中断。')
  assert.ok(keys.includes('<kbd>Ctrl</kbd>+<kbd>K</kbd>'), keys)
  assert.ok(!keys.includes('&lt;kbd&gt;'), keys)
  const others = kbdHtml('<b>粗</b> <kbd onclick="alert(1)">Ctrl</kbd> <script>alert(1)</script>')
  assert.ok(others.includes('<kbd>Ctrl</kbd>'), others)
  assert.ok(/<(?:b|script)\b|onclick=/.test(others) === false, others)
  assert.ok(others.includes('&lt;b&gt;') && others.includes('&lt;script&gt;'), others)
})

check('代码内的 <kbd> 保持原文', () => {
  const code = kbdHtml('`<kbd>x</kbd>` 行内\n\n```\n<kbd>y</kbd>\n```\n')
  assert.equal((code.match(/<kbd>/g) ?? []).length, 0, code)
  assert.ok(code.includes('&lt;kbd&gt;x&lt;/kbd&gt;'), code)
  assert.ok(code.includes('&lt;kbd&gt;y&lt;/kbd&gt;'), code)
})

check('未闭合的 <kbd> 不吞后续文字', () => {
  assert.ok(kbdHtml('<kbd>Ctrl 没闭合').includes('&lt;kbd&gt;Ctrl 没闭合'))
  assert.ok(kbdHtml('<kbd></kbd> 空').includes('&lt;kbd&gt;&lt;/kbd&gt;'))
})

check('脚注尾区块保留，标题靠 .sr-only 隐藏且结构不变', () => {
  assert.ok(footnoteHtml.includes('<h2 class="sr-only" id="footnote-label">Footnotes</h2>'), footnoteHtml)
  assert.ok(footnoteHtml.includes('<section data-footnotes="true" class="footnotes">'), footnoteHtml)
  assert.ok(footnoteHtml.includes('data-footnote-backref'), footnoteHtml)
})

check('.sr-only 在 base.css 里是完整的无障碍隐藏规则', () => {
  const rule = /\.sr-only[^{]*\{([^}]*)\}/.exec(baseCss)
  assert.ok(rule, '.sr-only rule missing')
  for (const declaration of ['position: absolute', 'width: 1px', 'height: 1px', 'clip-path: inset(50%)', 'white-space: nowrap']) {
    assert.ok(rule[1].includes(declaration), `${declaration} missing in ${rule[1]}`)
  }
})

check('流式未闭合行内代码暂缓到闭合，最终正文不变', () => {
  for (const delimiter of ['`', '``', '````']) {
    const prefix = `完成 ${delimiter}INCIDENT.md`
    assert.equal(prepareStreamingMarkdown(prefix, true), '完成 ')
    assert.equal(prepareStreamingMarkdown(prefix, false), prefix)
    assert.equal(prepareStreamingMarkdown(`${prefix}${delimiter}。`, true), `${prefix}${delimiter}。`)
    assert.ok(html(prepareStreamingMarkdown(`${prefix}${delimiter}`, true)).includes('<code>INCIDENT.md</code>'))
  }
  assert.equal(prepareStreamingMarkdown('完成 `', true), '完成 ')
  assert.equal(prepareStreamingMarkdown('完成 `ok`，以及 `pending', true), '完成 `ok`，以及 ')
  assert.equal(prepareStreamingMarkdown('跨行 `one\ntwo', true), '跨行 ')
  assert.equal(prepareStreamingMarkdown('旧段 `literal\n\n新段', true), '旧段 `literal\n\n新段')
})

check('流式预处理保留转义、围栏、代码里的反斜杠与不同长度反引号', () => {
  const samples = [String.raw`转义 \`literal`, '`a\\`', '``a`b``', '```js\nconst x = `pending\n', '~~~js\nconst x = `pending\n~~~', '    indented `code', '\tindented `code', '> ```js\n> const x = `pending', '- ```js\n  const x = `pending']
  for (const source of samples) assert.equal(prepareStreamingMarkdown(source, true), source)
  assert.equal(prepareStreamingMarkdown('```js\nconst x = `a`\n```\n\n后文 `pending', true), '```js\nconst x = `a`\n```\n\n后文 ')
  assert.equal(prepareStreamingMarkdown('``a`b', true), '')
})

const samples = [
  answer,
  '# 标题\n\n第一段 **粗体** 与 `code`。\n\n第二段\n换行。\n\n```\nplain\n```\n\n~~~bash\nls -la\n~~~\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
  '### 步骤\n\n- [ ] 待办\n- [x] 完成\n\n> 引用\n\n***\n\n中文段落，含 ~~删除线~~ 与自动链接 https://example.com 。\n',
  Array.from({ length: 6 }, (_, k) => `### 段落 ${k}\n\n流式输出第 ${k} 段：\n\n- 一 ${k}\n- 二 ${k}\n\n\`\`\`js\nconst x${k} = ${k}\n\`\`\`\n`).join('\n')
]
check('常见回答分块渲染与整段渲染 HTML 完全一致', () => {
  for (const s of samples) assert.equal(blockHtml(s), html(s))
})

process.stdout.write(`\n${pass} passed\n`)
