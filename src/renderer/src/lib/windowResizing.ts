export const WINDOW_RESIZE_SETTLE_MS = 160

export function installWindowResizing(root: HTMLElement = document.documentElement): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const onResize = (): void => {
    if (root.dataset.windowResizing === undefined) root.dataset.windowResizing = '1'
    clearTimeout(timer)
    timer = setTimeout(() => {
      delete root.dataset.windowResizing
    }, WINDOW_RESIZE_SETTLE_MS)
  }
  window.addEventListener('resize', onResize)
  return () => {
    clearTimeout(timer)
    window.removeEventListener('resize', onResize)
    delete root.dataset.windowResizing
  }
}
