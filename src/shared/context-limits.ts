export const AUTO_COMPACT_STEPS = [100_000, 250_000, 300_000, 400_000, 600_000, 800_000] as const
export const DEFAULT_AUTO_COMPACT_TOKENS = 400_000

export const AUTO_COMPACT_WINDOW_RATIO = 0.9

export function autoCompactAt(setting: number, contextWindow: number): number {
  return contextWindow > 0 ? Math.min(setting, Math.floor(contextWindow * AUTO_COMPACT_WINDOW_RATIO)) : setting
}

export function pickTokenStep(value: unknown, steps: readonly number[], fallback: number): number | undefined {
  return typeof value === 'number' && steps.includes(value) && value !== fallback ? value : undefined
}
