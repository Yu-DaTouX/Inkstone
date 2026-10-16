/**
 * 辅助小窗的窗口状态与纯逻辑（v3 WP-25d / WP-12）。
 *
 * 主进程不看渲染端的输入框：草稿留在渲染端，主进程只维护**窗口级**状态
 * （可见 / 提交中 / 错误 / 是否启用），这样打字不必每次往返 IPC。这里全是纯
 * reducer 与校验，可在 node 里直接断言（见 scripts/test-v3-aux-windows.mjs）。
 */
import type { MiniItem, QuickAskErrorCode, AuxTarget } from './aux-types'

/* ───────────────────────── 快速提问 ───────────────────────── */

export interface QuickAskWindowState {
  visible: boolean
  submitting: boolean
  errorCode: QuickAskErrorCode | null
  errorMessage: string | null
}

export const INITIAL_QUICK_ASK_STATE: QuickAskWindowState = {
  visible: false,
  submitting: false,
  errorCode: null,
  errorMessage: null
}

export type QuickAskAction =
  | { type: 'show' }
  | { type: 'hide' }
  | { type: 'submit-start' }
  | { type: 'submit-ok' }
  | { type: 'submit-error'; code: QuickAskErrorCode; message?: string }

/** 隐藏 / 重新打开时清掉上一次的错误，但不打断正在提交的那一次。 */
export function quickAskReducer(state: QuickAskWindowState, action: QuickAskAction): QuickAskWindowState {
  switch (action.type) {
    case 'show':
      return { ...state, visible: true, errorCode: null, errorMessage: null }
    case 'hide':
      return { ...state, visible: false, submitting: false }
    case 'submit-start':
      return { ...state, submitting: true, errorCode: null, errorMessage: null }
    case 'submit-ok':
      return { visible: false, submitting: false, errorCode: null, errorMessage: null }
    case 'submit-error':
      return { ...state, submitting: false, errorCode: action.code, errorMessage: action.message ?? null }
    default:
      return state
  }
}

/**
 * 发送前的校验：空问题、选了「当前会话」却没有当前会话都直接拒绝。
 * 返回错误码；null 表示可以发送。
 */
export function validateQuickAsk(prompt: string, target: AuxTarget, hasCurrent: boolean): QuickAskErrorCode | null {
  if (!prompt.trim()) return 'empty'
  if (target === 'current' && !hasCurrent) return 'no-current'
  return null
}

/* ───────────────────────── 迷你小窗 ───────────────────────── */

export interface MiniWindowState {
  /** 设置项：迷你小窗是否允许出现（默认关闭）。 */
  enabled: boolean
  visible: boolean
  items: MiniItem[]
}

export const INITIAL_MINI_STATE: MiniWindowState = { enabled: false, visible: false, items: [] }

export type MiniAction =
  | { type: 'set-enabled'; enabled: boolean }
  | { type: 'show' }
  | { type: 'hide' }
  | { type: 'set-items'; items: MiniItem[] }

export function miniReducer(state: MiniWindowState, action: MiniAction): MiniWindowState {
  switch (action.type) {
    case 'set-enabled':
      return { ...state, enabled: action.enabled, visible: action.enabled ? state.visible : false }
    case 'show':
      return state.enabled ? { ...state, visible: true } : state
    case 'hide':
      return { ...state, visible: false }
    case 'set-items':
      return { ...state, items: action.items }
    default:
      return state
  }
}

/** 条目在微型窗口里的高度估计：用于决定窗口高度（有上限，超过后内部滚动）。 */
export const MINI_ROW_HEIGHT = 44
export const MINI_HEADER_HEIGHT = 36
export const MINI_MAX_HEIGHT = 420

export function miniWindowHeight(itemCount: number, size: { header?: number; row?: number; max?: number } = {}): number {
  const header = size.header ?? MINI_HEADER_HEIGHT
  const row = size.row ?? MINI_ROW_HEIGHT
  const max = size.max ?? MINI_MAX_HEIGHT
  const wanted = header + Math.max(itemCount, 1) * row
  return Math.min(wanted, max)
}
