const loaders: Array<() => Promise<unknown>> = [
  () => import('../features/preview/PreviewPane'),
  () => import('../features/terminal/TerminalPane'),
  () => import('../features/editor/CodeEditor'),
  () => import('../features/diff/DiffView'),
  () => import('../features/diff/DiffView'),
  () => import('../features/usage/UsagePage'),
  () => import('../features/collab'),
  () => import('../features/artifacts/ArtifactLibraryPage')
]

const START_DELAY_MS = 2500
const STEP_DELAY_MS = 350

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: 1500 })
    else window.setTimeout(resolve, 50)
  })
}

export function installIdlePrefetch(): void {
  window.setTimeout(() => {
    void (async () => {
      for (const load of loaders) {
        await whenIdle()
        await load().catch(() => undefined)
        await new Promise((resolve) => window.setTimeout(resolve, STEP_DELAY_MS))
      }
    })()
  }, START_DELAY_MS)
}
