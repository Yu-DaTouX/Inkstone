import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = fileURLToPath(new URL('../src/renderer/src/features/session/question-keys.ts', import.meta.url))

const bundled = await build({
  stdin: { contents: `export * from ${JSON.stringify(source.replace(/\\/g, '/'))}\n`, resolveDir: root, loader: 'ts' },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const { claimDigitKeys, digitChoiceIndex } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

const plain = { closest: () => null, isContentEditable: false }
const field = { closest: (sel) => (sel.includes('input') ? {} : null), isContentEditable: false }
const editable = { closest: () => null, isContentEditable: true }
const ev = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, target: plain, ...extra })

assert.equal(digitChoiceIndex(ev('1'), 3), 0, '1 选第一项')
assert.equal(digitChoiceIndex(ev('3'), 3), 2, '3 选第三项')
assert.equal(digitChoiceIndex(ev('4'), 3), null, '超出选项数忽略')
assert.equal(digitChoiceIndex(ev('0'), 3), null, '0 不是选项')
assert.equal(digitChoiceIndex(ev('a'), 3), null, '非数字忽略')
assert.equal(digitChoiceIndex(ev('1', { ctrlKey: true }), 3), null, 'Ctrl+数字留给模型切换')
assert.equal(digitChoiceIndex(ev('1', { altKey: true }), 3), null, 'Alt+数字忽略')
assert.equal(digitChoiceIndex(ev('1', { target: field }), 3), null, '输入框里打数字不抢')
assert.equal(digitChoiceIndex(ev('1', { target: editable }), 3), null, '可编辑区（输入框编辑器）里打数字不抢')
assert.equal(digitChoiceIndex(ev('1', { isComposing: true }), 3), null, '输入法组合中忽略')
assert.equal(digitChoiceIndex(ev('1', { defaultPrevented: true }), 3), null, '已被处理的事件忽略')
assert.equal(digitChoiceIndex(ev('1', { target: null }), 3), 0, '无目标时可用')

const a = claimDigitKeys()
const b = claimDigitKeys()
assert.equal(b.owns(), true, '后挂载的卡拥有数字键')
assert.equal(a.owns(), false, '先挂载的卡让出')
b.release()
assert.equal(a.owns(), true, '后者卸载后交还')
a.release()
assert.equal(a.owns(), false, '全部释放后无人拥有')

console.log('问题卡数字键：选项映射、修饰键与输入区排除、多卡归属检查通过')
