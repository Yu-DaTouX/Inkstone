let generation = 0

export function runWithLayoutTransitionFlag(root: HTMLElement, start: () => { finished?: Promise<unknown> } | undefined): void {
  const mine = ++generation
  root.dataset.splitLayoutVt = ''
  const clear = (): void => {
    if (mine === generation) delete root.dataset.splitLayoutVt
  }
  const finished = start()?.finished
  if (finished) void finished.then(clear, clear)
  else clear()
}
