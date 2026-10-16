/**
 * 确认卡（`ApprovalCard`）的键盘与答复归属策略。
 *
 * 这里只放**纯判定**，不 import React / DOM，也不 import store：
 *   · `scripts/test-v3-approval-keys.mjs` 直接覆盖分类与重入，用真实函数而不是源码字符串；
 *   · 卡片容器只负责把事件喂进来、把判定结果接回去。
 *
 * 安全语义（与 v2 `chat/ApprovalCard.tsx` 逐条对齐）：
 *   · `Enter` / `Space` 的默认激活在**捕获阶段**就被拦掉，按钮聚焦也不会误放行；
 *   · 仅有的键盘答复路径是 `Alt+Y`（允许一次）与 `Alt+N`（拒绝）；
 *   · 按下答复后按 `current` 请求 id 核对归属，过在途闸门，避免相邻卡片跳号重复确认。
 */

/** 键盘能表达的答复：`remember` 只允许明确点击，不给快捷键。 */
export type ApprovalKeyChoice = 'once' | 'deny'

/** 判断默认激活只需这几个字段。 */
export interface KeyLike {
  key: string
  /** DOM `KeyboardEvent.isComposing`；部分 IME 只给 `keyCode === 229`。 */
  isComposing?: boolean
  keyCode?: number
}

/** 判定 `Alt+字母` 需要修饰键。 */
export interface ShortcutKeyEvent extends KeyLike {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  /** 长按产生的重复 keydown：不能拿它去答复下一张卡。 */
  repeat?: boolean
}

/** IME 组合中：不当作快捷键，Enter 也留给输入法确认候选。 */
export function isComposingEvent(event: KeyLike): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/**
 * 会触发按钮默认激活的按键。卡片容器收到它就 `preventDefault()` + `stopPropagation()`：
 * 不依赖按钮是否注册键盘回调，也不依赖 press 事件的 `pointerType` 判定。
 */
export function isActivationKey(event: KeyLike): boolean {
  if (isComposingEvent(event)) return false
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar'
}

/**
 * `Alt+Y` / `Alt+N` 是确认卡仅有的键盘答复路径。
 *
 * 以下情况一律返回 null：
 *   · 有模态 / 弹窗打开——浮层在上面时不能顺手答掉后面的卡片；
 *   · IME 组合中——不把候选确认键当快捷键；
 *   · 自动重复（长按）——答完一张后不能顺着重复事件答下一张；
 *   · 带 Ctrl / Meta——留给系统与应用级快捷键；
 *   · 没有 Alt 或不是 y / n。
 */
export function classifyApprovalShortcut(
  event: ShortcutKeyEvent,
  modalOpen: boolean
): ApprovalKeyChoice | null {
  if (modalOpen) return null
  if (event.repeat) return null
  if (isComposingEvent(event)) return null
  if (!event.altKey || event.ctrlKey || event.metaKey) return null
  const key = event.key.toLowerCase()
  if (key === 'y') return 'once'
  if (key === 'n') return 'deny'
  return null
}

/**
 * press 分类：`onPress` 的 `pointerType === 'keyboard'` 不是明确点击。
 * 其余一律放行——真实指针、触控、以及读屏 / `element.click()` 的 `virtual`
 * 都属于「明确点击」，不能因为拦键盘而把它们一起挡掉。
 */
export function allowsPointerPress(pointerType: string | null | undefined): boolean {
  return pointerType !== 'keyboard'
}

/**
 * 归属：只承认 store 里当前最早的那条请求。
 * 答复动作发生在请求已变化之后时（相邻卡片顶上来 / 连按 / 键重复）返回 false。
 */
export function ownsApproval(
  approvals: ReadonlyArray<{ id: string }> | undefined,
  id: string | null | undefined
): boolean {
  return !!id && approvals?.[0]?.id === id
}

/** 在途闸门：同一条请求只允许开始一次答复。 */
export interface ApprovalGate {
  begin(id: string): boolean
  release(id: string): void
  hasPending(): boolean
}

export function createApprovalGate(): ApprovalGate {
  const inflight = new Set<string>()
  return {
    begin(id) {
      if (!id || inflight.has(id)) return false
      inflight.add(id)
      return true
    },
    release(id) {
      inflight.delete(id)
    },
    hasPending() {
      return inflight.size > 0
    }
  }
}
