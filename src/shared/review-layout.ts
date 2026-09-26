/*
 * 审查面板**内层**文件目录的宽度（实施-22 R1）。
 *
 * 与外层右栏宽度是两件事：
 *   · 外层 = `.rightpanel` 的整列宽（`--w-review-user`，由 Resizer 拖）—— R2；
 *   · 内层 = `.review-body` 里「目录列 : diff 列」的分割 —— 本文件。
 * 改造前内层是写死的 `clamp(190px, 28%, 280px)`，所以用户「无法调宽目录」。
 *
 * 夹取规则保证 diff 永远留得住最小可读宽度：面板越窄，目录上限越低。
 */
export const REVIEW_SIDE_MIN = 160
export const REVIEW_SIDE_MAX = 420
/** diff 至少留这么宽；面板窄到放不下时目录压到最小值 */
export const REVIEW_DIFF_MIN = 320

/** 把想要的目录宽度夹进「面板能承受」的区间（纯函数，便于单测） */
export function clampReviewSideWidth(panelWidth: number, want: number): number {
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return REVIEW_SIDE_MIN
  const upper = Math.max(REVIEW_SIDE_MIN, Math.min(REVIEW_SIDE_MAX, panelWidth - REVIEW_DIFF_MIN))
  const value = Number.isFinite(want) ? want : REVIEW_SIDE_MIN
  return Math.round(Math.min(upper, Math.max(REVIEW_SIDE_MIN, value)))
}

/** 默认宽度：面板宽度的 28%，夹在允许区间内（与改造前的视觉一致） */
export function defaultReviewSideWidth(panelWidth: number): number {
  return clampReviewSideWidth(panelWidth, panelWidth * 0.28)
}

/** 目录宽度与「是否收起」分开存；重开时恢复之前的宽度 */
export interface ReviewSidePrefs {
  /** null = 还没设过（用默认宽度） */
  width: number | null
  open: boolean
}

export const REVIEW_SIDE_DEFAULT_PREFS: ReviewSidePrefs = { width: null, open: true }

/** 解析持久化值：坏数据退回默认，不因为一个字段把目录弄没 */
export function normalizeReviewSidePrefs(value: unknown): ReviewSidePrefs {
  if (!value || typeof value !== 'object') return { ...REVIEW_SIDE_DEFAULT_PREFS }
  const input = value as Partial<ReviewSidePrefs>
  const width =
    typeof input.width === 'number' && Number.isFinite(input.width) && input.width > 0
      ? Math.round(input.width)
      : null
  return { width, open: input.open !== false }
}
