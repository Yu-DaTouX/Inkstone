#!/usr/bin/env node
import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dir = await mkdtemp(join(tmpdir(), 'yan-browser-driver-'))

async function load(name, entry, external = []) {
  const outfile = join(dir, `${name}.mjs`)
  await build({ entryPoints: [join(ROOT, entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', external })
  return import(pathToFileURL(outfile).href)
}

const elements = await load('element-registry', 'src/main/browser/ElementRegistry.ts')
const keyboard = await load('keyboard', 'src/main/browser/driver/keyboard.ts')
const scroll = await load('scroll-motion', 'src/main/browser/driver/scroll-motion.ts')
const { AgentCursor } = await load('agent-cursor', 'src/main/browser/AgentCursor.ts')
const { InputController, HIT_TEST_FN, READ_VALUE_FN } = await load('input', 'src/main/browser/InputController.ts')
await rm(dir, { recursive: true, force: true })

let pass = 0
function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`)
}
async function check(label, fn) {
  await fn()
  pass += 1
  process.stdout.write(`  ✓ ${label}\n`)
}

await check('元素引用：同一文档里同一节点保持同一个 ref，消失的节点不再可解析', () => {
  const registry = new elements.ElementRegistry()
  const node = (backendNodeId, name) => ({ backendNodeId, role: 'button', name, box: [0, 0, 10, 10], frameId: 'main' })
  const first = registry.refresh([node(11, 'A'), node(12, 'B')])
  const second = registry.refresh([node(13, 'C'), node(12, 'B')])
  assert.equal(first.generationId, second.generationId)
  assert.equal(second.refs[1], first.refs[1])
  assert.notEqual(second.refs[0], first.refs[0])
  assert.equal(registry.resolve(first.refs[1]).name, 'B')
  assert.throws(() => registry.resolve(first.refs[0]), /元素引用已失效/)
})

await check('元素引用：不同 frame 的同号节点不混用，导航清空后整体换代', () => {
  const registry = new elements.ElementRegistry()
  const a = registry.refresh([{ backendNodeId: 5, role: 'link', name: 'x', box: [0, 0, 1, 1], frameId: 'main' }, { backendNodeId: 5, role: 'link', name: 'y', box: [0, 0, 1, 1], frameId: 'child', sessionId: 's1' }])
  assert.notEqual(a.refs[0], a.refs[1])
  registry.clear()
  const b = registry.refresh([{ backendNodeId: 5, role: 'link', name: 'x', box: [0, 0, 1, 1], frameId: 'main' }])
  assert.notEqual(b.generationId, a.generationId)
  assert.throws(() => registry.resolve(a.refs[0]), /元素引用已失效/)
  assert.throws(() => registry.resolve(a.refs[1]), /元素引用已失效/)
  assert.deepEqual(a.refs, [`${registry.tag}1`, `${registry.tag}2`])
  assert.equal(b.refs[0], `${registry.tag}3`)
})

await check('元素引用：短编号带随机标签，换代后编号不复用，旧编号报失效而不是指向新节点', () => {
  const registry = new elements.ElementRegistry('kq')
  const node = (backendNodeId) => ({ backendNodeId, role: 'button', name: String(backendNodeId), box: [0, 0, 1, 1], frameId: 'main' })
  const first = registry.refresh([node(1), node(2)])
  assert.deepEqual(first.refs, ['kq1', 'kq2'])
  const key = registry.generationKey()
  registry.clear()
  assert.notEqual(registry.generationKey(), key)
  const second = registry.refresh([node(9), node(8), node(7)])
  assert.deepEqual(second.refs, ['kq3', 'kq4', 'kq5'])
  assert.throws(() => registry.resolve('kq1'), /元素引用已失效/)
  assert.equal(registry.resolve('kq4').backendNodeId, 8)
})

await check('元素引用：不同 registry（另一标签、另一会话或重启后新建）的 ref 互不撞号', () => {
  const node = (backendNodeId) => ({ backendNodeId, role: 'button', name: String(backendNodeId), box: [0, 0, 1, 1], frameId: 'main' })
  const registries = Array.from({ length: 300 }, () => new elements.ElementRegistry())
  const tags = new Set(registries.map((registry) => registry.tag))
  assert.equal(tags.size, registries.length, '同一进程里标签不重复')
  assert.ok([...tags].every((tag) => /^[a-z]{3}$/.test(tag)), '标签是 3 个字母，编号仍然短')
  const [a, b] = registries
  const refA = a.refresh([node(5)]).refs[0]
  const refB = b.refresh([node(5)]).refs[0]
  assert.notEqual(refA, refB)
  assert.throws(() => b.resolve(refA), /元素引用已失效/)
  assert.throws(() => a.resolve(refB), /元素引用已失效/)
})

await check('键盘：esc / space / del 别名与标点键有正确的键码', () => {
  assert.equal(keyboard.parseKeyChord('esc').key, 'Escape')
  assert.equal(keyboard.parseKeyChord('Space').spec.code, 'Space')
  assert.equal(keyboard.parseKeyChord('del').key, 'Delete')
  assert.deepEqual(keyboard.keyDefinition('/'), { vk: 191, key: '/', code: 'Slash', text: '/' })
  assert.equal(keyboard.parseKeyChord('Shift+Tab').modifiers, keyboard.MODIFIER_BITS.Shift)
  assert.throws(() => keyboard.parseKeyChord('Shift+Nope'), /未知按键/)
})

await check('键盘：按键规格表与单字符规格', () => {
  assert.deepEqual(keyboard.keyDefinition('Enter'), { vk: 13, key: 'Enter', code: 'Enter', text: '\r' })
  assert.deepEqual(keyboard.keyDefinition('a'), { vk: 65, key: 'a', code: 'KeyA', text: 'a' })
  assert.deepEqual(keyboard.keyDefinition('7'), { vk: 55, key: '7', code: 'Digit7', text: '7' })
  assert.deepEqual(keyboard.keyDefinition('~'), { vk: 126, key: '~', code: '~', text: '~' })
  assert.deepEqual(keyboard.keyDefinition(' '), { vk: 32, key: ' ', code: 'Space', text: ' ' })
})

await check('键盘：Control+Shift+A 解析为主键 A 加 Ctrl|Shift 掩码', () => {
  assert.deepEqual({ ...keyboard.MODIFIER_BITS }, { Alt: 1, Control: 2, Meta: 4, Shift: 8 })
  const chord = keyboard.parseKeyChord('Control+Shift+A')
  assert.equal(chord.key, 'A')
  assert.equal(chord.spec.code, 'KeyA')
  assert.equal(chord.spec.vk, 65)
  assert.equal(chord.modifiers, 10)
  assert.deepEqual(chord.modifierKeys, ['Control', 'Shift'])
  assert.equal(keyboard.parseKeyChord('alt+arrowdown').spec.code, 'ArrowDown')
  assert.equal(keyboard.parseKeyChord('Enter').modifiers, 0)
})

await check('键盘：ControlOrMeta 按平台解析，+ 号可作按键', () => {
  assert.equal(keyboard.parseKeyChord('ControlOrMeta+V', 'darwin').modifiers, 4)
  assert.equal(keyboard.parseKeyChord('ControlOrMeta+V', 'win32').modifiers, 2)
  assert.deepEqual(keyboard.splitChord('Control++'), ['Control', '+'])
  assert.deepEqual(keyboard.splitChord('+'), ['+'])
  assert.throws(() => keyboard.splitChord('Control+'), /格式无效/)
  assert.throws(() => keyboard.splitChord(''), /不能为空/)
  assert.throws(() => keyboard.parseKeyChord('Control+Shift'), /缺少主键/)
  assert.throws(() => keyboard.parseKeyChord('Control+A+B'), /只能有一个主键/)
  assert.throws(() => keyboard.parseKeyChord('Control+nope'), /未知按键/)
})

await check('键盘：组合键按 按下修饰键 → 主键 → 抬起 顺序派发，异常也释放修饰键', async () => {
  const calls = []
  const services = {
    async cdp(method, params, sessionId) {
      calls.push({ method, params, sessionId })
    },
    async sleep() {}
  }
  await keyboard.pressKey(services, 'Control+Shift+A', { sessionId: 's1' })
  assert.deepEqual(calls.map((call) => [call.method, call.params.type, call.params.key, call.params.modifiers]), [
    ['Input.dispatchKeyEvent', 'rawKeyDown', 'Control', 2],
    ['Input.dispatchKeyEvent', 'rawKeyDown', 'Shift', 10],
    ['Input.dispatchKeyEvent', 'rawKeyDown', 'A', 10],
    ['Input.dispatchKeyEvent', 'keyUp', 'A', 10],
    ['Input.dispatchKeyEvent', 'keyUp', 'Shift', 2],
    ['Input.dispatchKeyEvent', 'keyUp', 'Control', 0]
  ])
  assert.equal(calls[2].params.text, undefined)
  assert.equal(calls[2].params.windowsVirtualKeyCode, 65)
  assert.ok(calls.every((call) => call.sessionId === 's1'))

  calls.length = 0
  await keyboard.pressKey(services, 'A')
  assert.deepEqual(calls.map((call) => call.params.type), ['keyDown', 'keyUp'])
  assert.equal(calls[0].params.text, 'A')
  assert.equal(calls[0].params.unmodifiedText, 'A')

  calls.length = 0
  const failing = {
    async cdp(_method, params) {
      calls.push(params)
      if (params.key === 'A') throw new Error('boom')
    },
    async sleep() {}
  }
  await assert.rejects(keyboard.pressKey(failing, 'Control+A'), /boom/)
  assert.deepEqual(calls.map((params) => [params.type, params.key]), [
    ['rawKeyDown', 'Control'],
    ['rawKeyDown', 'A'],
    ['keyUp', 'A'],
    ['keyUp', 'Control']
  ])
})

await check('键盘：insertText 走注入的 cdp', async () => {
  const calls = []
  await keyboard.typeText({ async cdp(...args) { calls.push(args) }, async sleep() {} }, '你好', 's3')
  assert.deepEqual(calls, [['Input.insertText', { text: '你好' }, 's3']])
  await assert.rejects(keyboard.typeText({ async cdp() {}, async sleep() {} }, 42), /字符串/)
})

await check('滚动：小位移单次派发，大位移分段且总量守恒', () => {
  const small = scroll.wheelSteps({ x: 1, y: 2, deltaX: 0, deltaY: 120 })
  assert.equal(small.length, 1)
  assert.deepEqual(small[0], { deltaX: 0, deltaY: 120 })

  const big = scroll.wheelSteps({ x: 0, y: 0, deltaX: 0, deltaY: 2000 })
  assert.equal(big.length, scroll.MAX_STEPS)
  close(big.reduce((sum, step) => sum + step.deltaY, 0), 2000, '总量守恒')
  assert.ok(big.every((step) => step.deltaY > 0))
  assert.ok(big[6].deltaY > big[0].deltaY, '缓入起步小，中段最大')

  const two = scroll.wheelSteps({ x: 0, y: 0, deltaX: 0, deltaY: 121 })
  assert.equal(two.length, 2)
  close(two.reduce((sum, step) => sum + step.deltaY, 0), 121, '总量守恒')
})

await check('滚动：反方向与双轴位移同样守恒，步数按最长轴计算', () => {
  const up = scroll.wheelSteps({ x: 0, y: 0, deltaX: -30, deltaY: -400 })
  assert.equal(up.length, 5)
  close(up.reduce((sum, step) => sum + step.deltaY, 0), -400, '总量守恒')
  assert.ok(up.every((step) => step.deltaY < 0))
  const diagonal = scroll.wheelSteps({ x: 0, y: 0, deltaX: 600, deltaY: 40 })
  assert.equal(diagonal.length, Math.min(scroll.MAX_STEPS, Math.ceil(600 / scroll.PIXELS_PER_STEP)))
  close(diagonal.reduce((sum, step) => sum + step.deltaX, 0), 600, 'deltaX 守恒')
  close(diagonal.reduce((sum, step) => sum + step.deltaY, 0), 40, 'deltaY 守恒')
  assert.deepEqual(scroll.wheelSteps({ x: 0, y: 0, deltaX: 0, deltaY: 0 }), [{ deltaX: 0, deltaY: 0 }])
})

await check('滚动：经注入的 cdp 派发鼠标滚轮事件，段间 sleep', async () => {
  const calls = []
  const sleeps = []
  const services = {
    async cdp(method, params, sessionId) {
      calls.push({ method, params, sessionId })
    },
    async sleep(ms) {
      sleeps.push(ms)
    }
  }
  await scroll.dispatchWheelMotion(services, { x: 10, y: 20, deltaX: 0, deltaY: 400, modifiers: 8 }, 's2')
  assert.equal(calls.length, 5)
  assert.ok(calls.every((call) => call.method === 'Input.dispatchMouseEvent' && call.sessionId === 's2'))
  const first = calls[0].params
  assert.deepEqual(Object.keys(first).sort(), ['deltaX', 'deltaY', 'modifiers', 'type', 'x', 'y'])
  assert.equal(first.type, 'mouseWheel')
  assert.equal(first.x, 10)
  assert.equal(first.y, 20)
  assert.equal(first.modifiers, 8)
  assert.equal(first.deltaX, 0)
  close(calls[0].params.deltaY, 41.6, '缓入首段')
  close(calls[2].params.deltaY, 118.4, '中段最大')
  close(calls[4].params.deltaY, 41.6, '缓出末段')
  close(calls.reduce((sum, call) => sum + call.params.deltaY, 0), 400, '派发总量守恒')
  assert.deepEqual(sleeps, [scroll.STEP_INTERVAL_MS, scroll.STEP_INTERVAL_MS, scroll.STEP_INTERVAL_MS, scroll.STEP_INTERVAL_MS])

  calls.length = 0
  await scroll.dispatchWheelMotion(services, { x: 0, y: 0, deltaX: 0, deltaY: 50 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.modifiers, 0)
  assert.equal(calls[0].sessionId, undefined)
})

await check('Agent 光标：在隔离世界绘制，不拦截鼠标且支持清除', async () => {
  const calls = []
  const cdp = { async send(method, params) {
    calls.push({ method, params })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
    return {}
  } }
  const cursor = new AgentCursor(cdp)
  await cursor.show('点击', { x: 40, y: 60 })
  const render = calls.find(call => call.method === 'Runtime.evaluate').params
  assert.equal(render.contextId, 17)
  assert.match(render.expression, /pointer-events:none/)
  assert.match(render.expression, /aria-hidden/)
  assert.match(render.expression, /mode: 'closed'/)
  assert.match(render.expression, /prefers-reduced-motion/)
  assert.ok(render.expression.endsWith('(\"点击\",{\"x\":40,\"y\":60})'))
  new Function(render.expression)
  await cursor.hide()
  assert.ok(calls.at(-1).params.expression.endsWith('(\"\",null)'))
  await new AgentCursor({ async send() { throw new Error('target closed') } }).show('点击')
})

await check('Agent 光标：跨进程 iframe 映射到主页面，不显示输入内容', async () => {
  const calls = []
  const cdp = { async send(method, params, sessionId) {
    calls.push({ method, params, sessionId })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
    if (method === 'DOM.getBoxModel') return { model: { content: [1, 2, 21, 2, 21, 22, 1, 22] } }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'fixture' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: { picker: false } } }
    if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.visibilityState' ? 'visible' : undefined } }
    return {}
  } }
  const input = new InputController(cdp)
  const element = { ref: 'fixture', backendNodeId: 1, sessionId: 'child', frameOffset: [100, 200], box: [101, 202, 20, 20] }
  await input.click(element)
  const rendered = calls.find(call => call.method === 'Runtime.evaluate' && call.params.contextId === 17)
  assert.ok(rendered.params.expression.endsWith('(\"点击\",{\"x\":111,\"y\":212})'))
  const pressed = calls.find(call => call.params?.type === 'mousePressed')
  assert.equal(pressed.params.x, 11)
  assert.equal(pressed.params.y, 12)
  assert.equal(pressed.sessionId, 'child')
  await input.type(element, 'fixture-private-input')
  assert.ok(calls.filter(call => call.params?.contextId === 17).every(call => !call.params.expression.includes('fixture-private-input')))
})

await check('点击：目标被遮挡时不派发鼠标事件，直接报遮挡者', async () => {
  const calls = []
  let blocked = true
  const cdp = { async send(method, params, sessionId) {
    calls.push({ method, params, sessionId })
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } }
    if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 110, 10, 110, 40, 10, 40]] }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } }
    if (method === 'Runtime.callFunctionOn') return { result: { value: blocked ? { index: -1, blocker: 'div#consent "Accept all"' } : { index: 0 } } }
    if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.visibilityState' ? 'visible' : undefined } }
    return {}
  } }
  const input = new InputController(cdp)
  const element = { ref: 'e4', backendNodeId: 4, box: [10, 10, 100, 30] }
  await assert.rejects(input.click(element), (error) => error.code === 'ELEMENT_OBSCURED' && /e4/.test(error.message) && /div#consent/.test(error.message))
  assert.equal(calls.some((call) => call.method === 'Input.dispatchMouseEvent'), false)
  blocked = false
  calls.length = 0
  await input.click(element)
  assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent').length, 3)
})

await check('输入：type 回执里密码、卡号、验证码字段的值只表示已填', () => {
  const read = new Function(`return (${READ_VALUE_FN})`)()
  const field = (type, autocomplete, value) => ({ type, value, getAttribute: (name) => (name === 'autocomplete' ? autocomplete : null) })
  assert.equal(read.call(field('password', null, 'hunter2')), '\u2022\u2022\u2022\u2022')
  assert.equal(read.call(field('text', 'cc-number', '4111')), '\u2022\u2022\u2022\u2022')
  assert.equal(read.call(field('text', 'one-time-code', '123456')), '\u2022\u2022\u2022\u2022')
  assert.equal(read.call(field('text', 'cc-exp', '')), '')
  assert.equal(read.call(field('text', 'email', 'a@b.c')), 'a@b.c')
})

await check('点击：遮挡判定先找命中目标本身的点，祖先只在找不到时接受且不含 html / body', () => {
  const hitTest = new Function(`return (${HIT_TEST_FN})`)()
  const node = (tag, parent, extra = {}) => {
    const n = { tagName: tag.toUpperCase(), id: '', className: '', parent, textContent: '', ...extra }
    n.getAttribute = () => null
    n.contains = (other) => { for (let x = other; x; x = x.parent) if (x === n) return true; return false }
    n.closest = (sel) => { for (let x = n; x; x = x.parent) if (x.tagName.toLowerCase() === sel) return x; return null }
    return n
  }
  const page = (pick) => {
    const html = node('html', null)
    const body = node('body', html, { textContent: 'Please accept cookies' })
    const doc = { documentElement: html, body, scrollingElement: html }
    const parts = pick({ html, body, doc })
    doc.elementFromPoint = (x) => parts.hits[x] ?? null
    parts.target.ownerDocument = doc
    parts.target.getRootNode = () => doc
    return parts
  }
  const points = [[0, 0], [1, 0], [2, 0]]

  const overlay = page(({ body }) => {
    const target = node('button', body)
    return { target, hits: [body, body, body] }
  })
  const blocked = hitTest.call(overlay.target, points)
  assert.equal(blocked.index, -1, 'body::after 一类的祖先伪元素遮罩算遮挡')
  assert.match(blocked.blocker, /^body/)

  const passThrough = page(({ html, body }) => {
    const target = node('span', body)
    return { target, hits: [html, body, html] }
  })
  assert.equal(hitTest.call(passThrough.target, points).index, -1, 'pointer-events:none 的目标只命中 html / body 时算遮挡')

  const wrapped = page(({ body }) => {
    const card = node('div', body)
    const target = node('span', card)
    return { target, hits: [card, card, card] }
  })
  assert.equal(hitTest.call(wrapped.target, points).index, 0, '只命中普通祖先时接受（点击会落到包着它的元素上）')

  const later = page(({ body }) => {
    const card = node('div', body)
    const target = node('button', card)
    const icon = node('i', target)
    return { target, hits: [card, card, icon] }
  })
  assert.equal(hitTest.call(later.target, points).index, 2, '第一个点命中祖先、后面的点命中目标后代时，用命中目标的点')

  const labelled = page(({ body }) => {
    const label = node('label', body)
    const text = node('span', label)
    const target = node('input', body)
    label.control = target
    return { target, hits: [text, text, text] }
  })
  assert.equal(hitTest.call(labelled.target, points).index, 0, '点到自己的 label 不算遮挡')

  const otherLabel = page(({ body }) => {
    const label = node('label', body)
    const text = node('span', label, { textContent: 'Other' })
    const target = node('input', body)
    label.control = node('input', body)
    return { target, hits: [text, text, text] }
  })
  const other = hitTest.call(otherLabel.target, points)
  assert.equal(other.index, -1, '别的控件的 label 挡住时算遮挡')
  assert.match(other.blocker, /^span "Other"/)
})

process.stdout.write(`\n${pass} 项通过\n`)
