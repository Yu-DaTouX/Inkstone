import type { MessageKey, TFunc } from '../i18n'

const LEVEL_LABEL: Record<string, MessageKey> = {
  off: 'think.off',
  minimal: 'think.minimal',
  low: 'think.low',
  medium: 'think.medium',
  high: 'think.high',
  xhigh: 'think.xhigh',
  max: 'think.max'
}

export function levelLabel(t: TFunc, level: string): string {
  const key = LEVEL_LABEL[level]
  return key ? t(key) : level
}
