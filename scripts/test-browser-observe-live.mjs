import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { build } from '../node_modules/esbuild/lib/main.js'

const OUT_DIR = '.tmp/browser-observe-live'
mkdirSync(OUT_DIR, { recursive: true })
await build({
  entryPoints: ['src/main/browser/Observer.ts'],
  outfile: `${OUT_DIR}/observer.mjs`,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'silent'
})

const { Observer, LIVE_STATE_FN } = await import(`../${OUT_DIR}/observer.mjs`)

const pageFn = new Function(`return (${LIVE_STATE_FN})`)()

const longText = 'x'.repeat(500)
const domTree = {
  nodeId: 1,
  nodeName: '#document',
  localName: '',
  backendNodeId: 1,
  children: [
    {
      nodeId: 2,
      nodeName: 'INPUT',
      localName: 'input',
      backendNodeId: 11,
      attributes: ['type', 'text', 'value', 'default@example.test', 'aria-label', '邮箱']
    },
    {
      nodeId: 3,
      nodeName: 'SELECT',
      localName: 'select',
      backendNodeId: 12,
      attributes: ['aria-label', '国家']
    },
    {
      nodeId: 4,
      nodeName: 'INPUT',
      localName: 'input',
      backendNodeId: 13,
      attributes: ['type', 'checkbox', 'aria-label', '同意条款']
    },
    {
      nodeId: 5,
      nodeName: 'TEXTAREA',
      localName: 'textarea',
      backendNodeId: 14,
      attributes: ['aria-label', '备注']
    },
    {
      nodeId: 6,
      nodeName: 'BUTTON',
      localName: 'button',
      backendNodeId: 15,
      attributes: ['aria-label', '提交']
    }
  ]
}

const liveNodes = {
  'obj-11': { tagName: 'INPUT', type: 'text', value: 'typed@example.test' },
  'obj-12': {
    tagName: 'SELECT',
    value: 'us',
    selectedIndex: 1,
    options: [
      { value: 'cn', label: '中国', text: '中国' },
      { value: 'us', label: '美国', text: '美国' }
    ]
  },
  'obj-13': { tagName: 'INPUT', type: 'checkbox', checked: true },
  'obj-14': { tagName: 'TEXTAREA', value: longText },
  'obj-15': { tagName: 'BUTTON', value: 'not-used' }
}

const resolvedFor = new Map()
const calls = []
const cdp = {
  on() {
    return () => {}
  },
  async send(method, params = {}, sessionId) {
    calls.push({ method, params, sessionId })
    if (method === 'DOM.getDocument') return { root: domTree }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root-frame', url: 'https://example.test/?q=secret' } } }
    if (method === 'Runtime.evaluate') return { result: { value: { text: '页面文本', url: 'https://example.test/?q=secret', title: '标题' } } }
    if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
    if (method === 'DOM.resolveNode') {
      const objectId = `obj-${params.backendNodeId}`
      resolvedFor.set(objectId, liveNodes[objectId])
      return { object: { objectId } }
    }
    if (method === 'Runtime.callFunctionOn') {
      const element = resolvedFor.get(params.objectId)
      const value = pageFn.call(element)
      return { result: { value } }
    }
    return {}
  }
}

const generations = []
const registry = {
  refresh(elements) {
    generations.push(elements)
    return `gen-${generations.length}`
  },
  resolve(ref) {
    const index = Number(String(ref).split(':e')[1]) - 1
    const element = generations[generations.length - 1][index]
    return { ...element, ref }
  }
}

const observer = new Observer(cdp, registry)
const observation = await observer.capture('https://example.test/', '标题')
observer.dispose()

const byName = new Map(observation.elements.map((element) => [element.name, element]))

const input = byName.get('邮箱')
assert(input, '输入框应该出现在观察结果里')
assert.equal(
  input.value,
  'typed@example.test',
  '输入框要读实时 value（用户输入/type 之后的值），不是 HTML 里的 value 属性'
)

const select = byName.get('国家')
assert(select, '下拉框应该出现在观察结果里')
assert.equal(select.value, 'us', '下拉框报告当前实时值（与 yan browser select --value 一致）')
assert(!select.value.includes('中国'), '没选中的 option 不该混进 value')

const checkbox = byName.get('同意条款')
assert(checkbox, '复选框应该出现在观察结果里')
assert.equal(checkbox.value, 'checked', '复选框要读实时 checked，而不是属性')

const textarea = byName.get('备注')
assert(textarea, '文本域应该出现在观察结果里')
assert.equal(textarea.value.length, 200, '实时值也要有长度上限，避免把超长文本灌进上下文')

const button = byName.get('提交')
assert(button, '按钮应该出现在观察结果里')
assert.equal(button.value, undefined, '按钮没有值就不该编一个值')
assert(!calls.some((call) => call.method === 'DOM.resolveNode' && call.params.backendNodeId === 15), '没有值的元素不必额外做一次实时读取')

assert.equal(
  Object.keys(input).sort().join(','),
  'box,disabled,frameId,frameUrl,name,ref,role,value',
  '观察结果里元素的字段结构保持不变'
)
assert(observation.url === 'https://example.test/?q=secret', 'URL 仍取自页面实时状态')
assert(observation.text === '页面文本', '页面文本不变')

const released = calls.filter((call) => call.method === 'Runtime.releaseObject').length
const resolved = calls.filter((call) => call.method === 'DOM.resolveNode').length
assert.equal(released, resolved, '每次实时读取都要释放远程对象')

{
  const el = {
    tagName: 'SELECT',
    value: 'cn',
    selectedIndex: 0,
    options: [
      { value: 'cn', text: '  \n 中国 ' },
      { value: 'us', text: '美国' }
    ]
  }
  const out = pageFn.call(el)
  assert.equal(out.kind, 'select')
  assert.equal(out.value, 'cn')
  assert.equal(out.label, '中国', 'option 文案去掉多余空白')
}

{
  const el = { tagName: 'INPUT', type: 'text', value: 'a   b\n c' }
  assert.equal(pageFn.call(el).value, 'a b c', '实时值折叠空白')
}

{
  const el = { tagName: 'INPUT', type: 'radio', checked: false, value: 'on' }
  assert.equal(pageFn.call(el).kind, 'checked')
  assert.equal(pageFn.call(el).checked, false)
}

{
  const filled = pageFn.call({ tagName: 'INPUT', type: 'password', value: 'hunter2' })
  assert.equal(filled.value, '\u2022\u2022\u2022\u2022', '密码框不把明文读进上下文，只表示已填')
  assert(!String(filled.value).includes('hunter2'))
  assert.equal(pageFn.call({ tagName: 'INPUT', type: 'password', value: '' }).value, '', '空密码框就是空')
}

console.log('browser-observe-live: 输入框实时值、下拉框当前项文案、复选框勾选状态、长度上限、元素字段结构 通过')
