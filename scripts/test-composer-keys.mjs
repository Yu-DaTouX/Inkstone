import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/composer/composer-keys.ts', import.meta.url))
const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm' })
const { planComposerKey, isComposingKey, swallowStrayEnter, swallowsPendingCompletionKey } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const event = (key, mods = {}) => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  defaultPrevented: false,
  nativeEvent: {},
  preventDefault() {},
  ...mods
})

const base = {
  running: false,
  compacting: false,
  sendKey: 'auto',
  hasText: false,
  hasAttachments: false,
  lastEsc: 0,
  now: 1000,
  completionHandled: false
}

const plan = (key, mods = {}, overrides = {}) => planComposerKey({ ...base, ...overrides, event: event(key, mods) })

assert.deepEqual(plan('Enter'), { action: 'steer', preventDefault: true, lastEsc: 0 }, '空闲 Enter 发送并阻止换行')
assert.deepEqual(
  plan('Enter', {}, { sendKey: 'ctrlEnter' }),
  { action: 'newline', preventDefault: false, lastEsc: 0 },
  '发送键改为 Ctrl+Enter 时，空闲 Enter 走换行'
)
assert.equal(plan('Enter', { ctrlKey: true }, { sendKey: 'ctrlEnter' }).action, 'steer', 'Ctrl+Enter 仍然发送')
assert.equal(plan('Enter', { metaKey: true }, { sendKey: 'ctrlEnter' }).action, 'steer', 'Cmd+Enter 也发送')

assert.deepEqual(plan('Enter', { shiftKey: true }), { action: 'newline', preventDefault: false, lastEsc: 0 }, 'Shift+Enter 换行且不拦截')
assert.deepEqual(
  plan('Enter', { shiftKey: true }, { running: true }),
  { action: 'newline', preventDefault: false, lastEsc: 0 },
  '运行中 Shift+Enter 仍是换行'
)

assert.deepEqual(plan('Enter', {}, { running: true }), { action: 'steer', preventDefault: true, lastEsc: 0 }, '运行中 Enter 插话')
assert.equal(plan('Enter', { altKey: true }, { running: true }).action, 'followUp', '运行中 Alt+Enter 排队')
assert.equal(plan('Enter', {}, { running: true, compacting: true }).action, 'followUp', '压缩中 Enter 排队')
assert.equal(plan('Enter', { ctrlKey: true }, { running: true }).action, 'steer', '运行中 Ctrl+Enter 仍按插话（排队只认 Ctrl+Q）')

assert.deepEqual(
  plan('q', { ctrlKey: true }, { running: true }),
  { action: 'followUp', preventDefault: true, lastEsc: 0 },
  '运行中 Ctrl+Q 排队'
)
assert.equal(plan('Q', { ctrlKey: true }, { running: true }).action, 'followUp', 'Ctrl+Shift+Q 以外的大写 Q 也命中')
assert.equal(plan('q', { ctrlKey: true }).action, 'none', '空闲 Ctrl+Q 不动作')
assert.equal(plan('q', { ctrlKey: true, shiftKey: true }, { running: true }).action, 'none', 'Ctrl+Shift+Q 不命中排队')
assert.equal(plan('q', { ctrlKey: true, altKey: true }, { running: true }).action, 'none', 'Ctrl+Alt+Q 不命中排队')
assert.equal(plan('q', { ctrlKey: true, metaKey: true }, { running: true }).action, 'none', 'Ctrl+Meta+Q 不命中排队')

assert.deepEqual(
  plan('Escape', {}, { running: true }),
  { action: 'armAbort', preventDefault: true, lastEsc: 1000 },
  '运行中空输入第一次 Esc 只记时间'
)
assert.deepEqual(
  plan('Escape', {}, { running: true, lastEsc: 800 }),
  { action: 'abort', preventDefault: true, lastEsc: 0 },
  '500ms 内第二次 Esc 中止并清零'
)
assert.equal(plan('Escape', {}, { running: true, lastEsc: 500 }).action, 'armAbort', '满 500ms 不触发中止')
assert.equal(plan('Escape', {}, { running: true, hasText: true }).action, 'none', '有正文时 Esc 不中止')
assert.equal(plan('Escape', {}, { running: true, hasAttachments: true }).action, 'none', '有附件时 Esc 不中止')
assert.equal(plan('Escape').action, 'none', '空闲 Esc 交给全局处理')
assert.equal(plan('Escape', {}, { running: true }).preventDefault, true, '第一次 Esc 也阻止默认（沿用现有行为）')

assert.equal(plan('Enter', {}, { completionHandled: true }).action, 'none', '补全菜单消费的回车不再发送')
assert.equal(plan('Enter', { defaultPrevented: true }).action, 'none', '已被阻止的按键不重复处理')
assert.equal(plan('Enter', {}, { running: true, completionHandled: true }).preventDefault, false, '菜单消费时不再 preventDefault')

assert.equal(isComposingKey(event('Enter', { nativeEvent: { isComposing: true } })), true, 'isComposing 判定为输入法组合中')
assert.equal(isComposingKey(event('Enter', { nativeEvent: { keyCode: 229 } })), true, 'keyCode 229 判定为输入法组合中')
assert.equal(isComposingKey(event('Enter')), false, '普通按键不是组合中')
assert.equal(plan('Enter', { nativeEvent: { isComposing: true } }).action, 'none', '输入法组合中回车不发送')
assert.equal(plan('Escape', { nativeEvent: { keyCode: 229 } }, { running: true }).action, 'none', '输入法组合中 Esc 不中止')

assert.equal(plan('a').action, 'none', '普通字符不做策略处理')
assert.equal(plan('ArrowDown').action, 'none', '方向键交给补全菜单')

const stray = (mods = {}, opts = {}) =>
  swallowStrayEnter({ event: event('Enter', mods), until: 1500, now: 1000, plainEnterSends: true, ...opts })

assert.equal(stray(), true, '聚焦后 500ms 窗口内的回车被吞掉')
assert.equal(stray({}, { now: 1500 }), false, '满 500ms 后回车恢复正常发送')
assert.equal(stray({}, { now: 1600 }), false, '窗口外回车正常发送')
assert.equal(stray({ shiftKey: true }), false, 'Shift+Enter 不受保护影响')
assert.equal(stray({ altKey: true }), false, 'Alt+Enter 不受保护影响')
assert.equal(stray({ nativeEvent: { isComposing: true } }), false, '输入法组合确认的 Enter 不吞')
assert.equal(stray({ nativeEvent: { keyCode: 229 } }), false, 'keyCode 229 的 Enter 不吞')
assert.equal(stray({ nativeEvent: { repeat: true } }, { now: 9000 }), true, '连发的回车即使窗口外也吞')
assert.equal(stray({ nativeEvent: { repeat: true }, shiftKey: true }), false, '连发的 Shift+Enter 仍是换行')
assert.equal(stray({}, { plainEnterSends: false }), false, '发送键为 Ctrl+Enter 时普通回车走换行，不吞')
assert.equal(stray({ ctrlKey: true }, { plainEnterSends: false }), true, 'Ctrl+Enter 在窗口内仍被吞')
assert.equal(
  swallowStrayEnter({ event: event('a'), until: 1500, now: 1000, plainEnterSends: true }),
  false,
  '非回车键不受保护影响'
)

assert.equal(swallowsPendingCompletionKey('Enter'), true, '补全菜单加载中时回车被吞，不发半截命令')
assert.equal(swallowsPendingCompletionKey('Tab'), true, '补全菜单加载中时 Tab 被吞')
assert.equal(swallowsPendingCompletionKey('ArrowDown'), false, '方向键不在加载中时被吞')
assert.equal(swallowsPendingCompletionKey('a'), false, '普通字符不被吞')

console.log('输入框键位策略：发送/换行/排队/双击中止/IME 与补全消费检查通过')
