import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/renderer/src/features/session/approval-keys.ts', import.meta.url))
const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'esm' })
const {
  isComposingEvent,
  isActivationKey,
  classifyApprovalShortcut,
  allowsPointerPress,
  ownsApproval,
  createApprovalGate
} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const key = (overrides = {}) => ({ key: '', altKey: false, ctrlKey: false, metaKey: false, ...overrides })

assert.equal(isActivationKey(key({ key: 'Enter' })), true)
assert.equal(isActivationKey(key({ key: ' ' })), true)
assert.equal(isActivationKey(key({ key: 'Spacebar' })), true)
assert.equal(isActivationKey(key({ key: 'y' })), false)
assert.equal(isActivationKey(key({ key: 'Tab' })), false)
assert.equal(isActivationKey(key({ key: 'Escape' })), false)
assert.equal(isActivationKey(key({ key: 'Enter', isComposing: true })), false)
assert.equal(isActivationKey(key({ key: 'Enter', keyCode: 229 })), false)

assert.equal(classifyApprovalShortcut(key({ key: 'y', altKey: true }), false), 'once')
assert.equal(classifyApprovalShortcut(key({ key: 'Y', altKey: true }), false), 'once')
assert.equal(classifyApprovalShortcut(key({ key: 'n', altKey: true }), false), 'deny')
assert.equal(classifyApprovalShortcut(key({ key: 'N', altKey: true }), false), 'deny')
assert.equal(classifyApprovalShortcut(key({ key: 'Enter', altKey: true }), false), null)
assert.equal(classifyApprovalShortcut(key({ key: 'y' }), false), null)
assert.equal(classifyApprovalShortcut(key({ key: 'y', altKey: true, ctrlKey: true }), false), null)
assert.equal(classifyApprovalShortcut(key({ key: 'y', altKey: true, metaKey: true }), false), null)
assert.equal(classifyApprovalShortcut(key({ key: 'y', altKey: true, isComposing: true }), false), null)
assert.equal(classifyApprovalShortcut(key({ key: 'n', altKey: true, keyCode: 229 }), false), null)
assert.equal(classifyApprovalShortcut(key({ key: 'y', altKey: true, repeat: true }), false), null)
assert.equal(classifyApprovalShortcut(key({ key: 'n', altKey: true, repeat: true }), false), null)
assert.equal(isComposingEvent(key({ isComposing: true })), true)
assert.equal(isComposingEvent(key({ keyCode: 229 })), true)
assert.equal(isComposingEvent(key({})), false)

assert.equal(classifyApprovalShortcut(key({ key: 'y', altKey: true }), true), null)
assert.equal(classifyApprovalShortcut(key({ key: 'n', altKey: true }), true), null)

assert.equal(allowsPointerPress('keyboard'), false)
assert.equal(allowsPointerPress('mouse'), true)
assert.equal(allowsPointerPress('pen'), true)
assert.equal(allowsPointerPress('touch'), true)
assert.equal(allowsPointerPress('virtual'), true)
assert.equal(allowsPointerPress(undefined), true)
assert.equal(allowsPointerPress(''), true)

const approvals = [{ id: 'A' }, { id: 'B' }]
assert.equal(ownsApproval(approvals, 'A'), true)
assert.equal(ownsApproval(approvals, 'B'), false)
assert.equal(ownsApproval([{ id: 'B' }], 'A'), false)
assert.equal(ownsApproval([{ id: 'B' }], 'B'), true)
assert.equal(ownsApproval(undefined, 'A'), false)
assert.equal(ownsApproval(approvals, ''), false)
assert.equal(ownsApproval(approvals, undefined), false)

const gate = createApprovalGate()
assert.equal(gate.begin('A'), true)
assert.equal(gate.begin('A'), false, '同一请求在途时不能重复答复')
assert.equal(gate.begin('B'), true, '不同请求各自独立')
assert.equal(gate.hasPending(), true)
gate.release('A')
assert.equal(gate.begin('A'), true, '失败后释放，允许重试')
gate.release('A')
gate.release('B')
assert.equal(gate.hasPending(), false)
assert.equal(gate.begin(''), false)

console.log('v3 确认卡键盘策略：Enter 激活拦截、Alt 快捷键、模态抑制、press 分类与在途去重检查通过')
