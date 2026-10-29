#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-session-visual-'))

async function load(name, entry, external = []) {
  const outfile = join(dir, `${name}.mjs`)
  await build({ entryPoints: [join(ROOT, entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', external })
  return import(pathToFileURL(outfile).href)
}

const fade = await load('reveal-fade', 'src/renderer/src/features/session/reveal-fade.ts')
const follow = await load('scroll-follow', 'src/renderer/src/features/session/scroll-follow.ts')
const position = await load('scroll-position', 'src/renderer/src/features/session/scroll-position.ts')
const receipt = await load('question-receipt', 'src/renderer/src/features/session/question-receipt.ts')
const mdKey = await load('markdown-cache-key', 'src/renderer/src/features/session/markdown-cache-key.ts')
const highlight = await load('code-highlight', 'src/renderer/src/lib/code-highlight.ts')
const math = await load('markdown-math', 'src/renderer/src/features/session/markdown-math.ts', ['remark-math', 'rehype-katex', 'katex', 'katex/*'])
await rm(dir, { recursive: true, force: true })

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

check('渐显：短首段整体淡入，长首段不动画', () => {
  const short = fade.trackReveal(null, 'hello', 0)
  assert.deepEqual(short.marks, [{ from: 0, at: 0 }])
  const long = fade.trackReveal(null, 'x'.repeat(fade.FADE_SKIP_INITIAL_CHARS + 1), 0)
  assert.equal(long.marks.length, 0)
})

check('渐显：追加只标记新增部分，过期标记被清掉', () => {
  let track = fade.trackReveal(null, 'ab', 0)
  track = fade.trackReveal(track, 'abcd', 50)
  assert.deepEqual(fade.fadeSpans(track, 60), [{ from: 0, to: 2, age: 60 }, { from: 2, to: 4, age: 10 }])
  track = fade.trackReveal(track, 'abcdef', fade.FADE_MS + 10)
  assert.deepEqual(track.marks.map((mark) => mark.from), [2, 4])
  assert.deepEqual(fade.fadeSpans(track, fade.FADE_MS + 60).map((span) => [span.from, span.to]), [[4, 6]])
})

check('渐显：非前缀改写时重置', () => {
  const track = fade.trackReveal(fade.trackReveal(null, 'abc', 0), 'xyz', 10)
  assert.equal(track.text, 'xyz')
  assert.equal(track.marks.length, 0)
})

check('渐显：分块换算到块内偏移', () => {
  const spans = [{ from: 5, to: 15, age: 20 }]
  assert.deepEqual(fade.spansForBlock(spans, 10, 10), [{ from: 0, to: 5, age: 20 }])
  assert.deepEqual(fade.spansForBlock(spans, 20, 5), [])
})

check('渐显：rehype 只包正文文本，跳过代码', () => {
  const tree = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'abcdef', position: { start: { offset: 0 }, end: { offset: 6 } } }] },
      { type: 'element', tagName: 'pre', properties: {}, children: [{ type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: 'zz', position: { start: { offset: 7 }, end: { offset: 9 } } }] }] }
    ]
  }
  fade.rehypeRevealFade({ spans: [{ from: 3, to: 9, age: 40 }] })(tree)
  const p = tree.children[0]
  assert.equal(p.children.length, 2)
  assert.equal(p.children[0].value, 'abc')
  assert.equal(p.children[1].tagName, 'span')
  assert.deepEqual(p.children[1].properties.className, ['v3-fade'])
  assert.equal(p.children[1].properties.style, 'animation-delay:-40ms')
  assert.equal(tree.children[1].children[0].children[0].type, 'text')
})

check('跟随：贴底时保持跟随，无按钮', () => {
  const at = follow.decideFollow(true, { offset: 1000, size: 1500, viewport: 500 }, null, 0)
  assert.deepEqual(at, { stick: true, showJump: false, repin: false })
})

check('跟随：用户上翻后内容变短被夹到底部，不自动恢复跟随', () => {
  const clamped = follow.decideFollow(false, { offset: 1000, size: 1500, viewport: 500 }, 100, 5000)
  assert.deepEqual(clamped, { stick: false, showJump: false, repin: false })
  const never = follow.decideFollow(false, { offset: 1000, size: 1500, viewport: 500 }, null, 5000)
  assert.equal(never.stick, false)
})

check('跟随：用户还没滚到底时，不因40px容差抢回滚动位置', () => {
  const reading = follow.decideFollow(false, { offset: 980, size: 1500, viewport: 500 }, null, 2000)
  assert.deepEqual(reading, { stick: false, showJump: false, repin: false })
  const active = follow.decideFollow(true, { offset: 980, size: 1500, viewport: 500 }, 100, 200)
  assert.deepEqual(active, { stick: false, showJump: false, repin: false })
  const bottom = follow.decideFollow(false, { offset: 1000, size: 1500, viewport: 500 }, 100, 200)
  assert.deepEqual(bottom, { stick: true, showJump: false, repin: false })
})

check('跟随：无用户操作的版面回弹继续跟随并重新贴底', () => {
  const bounce = follow.decideFollow(true, { offset: 600, size: 1500, viewport: 500 }, null, 5000)
  assert.deepEqual(bounce, { stick: true, showJump: false, repin: true })
  const stale = follow.decideFollow(true, { offset: 600, size: 1500, viewport: 500 }, 0, follow.USER_SCROLL_INTENT_MS + 1)
  assert.equal(stale.repin, true)
  const shrink = follow.decideFollow(true, { offset: 600, size: 1200, viewport: 500 }, null, 5000, { offset: 700, size: 1400, viewport: 500 })
  assert.equal(shrink.repin, true, '内容高度变化导致的位移按回弹处理')
})

check('跟随：高度不变的上移（拖滚动条、查找跳转）解除跟随', () => {
  const moved = follow.decideFollow(true, { offset: 300, size: 1500, viewport: 500 }, null, 5000, { offset: 1000, size: 1500, viewport: 500 })
  assert.deepEqual(moved, { stick: false, showJump: true, repin: false })
  assert.equal(follow.isLayoutShift(null, { offset: 0, size: 1, viewport: 1 }), true)
  assert.equal(follow.isLayoutShift({ offset: 10, size: 100, viewport: 50 }, { offset: 20, size: 100, viewport: 50 }), true)
})

check('跟随：用户上滚解除跟随，超过 200px 才显示回到底部', () => {
  const near = follow.decideFollow(true, { offset: 850, size: 1500, viewport: 500 }, 100, 200)
  assert.deepEqual(near, { stick: false, showJump: false, repin: false })
  const far = follow.decideFollow(true, { offset: 700, size: 1500, viewport: 500 }, 100, 200)
  assert.deepEqual(far, { stick: false, showJump: true, repin: false })
  assert.equal(follow.JUMP_THRESHOLD_PX, 200)
})

check('跟随：阅读锚点取视口顶部所在的回合', () => {
  const rows = [{ id: 'a', top: -300, bottom: -10 }, { id: 'b', top: -10, bottom: 400 }, { id: 'c', top: 400, bottom: 900 }]
  assert.deepEqual(follow.pickReadingAnchor(rows, 0), { turnId: 'b', offset: 10 })
  assert.equal(follow.pickReadingAnchor([], 0), null)
  assert.equal(follow.isScrollIntentKey('PageUp'), true)
  assert.equal(follow.isScrollIntentKey('a'), false)
})

check('分屏：滚动位置跨视图实例共享，Windows 路径大小写与斜杠一致', () => {
  const snapshot = { top: 420, bottom: false, anchor: { turnId: 'turn-b', offset: 20 } }
  position.saveScrollSnapshot('C:/Sessions/Chat.jsonl', snapshot)
  assert.deepEqual(position.readScrollSnapshot('c:\\sessions\\chat.jsonl'), snapshot)
  position.saveScrollSnapshot('other', { top: 500, bottom: true, anchor: { turnId: 'discard', offset: 0 } })
  assert.equal(position.readScrollSnapshot('other').anchor, null)
  assert.equal(position.readScrollSnapshot('missing'), undefined)
  position.saveScrollSnapshot('', snapshot)
  assert.equal(position.readScrollSnapshot(''), undefined)
})

check('分屏：切焦点后按回合锚点恢复，允许编辑器高度和上方内容变化', () => {
  const box = {
    scrollTop: 200,
    scrollHeight: 2000,
    clientHeight: 500,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [
      { dataset: { turnId: 'a' }, getBoundingClientRect: () => ({ top: -300, bottom: -10 }) },
      { dataset: { turnId: 'b' }, getBoundingClientRect: () => ({ top: 80, bottom: 400 }) }
    ]
  }
  assert.deepEqual(position.domMetrics(box), { offset: 200, size: 2000, viewport: 500 })
  assert.deepEqual(position.domAnchor(box), { turnId: 'b', offset: 20 })
  position.restoreDomScroll(box, { top: 999, bottom: false, anchor: { turnId: 'b', offset: 40 } })
  assert.equal(box.scrollTop, 220, '保持相同回合及回合内偏移，不沿用不同视图的绝对位置')
  position.restoreDomScroll(box, { top: 333, bottom: false, anchor: { turnId: 'gone', offset: 0 } })
  assert.equal(box.scrollTop, 333, '锚点丢失时回退绝对位置')
  position.restoreDomScroll(box, { top: 0, bottom: true, anchor: null })
  assert.equal(box.scrollTop, 2000, '原来贴底的视图继续贴底')
})

check('分屏：共享滚动记录有界，不无限保留历史会话', () => {
  for (let i = 0; i < 33; i += 1) position.saveScrollSnapshot(`bounded-${i}`, { top: i, bottom: false, anchor: null })
  assert.equal(position.readScrollSnapshot('bounded-0'), undefined)
  assert.equal(position.readScrollSnapshot('bounded-32').top, 32)
})

check('Markdown 缓存键：HTML 开关不靠拼接正文区分', () => {
  const preview = mdKey.markdownCacheKey({ lang: 'zh-CN', allowHtml: true, math: false, text: '<b>x</b>' })
  const chat = mdKey.markdownCacheKey({ lang: 'zh-CN', allowHtml: false, math: false, text: 'html:<b>x</b>' })
  assert.notEqual(preview, chat)
  assert.notEqual(mdKey.markdownCacheKey({ lang: 'zh-CN', allowHtml: false, math: true, text: 'a' }), mdKey.markdownCacheKey({ lang: 'zh-CN', allowHtml: false, math: false, text: 'math:a' }))
  assert.notEqual(mdKey.markdownCacheKey({ lang: 'zh-CN', allowHtml: false, math: false, text: 'a|b' }), mdKey.markdownCacheKey({ lang: 'zh-CN|a', allowHtml: false, math: false, text: 'b' }))
})

check('提问回执：运行中、已答、跳过、失败', () => {
  assert.equal(receipt.questionReceipt({ name: 'question', status: 'running', args: { question: 'Q?' } }).state, 'pending')
  const answered = receipt.questionReceipt({ name: 'question', status: 'ok', args: { question: 'Q?' }, output: 'Answer: 蓝色' })
  assert.deepEqual(answered, { state: 'answered', question: 'Q?', answer: '蓝色', pairs: [] })
  assert.equal(receipt.questionReceipt({ name: 'question', status: 'ok', details: { question: 'Q?', cancelled: true } }).state, 'skipped')
  assert.equal(receipt.questionReceipt({ name: 'question', status: 'error', args: { question: 'Q?' } }).state, 'failed')
  assert.equal(receipt.isQuestionCall({ name: 'question' }), true)
  assert.equal(receipt.isQuestionCall({ name: 'bash' }), false)
})

check('提问回执：表单字段按标签成对展示', () => {
  const model = receipt.questionReceipt({
    name: 'question',
    status: 'ok',
    details: { question: '配置', fields: [{ name: 'a', label: '名称' }, { name: 'b' }, { name: 'c' }], answers: { a: '砚', b: ['x', 'y'] }, answer: '{}' }
  })
  assert.equal(model.state, 'answered')
  assert.equal(model.answer, null)
  assert.deepEqual(model.pairs, [{ label: '名称', value: '砚' }, { label: 'b', value: 'x、y' }])
})

check('高亮：超限回退纯文本', () => {
  assert.equal(highlight.exceedsHighlightLimits('const a = 1\n'), false)
  assert.equal(highlight.exceedsHighlightLimits('x'.repeat(highlight.HIGHLIGHT_MAX_CHARS + 1)), true)
  assert.equal(highlight.exceedsHighlightLimits('a\n'.repeat(highlight.HIGHLIGHT_MAX_LINES + 1)), true)
  assert.equal(highlight.exceedsHighlightLimits('y'.repeat(highlight.HIGHLIGHT_MAX_LINE_CHARS + 1)), true)
  assert.equal(highlight.highlightTree('a\n'.repeat(highlight.HIGHLIGHT_MAX_LINES + 1), 'ts'), null)
})

check('高亮：别名可用，未知语言不高亮', () => {
  assert.equal(highlight.highlightLanguage('TS'), 'ts')
  assert.equal(highlight.highlightLanguage('pwsh'), 'pwsh')
  assert.equal(highlight.highlightLanguage('nope-lang'), null)
  const tree = highlight.highlightTree('const a = 1', 'ts')
  assert.ok(tree && tree.type === 'root')
  assert.ok(JSON.stringify(tree).includes('hljs-keyword'))
})

check('高亮：超大代码块打上 no-highlight 标记', () => {
  const big = 'x'.repeat(highlight.HIGHLIGHT_MAX_CHARS + 1)
  const code = { type: 'element', tagName: 'code', properties: { className: ['language-ts'] }, children: [{ type: 'text', value: big }] }
  const small = { type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: 'ok' }] }
  const tree = { type: 'root', children: [{ type: 'element', tagName: 'pre', properties: {}, children: [code] }, { type: 'element', tagName: 'pre', properties: {}, children: [small] }] }
  highlight.rehypeMarkOversizedCode()(tree)
  assert.deepEqual(code.properties.className, ['language-ts', 'no-highlight'])
  assert.equal(code.properties.dataHighlight, 'plain')
  assert.equal(small.properties.dataHighlight, undefined)
})

check('公式：只在像 TeX 的内容上按需加载', () => {
  assert.equal(math.needsMath('价格 $5 和 $10'), false)
  assert.equal(math.needsMath('$$\\int_0^1 x\\,dx$$'), true)
  assert.equal(math.needsMath('设 $x^2 + y^2 = 1$。'), true)
  assert.equal(math.needsMath('变量 $PATH 与 $HOME'), false)
  assert.equal(math.needsMath('没有美元符号'), false)
  assert.equal(math.mathLoadState(), 'idle')
})

check('公式：独占一段的 $$…$$ 按块级公式渲染', () => {
  const source = '$$x^2$$\n\n行内 $$y$$ 不变'
  const code = (start) => ({ type: 'element', tagName: 'code', properties: { className: ['language-math', 'math-inline'] }, position: { start: { offset: start } }, children: [{ type: 'text', value: 'x' }] })
  const alone = code(0)
  const mixed = code(source.indexOf('$$y'))
  const tree = { type: 'root', children: [
    { type: 'element', tagName: 'p', properties: {}, children: [alone] },
    { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: '行内 ' }, mixed, { type: 'text', value: ' 不变' }] }
  ] }
  math.rehypeDisplayDoubleDollar()(tree, { value: source })
  assert.deepEqual(alone.properties.className, ['language-math', 'math-display'])
  assert.deepEqual(mixed.properties.className, ['language-math', 'math-inline'])
  const single = code(0)
  math.rehypeDisplayDoubleDollar()({ type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children: [single] }] }, { value: '$x$' })
  assert.deepEqual(single.properties.className, ['language-math', 'math-inline'])
})

process.stdout.write(`\n${pass} 项通过\n`)
