#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-session-find-'))
const outfile = join(dir, 'session-find.mjs')
await build({ entryPoints: [join(ROOT, 'src/renderer/src/features/session/session-find.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' })
const model = await import(pathToFileURL(outfile).href)
const {
  collectFindText,
  matchFind,
  findStatusText,
  clampActiveIndex,
  centeringOffset,
  findStepQuery,
  sessionFindAction,
  sessionFindAllowed,
  FIND_INCLUDED,
  FIND_OMITTED,
  FIND_GUTTER
} = model
await rm(dir, { recursive: true, force: true })

let pass = 0
function check(label, fn) {
  fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

function text(data) {
  return { nodeType: 3, data, firstChild: null, nextSibling: null }
}

function element(tagName, children = [], attributes = {}) {
  const node = {
    nodeType: 1,
    tagName,
    attributes,
    firstChild: null,
    nextSibling: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
    }
  }
  let previous = null
  for (const child of children) {
    if (previous) previous.nextSibling = child
    else node.firstChild = child
    child.parentElement = node
    previous = child
  }
  return node
}

const rootOf = (children) => element('DIV', children)

check('块级元素之间插入分隔符，匹配不跨块', () => {
  const root = rootOf([element('P', [text('alpha')]), element('P', [text('beta')])])
  const { text: flat } = collectFindText(root)
  assert.equal(flat, 'alpha\0beta')
  assert.equal(matchFind(root, 'alphabeta').length, 0)
  assert.equal(matchFind(root, 'alpha').length, 1)
})

check('行内元素不切断连续文本', () => {
  const root = rootOf([element('P', [text('run '), element('CODE', [text('pnpm test')]), text(' now')])])
  assert.equal(collectFindText(root).text, 'run pnpm test now')
  const matches = matchFind(root, 'pnpm test now')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].startOffset, 0)
  assert.equal(matches[0].endNode, root.firstChild.firstChild.nextSibling.nextSibling)
})

check('跨节点的匹配给出首尾节点与偏移', () => {
  const lead = text('run ')
  const body = text('pnpm test')
  const code = element('CODE', [body])
  const root = rootOf([element('P', [lead, code, text(' now')])])
  const [match] = matchFind(root, 'run pnpm')
  assert.equal(match.startNode, lead)
  assert.equal(match.startOffset, 0)
  assert.equal(match.endNode, body)
  assert.equal(match.endOffset, 4)
})

check('大小写不敏感，多处命中按文档顺序', () => {
  const root = rootOf([element('P', [text('Alpha alpha')])])
  const matches = matchFind(root, 'ALPHA')
  assert.deepEqual(matches.map((match) => match.startOffset), [0, 6])
})

check('空查询与无匹配', () => {
  const root = rootOf([element('P', [text('alpha')])])
  assert.deepEqual(matchFind(root, ''), [])
  assert.equal(findStatusText('', 0, 0), '')
  assert.equal(findStatusText('zzz', 0, 0), '0/0')
  assert.equal(findStatusText('al', 2, 4), '2/4')
})

check('跳过 aria-hidden、hidden 与 sr-only 子树', () => {
  const root = rootOf([
    element('P', [text('visible '), element('SPAN', [text('secret')], { 'aria-hidden': 'true' })]),
    element('P', [text('kept')]),
    element('P', [text('gone')], { hidden: '' }),
    element('P', [text('label')], { class: 'sr-only' })
  ])
  const { text: flat } = collectFindText(root)
  assert.ok(!flat.includes('secret'), flat)
  assert.ok(!flat.includes('gone'), flat)
  assert.ok(!flat.includes('label'), flat)
  assert.ok(flat.includes('kept'), flat)
  assert.equal(matchFind(root, 'secret').length, 0)
})

check('data-find-omitted 与 data-find-included', () => {
  const hiddenTail = element('DIV', [text('keep-me')], { [FIND_INCLUDED]: '' })
  const root = rootOf([
    element('P', [text('head')]),
    element('DIV', [text('omitted'), hiddenTail], { [FIND_OMITTED]: '' })
  ])
  const { text: flat } = collectFindText(root)
  assert.ok(!flat.includes('omitted'), flat)
  assert.ok(flat.includes('keep-me'), flat)
})

check('data-gutter 切断文本', () => {
  const root = rootOf([element('DIV', [text('left'), element('SPAN', [text('1')], { [FIND_GUTTER]: '' }), text('right')])])
  assert.equal(collectFindText(root).text, 'left\0right')
  assert.equal(matchFind(root, 'leftright').length, 0)
})

check('exclude 集合里的节点被跳过', () => {
  const bar = element('DIV', [text('find bar')])
  const root = rootOf([element('DIV', [text('body'), bar, text('tail')])])
  const flat = collectFindText(root, new Set([bar])).text
  assert.ok(!flat.includes('find bar'), flat)
})

check('活动下标裁剪与步进语义的边界', () => {
  assert.equal(clampActiveIndex(3, 2), 1)
  assert.equal(clampActiveIndex(-2, 2), 0)
  assert.equal(clampActiveIndex(0, 0), -1)
})

check('居中偏移只在匹配完全不可见时给出', () => {
  const bounds = { top: 100, bottom: 300 }
  assert.equal(centeringOffset({ top: 120, height: 20 }, bounds), null)
  assert.equal(centeringOffset({ top: 400, height: 20 }, bounds), 400 + 10 - 200)
  assert.equal(centeringOffset({ top: 60, height: 20 }, bounds), 60 + 10 - 200)
})

check('快捷键映射：Ctrl+F 打开，Ctrl+G 与 F3 步进，Esc 关闭', () => {
  const base = { ctrl: false, meta: false, alt: false, shift: false, open: false }
  assert.equal(sessionFindAction({ ...base, key: 'f', ctrl: true }, false), 'open')
  assert.equal(sessionFindAction({ ...base, key: 'F', meta: true }, true), 'open')
  assert.equal(sessionFindAction({ ...base, key: 'g', ctrl: true, open: true }, false), 'next')
  assert.equal(sessionFindAction({ ...base, key: 'G', ctrl: true, shift: true, open: true }, false), 'prev')
  assert.equal(sessionFindAction({ ...base, key: 'F3', open: true }, false), 'next')
  assert.equal(sessionFindAction({ ...base, key: 'F3', shift: true, open: true }, false), 'prev')
  assert.equal(sessionFindAction({ ...base, key: 'Escape', open: true }, false), 'close')
})

check('快捷键映射：关闭时步进键不生效，组合键与输入法期间不抢键', () => {
  const base = { ctrl: false, meta: false, alt: false, shift: false, open: false }
  assert.equal(sessionFindAction({ ...base, key: 'g', ctrl: true }, false), null)
  assert.equal(sessionFindAction({ ...base, key: 'Escape' }, false), null)
  assert.equal(sessionFindAction({ ...base, key: 'f', ctrl: true, open: true, composing: true }, false), null)
  assert.equal(sessionFindAction({ ...base, key: 'f', ctrl: true, open: true, defaultPrevented: true }, false), null)
  assert.equal(sessionFindAction({ ...base, key: 'f', ctrl: true, alt: true, open: true }, false), null)
  assert.equal(sessionFindAction({ ...base, key: 'g', ctrl: true, alt: true, open: true }, false), null)
  assert.equal(sessionFindAction({ ...base, key: 'f', ctrl: true, open: true }, true), null)
})

check('去抖未完成时回车用输入框当前值步进', () => {
  assert.equal(findStepQuery('abc', ''), 'abc', '旧词为空时按新输入搜索')
  assert.equal(findStepQuery('abc', 'old'), 'abc', '旧词非空时同样按新输入')
  assert.equal(findStepQuery('', 'old'), '', '清空输入后步进会清空搜索')
  assert.equal(findStepQuery(undefined, 'old'), 'old', '输入框不在时退回已搜索词')
})

check('焦点在会话区外（输入框）也能 Ctrl+F 打开，模态层打开时不抢键', () => {
  const base = { own: false, inConversation: false, inComposer: false, idle: false, open: false, modalOpen: false }
  assert.equal(sessionFindAllowed('open', base), false, '预览/终端等外部区域不抢键')
  assert.equal(sessionFindAllowed('open', { ...base, idle: true }), true, '无焦点时打开')
  assert.equal(sessionFindAllowed('open', { ...base, inComposer: true }), true, '焦点在输入框时打开')
  assert.equal(sessionFindAllowed('open', { ...base, inConversation: true }), true, '焦点在会话区内时打开')
  assert.equal(sessionFindAllowed('open', { ...base, inComposer: true, modalOpen: true }), false, '模态层下不打开')
  assert.equal(sessionFindAllowed('open', { ...base, own: true, modalOpen: true }), false, '模态层下不抓回焦点')
  assert.equal(sessionFindAllowed('next', base), false, '关闭时步进键不生效')
  assert.equal(sessionFindAllowed('next', { ...base, open: true }), true, '查找条开着即可步进')
  assert.equal(sessionFindAllowed('prev', { ...base, inComposer: true }), true, '焦点在输入框可步进')
  assert.equal(sessionFindAllowed('close', { ...base, open: true, modalOpen: true }), true, '模态层下仍可关闭')
  assert.equal(sessionFindAllowed(null, base), false)
})

process.stdout.write(`\n${pass} passed\n`)
