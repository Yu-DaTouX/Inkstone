export function observeHeight(element: HTMLElement | null, onHeight: (height: number) => void): (() => void) | undefined {
  if (!element || typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1]
    if (entry) onHeight(Math.round(entry.contentRect.height))
  })
  observer.observe(element)
  return () => observer.disconnect()
}

export function observeWidth(element: HTMLElement | null, onWidth: (width: number) => void): (() => void) | undefined {
  if (!element) return undefined
  onWidth(element.getBoundingClientRect().width)
  if (typeof ResizeObserver === 'undefined') return undefined
  const observer = new ResizeObserver(() => onWidth(element.getBoundingClientRect().width))
  observer.observe(element)
  return () => observer.disconnect()
}
