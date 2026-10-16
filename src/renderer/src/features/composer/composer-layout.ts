/**
 * 输入框底栏的纯模型：控件顺序、模式徽标、发送/停止判定与思考档位映射。
 *
 * 组件只消费这些函数，测试直接对纯函数断言；这里不依赖 React、store 或 DOM，
 * 因此「左右谁在前」「什么时候是停止」这类版面契约改动能被单测钉住，而不是
 * 靠读 JSX 猜。
 */

/* ------------------------------------------------------------------ 控件顺序 */

/**
 * 底栏左侧控件顺序。模式徽标只在 `!` / `/` 输入时出现，始终排在最左；
 * 其余三项常驻，权限在最左（用户要求把权限放回左侧第一个）。
 */
export const COMPOSER_LEFT_ORDER = ['mode', 'permission', 'plus', 'sendkey'] as const

/** 底栏右侧控件顺序：语音 → 上下文环 → 模型+思考 → 运行位 → 发送/停止。 */
export const COMPOSER_RIGHT_ORDER = ['voice', 'context', 'model-thinking', 'run', 'send'] as const

export type ComposerLeftControl = (typeof COMPOSER_LEFT_ORDER)[number]
export type ComposerRightControl = (typeof COMPOSER_RIGHT_ORDER)[number]

/* ------------------------------------------------------------------ 模式徽标 */

export type ComposerMode = 'bash' | 'cmd' | null

/** `!` 开头是 shell 直执行，`/` 开头是命令模式；其余不显示徽标。 */
export function composerMode(value: string): ComposerMode {
  if (value.startsWith('!')) return 'bash'
  if (value.startsWith('/')) return 'cmd'
  return null
}

/** 输入行左侧提示符：直执行命令用 `$`，普通输入用 `›`。 */
export function composerPrompt(value: string): '$' | '›' {
  return value.startsWith('!') ? '$' : '›'
}

/* ------------------------------------------------------------- 发送 / 停止 */

export interface ComposerSubmitState {
  /** 回合级运行中（含压缩），与 v3 现有的 roundRunning 同源。 */
  running: boolean
  hasText: boolean
  hasAttachments: boolean
}

/**
 * 发送位同一个位置显示两种状态：运行中且输入为空且无附件时是「停止」，
 * 其余一律是「发送」（运行中发送即插话 steer）。
 */
export function composerSubmitAction(state: ComposerSubmitState): 'stop' | 'send' {
  return state.running && !state.hasText && !state.hasAttachments ? 'stop' : 'send'
}

/* ------------------------------------------------------------ 发送键提示 */

export type SendKeyRule = 'enter' | 'ctrl'

/**
 * 发送键提示只在「不写就得靠试」时出现：发送键被改过，或处于长文模式。
 * 默认发送键 + 短输入框时 Enter 发送是常识，写出来只是噪声。
 */
export function composerSendKeyHint(sendKey: string, longForm: boolean): SendKeyRule | null {
  if (!longForm && sendKey === 'auto') return null
  return sendKey === 'ctrlEnter' ? 'ctrl' : 'enter'
}

/* -------------------------------------------------------------- 思考档位 */

/** 当前档位在档位表里的下标；档位表里没有时退到第一档。 */
export function thinkingLevelIndex(levels: readonly string[], level: string): number {
  const index = levels.indexOf(level)
  return index < 0 ? 0 : index
}

/** 档位下标 → 档位名；越界夹取，空表返回 null。 */
export function thinkingLevelAt(levels: readonly string[], index: number): string | null {
  if (!Number.isFinite(index)) return null
  const clamped = Math.max(0, Math.min(levels.length - 1, Math.round(index)))
  return levels[clamped] ?? null
}

/**
 * 拖动滑杆的动作：**只**更新预览，绝不写设置。松手/确认才允许落盘，
 * 因此「拖动过程中档位就变了」这种越权在这里被结构性排除。
 */
export function thinkingDragAction(
  levels: readonly string[],
  index: number
): { kind: 'preview'; level: string } | { kind: 'none' } {
  const level = thinkingLevelAt(levels, index)
  return level ? { kind: 'preview', level } : { kind: 'none' }
}

/** 松手/确认的动作：只有真的换了档才提交，重复提交同一档是空操作。 */
export function thinkingCommitAction(
  levels: readonly string[],
  index: number,
  current: string
): { kind: 'commit'; level: string } | { kind: 'none' } {
  const level = thinkingLevelAt(levels, index)
  if (!level || level === current) return { kind: 'none' }
  return { kind: 'commit', level }
}
