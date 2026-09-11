/**
 * 界面缩放的**纯计算**部分（不 import electron）。
 *
 * 为什么和 zoom.ts 分开：这里的函数是有测试价值的（DPI 取整规则不直观），
 * 而 zoom.ts 要 import electron 的 screen —— 一旦同文件，
 * scripts/test-unit.mjs 就没法在裸 node 里 import 它了。
 * 同一个理由当初把 normalize.ts 从 agent.ts 拆出来过。
 */

/** 设计基准正文字号，必须与 tokens.css 的 `--fs-base` 保持一致 */
export const BASE_FS = 12.5

/**
 * 自动模式的**目标**正文字号（逻辑像素）。
 *
 * 为什么不是 BASE_FS 本身：
 *   只做「整数设备像素对齐」的话，125% 下 zoom ≈ 1.024 —— 提升 2.4%，
 *   肉眼看不出来，用户抱怨的「太小」等于没解决。
 *   14px 是等宽中文在桌面端的舒适阅读尺寸（终端普遍 13–14px），
 *   对齐后 125% 下落在 18 设备像素（14.4 × 1.25），比原来大 15%。
 */
export const AUTO_TARGET = 14

/** 手动缩放的允许范围（越界一律夹住，防止读到脏设置把界面撑爆） */
export const SCALE_MIN = 0.6
export const SCALE_MAX = 3

/**
 * 快捷键的档位梯子。
 *
 * 为什么用固定档位而不是每次 ±0.1：
 *   浮点数连加会漂（1.15 → 1.2500000000000002），写进设置文件很难看，
 *   而且用户按回原档位需要恰好相等的次数。档位是有限集合，可逆。
 */
export const SCALE_LADDER = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2] as const

/** 把任意输入夹成合法倍率；非数字一律回落到自动（0） */
export function clampScale(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n === 0) return 0
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n))
}

/**
 * 自动模式算出的 zoom 倍率。
 *
 * `目标 = round(AUTO_TARGET × sf) / sf` 这一步保证 `目标 × sf` 是**整数**
 * （正文恰好落在整数设备像素上），然后 `zoom = 目标 / BASE_FS`。
 *
 * | 系统缩放 sf | 目标×sf | 目标字号 | zoom  | 正文设备像素 |
 * |---|---|---|---|---|
 * | 1.00     | 14      | 14     | 1.120 | 14 |
 * | 1.25     | 17.5→18 | 14.4   | 1.152 | 18 |
 * | 1.50     | 21      | 14     | 1.120 | 21 |
 * | 1.75     | 24.5→25 | 14.286 | 1.143 | 25 |
 * | 2.00     | 28      | 14     | 1.120 | 28 |
 */
export function autoZoom(scaleFactor: number): number {
  const sf = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
  const target = Math.round(AUTO_TARGET * sf) / sf
  return target / BASE_FS
}

/** 最终生效的 zoom：手动优先，其次自动 */
export function effectiveZoom(uiScale: number, scaleFactor: number): number {
  const s = clampScale(uiScale)
  return s > 0 ? s : autoZoom(scaleFactor)
}

/**
 * 快捷键一步的**最小相对变化量**。
 *
 * 为什么需要它：自动值不落在梯子上。在 125% 屏上自动是 1.152，
 * 而梯子里有 1.15 —— 从自动往下按 Ctrl+- 会降到 1.15，
 * 只缩小 0.2%，用户会以为「按了没反应」，得再按一次才动。
 * 所以低于这个阈值的档位一律跳过，保证**按一下就看得出变化**。
 */
const MIN_STEP = 0.04

/**
 * 沿档位梯子走一步。`cur` 是**当前生效的**倍率（自动模式下就是 autoZoom 的结果）。
 *
 * 为什么要传生效值而不是 uiScale：
 *   在 125% 上 auto 已经是 1.152，若拿 uiScale=0 当起点，
 *   按 Ctrl+= 会先跳到 0.85（梯子第一档），界面突然变小。
 *   拿 1.152 当起点则下一档是 1.3，符合「放大」的直觉。
 */
export function stepScaleFrom(cur: number, dir: 1 | -1): number {
  const min = Math.abs(cur) * MIN_STEP
  const rungs =
    dir > 0
      ? SCALE_LADDER.filter((v) => v > cur + min)
      : [...SCALE_LADDER].reverse().filter((v) => v < cur - min)
  if (rungs.length) return rungs[0]
  return dir > 0 ? SCALE_MAX : SCALE_MIN
}

/** 一份完整状态（纯计算，不含屏幕信息） */
export interface ZoomMath {
  /** 0 = 自动 */
  uiScale: number
  /** 实际应用的 zoom */
  effective: number
  /** 自动模式下会用的倍率 */
  autoScale: number
}

export function zoomMath(uiScale: unknown, scaleFactor: number): ZoomMath {
  const s = clampScale(uiScale)
  return {
    uiScale: s,
    effective: s > 0 ? s : autoZoom(scaleFactor),
    autoScale: autoZoom(scaleFactor)
  }
}
