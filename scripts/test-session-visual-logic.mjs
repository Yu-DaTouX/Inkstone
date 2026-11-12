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

const caret = await load('typing-caret', 'src/renderer/src/features/session/typing-caret.ts')
const follow = await load('scroll-follow', 'src/renderer/src/features/session/scroll-follow.ts')
const position = await load('scroll-position', 'src/renderer/src/features/session/scroll-position.ts')
const disclosure = await load('disclosure-scroll', 'src/renderer/src/ui/disclosure-scroll.ts')
const tailHold = await load('stream-tail-hold', 'src/renderer/src/features/session/stream-tail-hold.ts')
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

check('收起：只把视口上方且仍为收起态的标题带回视口', () => {
  const previous = globalThis.requestAnimationFrame
  const frames = []
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length }
  try {
    const stream = { scrollTop: 100, getBoundingClientRect: () => ({ top: 10 }) }
    const head = { isConnected: true, expanded: 'true', top: -80, closest: () => stream, getBoundingClientRect() { return { top: this.top } }, getAttribute() { return this.expanded } }
    disclosure.revealCollapsedHeader(head)
    assert.equal(frames.length, 1)
    head.expanded = 'false'
    frames.shift()()
    assert.equal(stream.scrollTop, 10)
    head.top = 20
    disclosure.revealCollapsedHeader(head)
    assert.equal(frames.length, 0)
    head.top = -80
    disclosure.revealCollapsedHeader(head)
    head.expanded = 'true'
    frames.shift()()
    assert.equal(stream.scrollTop, 10)
    disclosure.revealCollapsedHeader(head)
    head.expanded = 'false'
    head.isConnected = false
    frames.shift()()
    assert.equal(stream.scrollTop, 10)
    disclosure.revealCollapsedHeader(null)
  } finally {
    globalThis.requestAnimationFrame = previous
  }
})

check('历史代码块复用高亮处理器后语言别名、纯文本与超限跳过保持一致', () => {
  const make = (classes, text) => ({ type: 'root', children: [{ type: 'element', tagName: 'pre', properties: {}, children: [{ type: 'element', tagName: 'code', properties: { className: classes }, children: [{ type: 'text', value: text }] }] }] })
  for (const [classes, text] of [[['language-ts'], 'const answer: number = 42'], [['language-pwsh'], 'Get-Item .'], [['language-unknown'], 'plain'], [['language-js', 'no-highlight'], 'const value = 1'], [[], 'plain']]) {
    const fresh = make(classes, text)
    const shared = structuredClone(fresh)
    highlight.rehypeHighlight(highlight.highlightOptions)(fresh, { message() {} })
    highlight.rehypeMessageHighlight()(shared, { message() {} })
    assert.deepEqual(shared, fresh)
  }
  const tree = make(['language-js'], 'a'.repeat(highlight.HIGHLIGHT_MAX_CHARS + 1))
  highlight.rehypeMarkOversizedCode()(tree)
  highlight.rehypeMessageHighlight()(tree, { message() {} })
  assert.equal(tree.children[0].children[0].children[0].type, 'text')
})

const el = (tagName, children = [], properties = {}) => ({ type: 'element', tagName, properties, children })
const text = (value) => ({ type: 'text', value })
const hasCaret = (node) => node.children?.at(-1)?.properties?.className?.includes('v3-caret') === true

check('打字光标：跟在最后一段文字末尾，进入列表与行内元素', () => {
  const p = el('p', [text('abc'), el('strong', [text('de')]), text('\n')])
  const tree = { type: 'root', children: [el('p', [text('first')]), p, text('\n')] }
  caret.rehypeTypingCaret()(tree)
  assert.ok(hasCaret(p.children[1]))
  assert.ok(!hasCaret(tree.children[0]))
  const li = el('li', [text('item')])
  const list = { type: 'root', children: [el('ul', [text('\n'), li, text('\n')])] }
  caret.rehypeTypingCaret()(list)
  assert.ok(hasCaret(li))
  assert.equal(li.children.at(-1).children[0].value, '\u258d')
})

check('打字光标：末尾是代码块、表格或公式时不加', () => {
  for (const last of [el('pre', [el('code', [text('x')])]), el('table', [el('tr', [el('td', [text('a')])])]), el('span', [text('x')], { className: ['katex'] })]) {
    const tree = { type: 'root', children: [el('p', [last])] }
    const before = JSON.stringify(tree)
    caret.rehypeTypingCaret()(tree)
    assert.equal(JSON.stringify(tree), before)
  }
  const empty = { type: 'root', children: [text('\n')] }
  caret.rehypeTypingCaret()(empty)
  assert.equal(empty.children.length, 1)
})

check('尾部观察器：尺寸通知只排队，合并到下一帧写入，清理取消待处理帧', () => {
  const previous = { ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, getComputedStyle: globalThis.getComputedStyle }
  const frames = new Map()
  let next = 0
  let notify
  let disconnected = false
  globalThis.ResizeObserver = class {
    constructor(callback) { notify = callback }
    observe() {}
    disconnect() { disconnected = true }
  }
  globalThis.requestAnimationFrame = (fn) => { frames.set(++next, fn); return next }
  globalThis.cancelAnimationFrame = (id) => frames.delete(id)
  globalThis.getComputedStyle = () => ({ borderTopWidth: '0', borderBottomWidth: '0', paddingTop: '0', paddingBottom: '0', marginBottom: '0' })
  try {
    let height = 200
    const tail = { style: { minHeight: '' }, lastElementChild: { getBoundingClientRect: () => ({ bottom: 100 }) }, getBoundingClientRect: () => ({ top: 0, height }) }
    const scroller = { clientHeight: 300, getBoundingClientRect: () => ({ bottom: 300 }), addEventListener() {}, removeEventListener() {} }
    const release = tailHold.holdStreamTail(scroller, () => tail)
    assert.equal(tail.style.minHeight, '200px')
    height = 180
    notify()
    notify()
    assert.equal(frames.size, 1)
    assert.equal(tail.style.minHeight, '200px')
    const frame = [...frames.values()][0]
    frames.clear()
    frame()
    assert.equal(tail.style.minHeight, '180px')
    notify()
    release()
    assert.equal(frames.size, 0)
    assert.equal(tail.style.minHeight, '')
    assert.equal(disconnected, true)
  } finally {
    Object.assign(globalThis, previous)
  }
})

check('输入框高度变化：尾部占位重新按当前底部留白测量，不保持旧输入框高度', () => {
  const previous = { ResizeObserver: globalThis.ResizeObserver, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, getComputedStyle: globalThis.getComputedStyle }
  const frames = []
  let notify
  let padding = 100
  globalThis.ResizeObserver = class {
    constructor(callback) { notify = callback }
    observe() {}
    disconnect() {}
  }
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length }
  globalThis.cancelAnimationFrame = () => {}
  globalThis.getComputedStyle = () => ({ borderTopWidth: '0', borderBottomWidth: '0', paddingTop: '0', paddingBottom: String(padding), marginBottom: '0' })
  const tail = { style: { minHeight: '' }, lastElementChild: { getBoundingClientRect: () => ({ bottom: 100 }) }, getBoundingClientRect: () => ({ top: 0, height: Math.max(100 + padding, parseFloat(tail.style.minHeight) || 0) }) }
  const scroller = { clientHeight: 600, getBoundingClientRect: () => ({ bottom: 600 }), addEventListener() {}, removeEventListener() {} }
  let release
  try {
    release = tailHold.holdStreamTail(scroller, () => tail)
    assert.equal(tail.style.minHeight, '200px')
    padding = 300
    notify()
    frames.shift()()
    assert.equal(tail.style.minHeight, '400px')
    padding = 100
    notify()
    frames.shift()()
    assert.equal(tail.style.minHeight, '200px')
  } finally {
    release?.()
    Object.assign(globalThis, previous)
  }
})

check('运行中末行变矮：看得见的空白留住，视口下方的空白收回，最多留半屏', () => {
  assert.equal(tailHold.heldTailHeight(800, 700, 800, 600), 800)
  assert.equal(tailHold.heldTailHeight(800, 700, 760, 600), 760)
  assert.equal(tailHold.heldTailHeight(800, 700, 300, 600), 700)
  assert.equal(tailHold.heldTailHeight(800, 900, 800, 600), 900)
  assert.equal(tailHold.heldTailHeight(1400, 700, 1400, 600), 1000)
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
  const settled = follow.decideFollow(true, { offset: 900, size: 1500, viewport: 500 }, 4800, 5000, { offset: 1000, size: 1600, viewport: 500 })
  assert.deepEqual(settled, { stick: true, showJump: false, repin: true }, '刚滚到底时尾部变矮引起的位移不当作用户离开底部')
  const leftByUser = follow.decideFollow(true, { offset: 900, size: 1500, viewport: 500 }, 4800, 5000, { offset: 1000, size: 1500, viewport: 500 })
  assert.equal(leftByUser.stick, false, '高度未变时的位移仍按用户滚动处理')
})

check('跟随：没有用户操作时高度不变的上移也重新贴底（拖滚动条与查找跳转经用户意图解除）', () => {
  const moved = follow.decideFollow(true, { offset: 300, size: 1500, viewport: 500 }, null, 5000)
  assert.deepEqual(moved, { stick: true, showJump: false, repin: true })
  const dragged = follow.decideFollow(true, { offset: 300, size: 1500, viewport: 500 }, 4800, 5000)
  assert.deepEqual(dragged, { stick: false, showJump: true, repin: false })
  assert.equal(follow.SCROLL_INTENT_EVENT, 'yan-scroll-intent')
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

check('跟随：向下滚轮越过当前底部时明确恢复，不靠接近底部的容差', () => {
  const metrics = { offset: 700, size: 1500, viewport: 500 }
  assert.equal(follow.wheelReachesBottom(metrics, 3000, 0), true)
  assert.equal(follow.wheelReachesBottom(metrics, 100, 0), false)
  assert.equal(follow.wheelReachesBottom(metrics, -3000, 0), false)
  assert.equal(follow.wheelReachesBottom(metrics, 3000, 1), false)
  assert.equal(follow.wheelReachesBottom({ ...metrics, offset: 1000 }, 1, 1), true)
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
      { dataset: { turnId: 'a' }, children: [], getBoundingClientRect: () => ({ top: -300, bottom: -10 }) },
      { dataset: { turnId: 'b' }, children: [], getBoundingClientRect: () => ({ top: 80, bottom: 400 }) }
    ]
  }
  assert.deepEqual(position.domMetrics(box), { offset: 200, size: 2000, viewport: 500 })
  assert.deepEqual(position.domAnchor(box), { turnId: 'b', offset: 20, path: [], sub: 20 })
  position.restoreDomScroll(box, { top: 999, bottom: false, anchor: { turnId: 'b', offset: 40 } })
  assert.equal(box.scrollTop, 220, '保持相同回合及回合内偏移，不沿用不同视图的绝对位置')
  position.restoreDomScroll(box, { top: 333, bottom: false, anchor: { turnId: 'gone', offset: 0 } })
  assert.equal(box.scrollTop, 333, '锚点丢失时回退绝对位置')
  position.restoreDomScroll(box, { top: 0, bottom: true, anchor: null })
  assert.equal(box.scrollTop, 2000, '原来贴底的视图继续贴底')
})

check('滚动锚点：记录并按子块路径恢复回合内位置', () => {
  globalThis.HTMLElement = class {}
  const block = (top, bottom, children = []) => Object.assign(new globalThis.HTMLElement(), { children, getBoundingClientRect: () => ({ top, bottom, height: bottom - top }) })
  const inner = block(60, 160)
  const first = block(-200, 40)
  const second = block(40, 260, [inner])
  const turn = Object.assign(block(-200, 260, [first, second]), { dataset: { turnId: 't' } })
  const box = { getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => [turn] }
  const anchor = position.domAnchor(box)
  assert.deepEqual(anchor.path, [1, 0])
  assert.equal(anchor.sub, 40)
  assert.equal(position.resolveAnchorPoint(turn, anchor), 100)
  delete globalThis.HTMLElement
})

check('滚动锚点：一次读取兼顾被截断行和完整行，找到后停止扫描', () => {
  let reads = 0
  const nodes = Array.from({ length: 100 }, (_, index) => ({
    dataset: { turnId: `row-${index}` },
    children: [],
    getBoundingClientRect: () => {
      reads++
      return { top: 80 + index * 100, bottom: 180 + index * 100 }
    }
  }))
  const box = { getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => nodes }
  assert.deepEqual(position.domReadingAnchors(box), {
    snapshot: { turnId: 'row-0', offset: 20, path: [], sub: 20 },
    resize: { turnId: 'row-1', offset: 80 }
  })
  assert.equal(reads, 3)
  assert.deepEqual(position.domReadingAnchors({ ...box, querySelectorAll: () => [] }), { snapshot: null, resize: null })
  assert.deepEqual(position.domAnchor(box), { turnId: 'row-0', offset: 20, path: [], sub: 20 })
})

check('纯文字收尾也记录正文锚点，不依赖过程区', () => {
  const saved = globalThis.HTMLElement
  class Element { getBoundingClientRect() { return { top: 140 } } closest() { return null } }
  globalThis.HTMLElement = Element
  try {
    const answer = new Element()
    const turn = { querySelector: () => null, querySelectorAll: () => [answer] }
    const box = { querySelectorAll: () => [turn], getBoundingClientRect: () => ({ top: 100 }), clientHeight: 500 }
    assert.deepEqual(position.settleAnchor(box), { node: answer, top: 40 })
    const note = new Element()
    note.closest = () => ({})
    const earlier = new Element()
    turn.querySelectorAll = () => [note, earlier, answer]
    assert.equal(position.settleAnchor(box)?.node, answer)
  } finally { globalThis.HTMLElement = saved }
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
