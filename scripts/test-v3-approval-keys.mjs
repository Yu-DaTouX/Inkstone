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
  createApprovalGate,
  isApprovalCommitKey,
  isEditableElement,
  createApprovalArming,
  isApprovingChoice,
  requiresApprovalReadGate,
  isApprovalDetailRead,
  APPROVAL_ARM_MS
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

const commit = (overrides = {}, context = {}) => isApprovalCommitKey(key({ key: 'Enter', ctrlKey: true, ...overrides }), { modalOpen: false, insideCard: false, editableFocus: false, ...context })
assert.equal(commit(), true, 'Ctrl+Enter 在非输入焦点时允许一次')
assert.equal(commit({ ctrlKey: false, metaKey: true }), true, 'Cmd+Enter 同样有效')
assert.equal(commit({ ctrlKey: false }), false, '单独 Enter 不提交')
assert.equal(commit({}, { editableFocus: true }), false, '输入框里的 Ctrl+Enter 留给输入框')
assert.equal(commit({}, { editableFocus: true, insideCard: true }), true, '卡内焦点优先')
assert.equal(commit({}, { modalOpen: true }), false, '模态打开时不提交')
assert.equal(commit({ repeat: true }), false)
assert.equal(commit({ altKey: true }), false)
assert.equal(commit({ shiftKey: true }), false)
assert.equal(commit({ isComposing: true }), false)
assert.equal(isEditableElement({ tagName: 'TEXTAREA' }), true)
assert.equal(isEditableElement({ tagName: 'INPUT', type: 'text' }), true)
assert.equal(isEditableElement({ tagName: 'INPUT', type: 'checkbox' }), false)
assert.equal(isEditableElement({ tagName: 'DIV', isContentEditable: true }), true)
assert.equal(isEditableElement({ tagName: 'BUTTON' }), false)
assert.equal(isEditableElement(null), false)

let now = 0
const arming = createApprovalArming(() => now)
arming.arm('A')
now = APPROVAL_ARM_MS - 1
assert.equal(arming.isArmed('A'), false, '新卡出现 400ms 内不批准')
now = APPROVAL_ARM_MS
assert.equal(arming.isArmed('A'), true, '400ms 后可以批准')
arming.arm('A')
assert.equal(arming.isArmed('A'), true, '同一张卡不重新计时')
arming.arm('B')
assert.equal(arming.isArmed('B'), false, '新卡重新计时')
assert.equal(arming.isArmed('A'), false, '旧卡不再命中')
arming.arm(null)
assert.equal(arming.isArmed('B'), false, '没有卡时一律不算武装')
assert.equal(APPROVAL_ARM_MS, 400)

assert.equal(isApprovingChoice('deny'), false)
assert.equal(isApprovingChoice('once'), true)
assert.equal(isApprovingChoice('session'), true)
assert.equal(isApprovingChoice('remember'), true)

assert.equal(requiresApprovalReadGate({ kind: 'danger' }), true, '高危操作要读完才能批准')
assert.equal(requiresApprovalReadGate({ kind: 'delete' }), true)
assert.equal(requiresApprovalReadGate({ kind: 'outside' }), true)
assert.equal(requiresApprovalReadGate({ kind: 'consent', danger: '删除或覆盖' }), true, '危险类别也要读')
assert.equal(requiresApprovalReadGate({ kind: 'consent' }), false, '普通能力授权不拦')
assert.equal(requiresApprovalReadGate({ kind: 'permission', tool: 'edit' }), false, '改文件不拦')
assert.equal(requiresApprovalReadGate({ kind: 'permission', tool: 'bash' }), true, '命令行要读')
assert.equal(requiresApprovalReadGate({ kind: 'move' }), false)

assert.equal(isApprovalDetailRead({ scrollTop: 0, clientHeight: 100, scrollHeight: 100 }), true, '内容一屏放下视为已读')
assert.equal(isApprovalDetailRead({ scrollTop: 0, clientHeight: 100, scrollHeight: 300 }), false)
assert.equal(isApprovalDetailRead({ scrollTop: 199, clientHeight: 100, scrollHeight: 300 }), true, '滚到底算已读')
assert.equal(isApprovalDetailRead({ scrollTop: 190, clientHeight: 100, scrollHeight: 300 }), false, '差一截还不算')
assert.equal(isApprovalDetailRead({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 }), true, '还没布局不算未读')

console.log('v3 确认卡键盘策略：Enter 激活拦截、Ctrl+Enter 允许一次、Alt 快捷键、模态抑制、press 分类与在途去重检查通过')
