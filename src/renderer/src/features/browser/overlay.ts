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
