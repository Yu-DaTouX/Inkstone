import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const entry = fileURLToPath(new URL('../src/renderer/src/features/commands/session-switcher-model.ts', import.meta.url))
const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { switcherSessions, initialSwitcherIndex, stepSwitcherIndex, heldModifiersReleased, relativeAge } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const session = (path, extra = {}) => ({ id: path, path, title: path, cwd: 'C:/p', updatedAt: 1, ...extra })
const sessions = [
  session('old', { lastOpenedAt: 100 }),
  session('never', { lastActivityAt: 500 }),
  session('recent', { lastOpenedAt: 300 }),
  session('archived', { lastOpenedAt: 900, archivedAt: 901 }),
  session('current', { lastOpenedAt: 200 })
]

assert.deepEqual(switcherSessions(sessions, 'current').map((s) => s.path), ['current', 'recent', 'old', 'never'], '当前会话在首位，其余按最近打开排序，归档排除')
assert.deepEqual(switcherSessions(sessions, null).map((s) => s.path), ['recent', 'current', 'old', 'never'], '没有当前会话时纯按最近打开')
assert.equal(switcherSessions(sessions, 'current', 2).length, 2, '数量上限生效')

assert.equal(initialSwitcherIndex(4, 1, true), 1, 'Ctrl+Tab 先选上一个会话')
assert.equal(initialSwitcherIndex(4, -1, true), 3, 'Ctrl+Shift+Tab 先选最久的一项')
assert.equal(initialSwitcherIndex(4, 1, false), 0, '没有当前会话时从第一项开始')
assert.equal(stepSwitcherIndex(3, 4, 1), 0, '向后到底回到开头')
assert.equal(stepSwitcherIndex(0, 4, -1), 3, '向前到头回到末尾')

const held = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
assert.equal(heldModifiersReleased(['Ctrl', 'Tab'], held), false, '按住 Ctrl 时不确认')
assert.equal(heldModifiersReleased(['Ctrl', 'Tab'], { ...held, ctrlKey: false }), true, '松开 Ctrl 确认')
assert.equal(heldModifiersReleased(['Ctrl', 'Shift', 'Tab'], { ...held, shiftKey: false }), false, '只松开 Shift 不确认')
assert.equal(heldModifiersReleased(['Alt', 'Q'], { ...held, ctrlKey: false, altKey: true }), false, '改绑到 Alt 时按住 Alt 不确认')
assert.equal(heldModifiersReleased(['F6'], held), true, '无修饰键的改绑立即确认')

assert.equal(relativeAge(1_000, 1_000 + 30_000, 'zh-CN'), '刚刚')
assert.equal(relativeAge(0, 5, 'zh-CN'), '')
assert.equal(relativeAge(0 + 1, 1 + 3 * 3_600_000, 'en-US'), '3h')

console.log('会话切换浮层模型：全部通过')
