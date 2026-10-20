export function observeHeight(element: HTMLElement | null, onHeight: (height: number) => void): (() => void) | undefined {
  if (!element || typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1]
    if (entry) onHeight(Math.round(entry.contentRect.height))
  })
  observer.observe(element)
  return () => observer.disconnect()
}
