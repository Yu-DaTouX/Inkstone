export function ownedViewVisible(activeId: string | null, tabId: string, requested: boolean): boolean {
  if (!requested) return false
  return tabId === activeId
}

export interface StateFlush {
  schedule(): void
  cancel(): void
}

export function createStateFlush(run: () => void, delayMs = 150): StateFlush {
  let timer: NodeJS.Timeout | null = null
  const cancel = (): void => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }
  return {
    schedule() {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        run()
      }, delayMs)
      timer.unref?.()
    },
    cancel
  }
}
