import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = fileURLToPath(new URL('../src/renderer/src/features/session/typing-guard.ts', import.meta.url)).replace(/\\/g, '/')

const bundled = await build({
  stdin: { contents: `export { shouldDeferCardFocus, isCardFocusKey, isTypingKey, nextShiftHeld, cardFocusKeysText, TYPING_IDLE_MS } from ${JSON.stringify(source)}\n`, resolveDir: root, loader: 'ts' },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm'
})
const { shouldDeferCardFocus, isCardFocusKey, isTypingKey, nextShiftHeld, cardFocusKeysText, TYPING_IDLE_MS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

const now = 100_000
const snap = (extra = {}) => ({ now, lastTypedAt: Number.NEGATIVE_INFINITY, editableFocused: true, editableHasText: false, focusInsideCard: false, ...extra })

assert.equal(TYPING_IDLE_MS, 1500)
assert.equal(shouldDeferCardFocus(snap({ lastTypedAt: now - 200 })), true, '刚按过键时不抢焦点')
assert.equal(shouldDeferCardFocus(snap({ lastTypedAt: now - 1499 })), true, '1.5 秒内仍算在打字')
assert.equal(shouldDeferCardFocus(snap({ lastTypedAt: now - 1500 })), false, '超过 1.5 秒且输入框为空时照常聚焦')
assert.equal(shouldDeferCardFocus(snap({ editableHasText: true })), true, '输入框有未发送内容且有焦点时不抢')
assert.equal(shouldDeferCardFocus(snap({ editableFocused: false, editableHasText: true, lastTypedAt: now })), false, '焦点不在输入框时照常聚焦')
assert.equal(shouldDeferCardFocus(snap({ focusInsideCard: true, lastTypedAt: now })), false, '焦点已在卡片里')
assert.equal(shouldDeferCardFocus(snap({ shiftHeld: true })), true, '输入框为空、按住 Shift 准备打大写时不抢')
assert.equal(shouldDeferCardFocus(snap({ shiftHeld: false })), false, '松开 Shift 后照常聚焦')
assert.equal(shouldDeferCardFocus(snap({ shiftHeld: true, editableFocused: false })), false, '焦点不在输入框时按住 Shift 不影响')

assert.equal(nextShiftHeld(false, { type: 'keydown', key: 'Shift', shiftKey: true }, true), true, '在输入框里按下 Shift 开始算打字')
assert.equal(nextShiftHeld(false, { type: 'keydown', key: 'Shift', shiftKey: true }, false), false, '不在输入框里按 Shift 不算')
assert.equal(nextShiftHeld(true, { type: 'keydown', key: 'Shift', shiftKey: true, repeat: true }, true), true, '长按 Shift 的重复 keydown 仍算')
assert.equal(nextShiftHeld(true, { type: 'keydown', key: 'A', shiftKey: true }, true), true, '按着 Shift 打字母期间仍算')
assert.equal(nextShiftHeld(true, { type: 'keyup', key: 'A', shiftKey: true }, true), true, '其他键抬起不影响')
assert.equal(nextShiftHeld(true, { type: 'keyup', key: 'Shift', shiftKey: false }, true), false, 'Shift keyup 后不再算')
assert.equal(nextShiftHeld(true, { type: 'blur' }, false), false, '窗口失焦时清掉，避免漏收 keyup 后一直卡住')
assert.equal(nextShiftHeld(true, { type: 'keydown', key: 'a', shiftKey: false }, true), false, '后续按键不带 Shift 时纠正漏收的 keyup')

const key = (extra = {}) => ({ key: 'Enter', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, ...extra })
assert.equal(isCardFocusKey(key()), true, 'Ctrl+Shift+Enter 去处理卡片')
assert.equal(isCardFocusKey(key({ ctrlKey: false, metaKey: true })), true, 'mac Cmd+Shift+Enter')
assert.equal(isCardFocusKey(key({ shiftKey: false })), false, 'Ctrl+Enter 仍是发送/批准，不被占用')
assert.equal(isCardFocusKey(key({ altKey: true })), false)
assert.equal(isCardFocusKey(key({ ctrlKey: false })), false, 'Shift+Enter 换行不被占用')
assert.equal(isCardFocusKey(key({ isComposing: true })), false, '输入法组合中不触发')
assert.equal(isCardFocusKey(key({ keyCode: 229 })), false)
assert.equal(isCardFocusKey(key({ repeat: true })), false)
for (const typed of ['a', '中', ' ', 'Backspace', 'Delete', 'Enter', 'Process']) assert.equal(isTypingKey({ key: typed }), true, `${typed} 算打字`)
for (const nav of ['Tab', 'Shift', 'Escape', 'ArrowDown', 'Home', 'PageUp', 'Control', 'F5']) assert.equal(isTypingKey({ key: nav }), false, `${nav} 是导航或修饰键，不算打字`)
assert.equal(isTypingKey({ key: 'Tab', shiftKey: true }), false, 'Shift+Tab 反向移动焦点不算打字')
assert.equal(isTypingKey({ key: 'c', ctrlKey: true }), false, '快捷键不算打字，真正改内容由 input 事件记录')
assert.equal(cardFocusKeysText(false), 'Ctrl+Shift+Enter')
assert.equal(cardFocusKeysText(true), 'Cmd+Shift+Enter')

console.log('typing guard ok')
