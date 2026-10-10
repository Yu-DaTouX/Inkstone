/**
 * 上下文裁剪与自动压缩的档位和触发线。
 *
 * 实际执行在随包扩展 resources/pi-extensions/context-trim.js（它是独立的 JS，不能 import 这里）；
 * 两边的公式必须一致，test-unit 里有一条对照断言。
 */
export const CONTEXT_TRIM_STEPS = [50_000, 80_000, 120_000] as const
/** 自动压缩上限的滑块挡位（用户 2026-10-10 指定）。 */
export const AUTO_COMPACT_STEPS = [100_000, 250_000, 300_000, 400_000, 600_000, 800_000] as const
export const DEFAULT_CONTEXT_TRIM_TOKENS = 80_000
export const DEFAULT_AUTO_COMPACT_TOKENS = 250_000

/**
 * 窗口较小的模型按比例提前：裁剪线不超过窗口的 30%，压缩线不超过窗口的 90%。
 * 90% 给 pi 原生的保底线（窗口 − 16K）留出余量：Codex 272K 选 250K 时实际约 245K 压缩。
 */
export const AUTO_COMPACT_WINDOW_RATIO = 0.9

export function contextTrimAt(setting: number, contextWindow: number): number {
  return contextWindow > 0 ? Math.min(setting, Math.floor(contextWindow * 0.3)) : setting
}

export function autoCompactAt(setting: number, contextWindow: number): number {
  return contextWindow > 0 ? Math.min(setting, Math.floor(contextWindow * AUTO_COMPACT_WINDOW_RATIO)) : setting
}

/** 只收档位里的值；缺省值与脏值都落成 undefined（不写进设置文件）。 */
export function pickTokenStep(value: unknown, steps: readonly number[], fallback: number): number | undefined {
  return typeof value === 'number' && steps.includes(value) && value !== fallback ? value : undefined
}
