export interface CompactTabState {
  on: boolean
  need: number
}

export interface CompactTabMetrics {
  stripWidth: number
  viewportWidth: number
  scrollWidth: number
  availableRoom: number
  tolerance?: number
  exitBuffer?: number
}

export const TAB_COMPACT_EXIT_BUFFER = 4

export function availableTabStripRoom(input: {
  stripClientWidth: number
  stripPaddingInline: number
  gap: number
  addWidth: number
  scrollChrome: number
}): number {
  const inner = input.stripClientWidth - input.stripPaddingInline
  const reserved = input.addWidth > 0 ? input.addWidth + input.gap : 0
  return Math.max(0, inner - reserved - input.scrollChrome)
}

export function shouldEnterCompact(state: CompactTabState, metrics: CompactTabMetrics): boolean {
  const tolerance = metrics.tolerance ?? 1
  if (state.on) return false
  if (metrics.stripWidth <= 0 || metrics.viewportWidth <= 0) return false
  return metrics.scrollWidth - metrics.viewportWidth > tolerance
}

export function shouldExitCompact(state: CompactTabState, metrics: CompactTabMetrics): boolean {
  const buffer = metrics.exitBuffer ?? TAB_COMPACT_EXIT_BUFFER
  if (!state.on) return false
  if (metrics.stripWidth <= 0) return false
  return metrics.availableRoom >= state.need + buffer
}
