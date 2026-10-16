/**
 * 确认卡键盘策略的纯函数单测：不启动应用、不读写用户设置、不调用模型。
 *
 * 覆盖：Enter/Space 默认激活拦截、Alt+Y/Alt+N 快捷键分类（含 IME 与模态抑制）、
 * press 的 pointerType 分类、归属核对与在途去重。断言的是真实函数返回值，
 * 不是源码字符串。
 */
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

/* ---- Enter / Space 默认激活：卡片容器据此 preventDefault ---- */
assert.equal(isActivationKey(key({ key: 'Enter' })), true)
assert.equal(isActivationKey(key({ key: ' ' })), true)
assert.equal(isActivationKey(key({ key: 'Spacebar' })), true)
assert.equal(isActivationKey(key({ key: 'y' })), false)
assert.equal(isActivationKey(key({ key: 'Tab' })), false)
assert.equal(isActivationKey(key({ key: 'Escape' })), false)
/* IME 组合中的 Enter 留给输入法确认候选，不能拦成激活拦截 */
assert.equal(isActivationKey(key({ key: 'Enter', isComposing: true })), false)
assert.equal(isActivationKey(key({ key: 'Enter', keyCode: 229 })), false)

/* ---- Alt+Y / Alt+N：仅有的键盘答复 ---- */
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
/* 长按产生的重复 keydown 不能顺着答掉下一张卡 */
assert.equal(classifyApprovalShortcut(key({ key: 'y', altKey: true, repeat: true }), false), null)
assert.equal(classifyApprovalShortcut(key({ key: 'n', altKey: true, repeat: true }), false), null)
assert.equal(isComposingEvent(key({ isComposing: true })), true)
assert.equal(isComposingEvent(key({ keyCode: 229 })), true)
assert.equal(isComposingEvent(key({})), false)

/* ---- 模态 / 弹窗打开：全局 Alt 快捷键不响应 ---- */
assert.equal(classifyApprovalShortcut(key({ key: 'y', altKey: true }), true), null)
assert.equal(classifyApprovalShortcut(key({ key: 'n', altKey: true }), true), null)

/* ---- press 分类：keyboard 不是明确点击，其余（含读屏 virtual）放行 ---- */
assert.equal(allowsPointerPress('keyboard'), false)
assert.equal(allowsPointerPress('mouse'), true)
assert.equal(allowsPointerPress('pen'), true)
assert.equal(allowsPointerPress('touch'), true)
assert.equal(allowsPointerPress('virtual'), true)
assert.equal(allowsPointerPress(undefined), true)
assert.equal(allowsPointerPress(''), true)

/* ---- 归属：只认当前最早那条，相邻卡片不跳号 ---- */
const approvals = [{ id: 'A' }, { id: 'B' }]
assert.equal(ownsApproval(approvals, 'A'), true)
assert.equal(ownsApproval(approvals, 'B'), false)
assert.equal(ownsApproval([{ id: 'B' }], 'A'), false)
assert.equal(ownsApproval([{ id: 'B' }], 'B'), true)
assert.equal(ownsApproval(undefined, 'A'), false)
assert.equal(ownsApproval(approvals, ''), false)
assert.equal(ownsApproval(approvals, undefined), false)

/* ---- 在途闸门：同一请求只开始一次；释放后可重试；不同请求各自独立 ---- */
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
