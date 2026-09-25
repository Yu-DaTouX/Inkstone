/**
 * 宿主提问的等待时间（`yan question ask` 与它渲染出来的问题面板共用一份口径）。
 *
 * ══════════════════════════════════════════════════════════
 * 为什么单独一个模块
 * ══════════════════════════════════════════════════════════
 * 同一个数被四处用到，写四遍必然漂移：
 *   · 主进程 `AgentController.runQuestionCommand`（默认值与夹取）——**权威**；
 *   · 主进程 `extendHostUi`（用户点一下加 2 分钟）；
 *   · 渲染端 `QuestionPanel`（倒计时显示、到点收起面板）；
 *   · `yan question ask` 的帮助文案。
 *
 * ── 时间线的形状（改这里要一起看）──
 * 默认 3 分钟。用户可以在面板的倒计时上点一下 **+2 分钟**，单次延长有上限、
 * 并且**剩余时间**封顶 30 分钟（点再多也不会把会话无限期挂住）。
 * 延长只影响宿主等待：模型看到的仍然是「超时未回答 → 如实返回超时」，
 * 砚不替用户猜答案。
 */

/** 默认等待（用户 2026-09-26 拍板：3 分钟） */
export const UI_TIMEOUT_DEFAULT = 3 * 60_000
/** 请求里能声明的最短等待 */
export const UI_TIMEOUT_MIN = 5_000
/** 请求里能声明的最长等待（模型自己传 `timeout` 时的上限） */
export const UI_TIMEOUT_MAX = 10 * 60_000
/** 面板上点一次「加时间」的增量 */
export const UI_TIMEOUT_EXTEND = 2 * 60_000
/** 每次延长之后，**剩余**等待的上限（防无限点） */
export const UI_TIMEOUT_REMAINING_MAX = 30 * 60_000
/**
 * 硬上限：从**请求发出**算起的最终保险。
 *
 * 计时是「用户看到这一条」才开始的（多条问题分页显示），所以必须有个兜底：
 * 用户一直不翻到某一条（甚至把面板收起来）时，模型不能无限等下去。
 * 开始计时后这个兜底会被往后推（见 `AgentController.startHostUiTimer`）。
 */
export const UI_TIMEOUT_HARD = 10 * 60_000

/**
 * 把请求里声明的 `timeout` 收进合法区间；缺省 / 非法一律用默认值。
 *
 * 非法值**不报错**：提问的等待时间不该成为一次交互的失败原因，退回默认即可。
 */
export function requestedTimeout(raw: unknown): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return UI_TIMEOUT_DEFAULT
  return Math.min(Math.max(Math.floor(value), UI_TIMEOUT_MIN), UI_TIMEOUT_MAX)
}

/**
 * 延长后的截止时刻（绝对毫秒）。
 *
 * 两条边界一起收：
 *   · 单次增量不超过 `UI_TIMEOUT_EXTEND`（渲染端传什么都不能把等待拉爆）；
 *   · 延长后的**剩余**时间不超过 `UI_TIMEOUT_REMAINING_MAX`。
 * 用「绝对 deadline」而不是「剩余毫秒」是为了让渲染端每秒重算都与主进程一致，
 * 不受计时器抖动与 IPC 往返影响。
 */
export function extendDeadline(deadline: number, now: number, extraMs: unknown = UI_TIMEOUT_EXTEND): number {
  const value = Number(extraMs)
  const extra = Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), UI_TIMEOUT_EXTEND) : UI_TIMEOUT_EXTEND
  return Math.min(deadline + extra, now + UI_TIMEOUT_REMAINING_MAX)
}

/** 倒计时文本（`mm:ss`；超过 1 小时才出现 `h:mm:ss`）。纯展示，不参与判定。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}
