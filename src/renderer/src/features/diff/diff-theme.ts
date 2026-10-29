import { useSyncExternalStore } from 'react'

export type DiffThemeType = 'light' | 'dark'

export const DIFF_THEMES = { dark: 'pierre-dark', light: 'pierre-light' } as const

export interface DiffSurfaceMetrics {
  themeType: DiffThemeType
  lineHeight: number
  barHeight: number
}

const FALLBACK: DiffSurfaceMetrics = { themeType: 'dark', lineHeight: 20, barHeight: 32 }

let cached: DiffSurfaceMetrics = FALLBACK

function pixels(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function readMetrics(): DiffSurfaceMetrics {
  if (typeof document === 'undefined') return FALLBACK
  const root = document.documentElement
  const style = getComputedStyle(root)
  const next: DiffSurfaceMetrics = {
    themeType: root.dataset.theme === 'light' ? 'light' : 'dark',
    lineHeight: pixels(style, '--t-code-lh', FALLBACK.lineHeight),
    barHeight: pixels(style, '--size-bar', FALLBACK.barHeight)
  }
  if (
    next.themeType !== cached.themeType ||
    next.lineHeight !== cached.lineHeight ||
    next.barHeight !== cached.barHeight
  ) {
    cached = next
  }
  return cached
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => undefined
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-density', 'class', 'style'] })
  return () => observer.disconnect()
}

export function useDiffSurfaceMetrics(): DiffSurfaceMetrics {
  return useSyncExternalStore(subscribe, readMetrics, () => FALLBACK)
}

export const DIFF_UNSAFE_CSS = `
:host {
  --diffs-font-size: var(--t-code);
  --diffs-line-height: var(--t-code-lh);
  --diffs-font-family: var(--font-mono);
  --diffs-header-font-family: var(--font-ui);
}

[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-ui) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--bg) !important;
  --diffs-light-bg: var(--bg) !important;
  --diffs-dark-bg: var(--bg) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-addition-color-override: var(--add);
  --diffs-deletion-color-override: var(--del);
  --diffs-modified-color-override: var(--accent);
  --diffs-fg-number-override: var(--fg3);
  --diffs-bg-addition-override: color-mix(in srgb, var(--add) 55%, var(--bg));
  --diffs-bg-deletion-override: color-mix(in srgb, var(--del) 55%, var(--bg));
  --diffs-bg-context-override: color-mix(in srgb, var(--bg) 97%, var(--fg));
  --diffs-bg-separator-override: color-mix(in srgb, var(--bg) 95%, var(--fg));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--bg) 90%, var(--fg));
  background-color: var(--diffs-bg) !important;
}

[data-diff-type="split"][data-overflow="wrap"] {
  --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr);
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  height: var(--size-bar) !important;
  min-height: var(--size-bar) !important;
  padding-block: 0 !important;
  padding-inline: var(--s-8) var(--s-12) !important;
  background-color: var(--surface) !important;
  border-bottom: 1px solid var(--line) !important;
  color: var(--fg2) !important;
  font-family: var(--font-ui) !important;
  font-size: var(--t-footnote) !important;
  line-height: 1 !important;
  align-items: center !important;
}

[data-diffs-header] [data-header-content],
[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
}

[data-diffs-header] :is([data-title], [data-prev-name]) {
  line-height: var(--t-footnote-lh) !important;
}

[data-diffs-header] :is([data-additions-count], [data-deletions-count]) {
  font-family: var(--font-mono) !important;
  font-size: var(--t-caption) !important;
  font-variant-numeric: tabular-nums;
}

[data-change-icon="new"] { color: var(--add) !important; }
[data-change-icon="deleted"] { color: var(--del) !important; }
[data-change-icon="change"],
[data-change-icon="rename-pure"],
[data-change-icon="rename-changed"] { color: var(--fg3) !important; }

[data-separator="metadata"],
[data-separator="line-info"],
[data-separator="line-info-basic"] {
  height: 24px !important;
  margin-block: 0 !important;
}

[data-separator] [data-separator-wrapper],
[data-separator] [data-separator-content] {
  color: var(--fg3) !important;
  font-family: var(--font-ui) !important;
  font-size: var(--t-caption) !important;
}

[data-utility-button] {
  border-radius: var(--r-xs) !important;
}

[data-expand-button]:focus-visible {
  outline: none !important;
  color: var(--diffs-fg) !important;
  box-shadow: var(--ring-focus-inset) !important;
}

[data-diff],
[data-file] {
  transition: opacity var(--dur-base) var(--ease);
}

@starting-style {
  [data-diff],
  [data-file] {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-diff],
  [data-file] {
    transition: none;
  }
}
`
