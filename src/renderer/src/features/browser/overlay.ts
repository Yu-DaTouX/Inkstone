export const BLOCKING_OVERLAY_SELECTOR = [
  '.ui-modal-overlay',
  '.ui-popover[data-open]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]'
].join(', ')

export function hasBlockingOverlay(query: (selector: string) => boolean): boolean {
  return query(BLOCKING_OVERLAY_SELECTOR)
}

export interface OverlayCandidate {
  contains(other: OverlayCandidate | null): boolean
}

export function blocksSurface<T extends OverlayCandidate>(overlays: Iterable<T>, surface: T | null): boolean {
  for (const overlay of overlays) {
    if (surface && overlay.contains(surface)) continue
    return true
  }
  return false
}
