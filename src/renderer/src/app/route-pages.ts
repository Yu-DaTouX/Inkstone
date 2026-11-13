import { preloadable } from '../lib/preloadable'
import { prefetchUsageStats } from '../features/usage/UsageOverview'
import { preloadPreviewPane, preloadTerminalPane } from '../features/workbench/panes'

const usagePage = preloadable<Record<string, never>>(() => import('../features/usage/UsagePage').then((m) => ({ default: m.UsagePage })))
const artifactLibraryPage = preloadable<Record<string, never>>(() => import('../features/artifacts/ArtifactLibraryPage').then((m) => ({ default: m.ArtifactLibraryPage })))

export const UsagePage = usagePage.Component
export const ArtifactLibraryPage = artifactLibraryPage.Component

const IDLE_PRELOADS: ReadonlyArray<() => Promise<unknown>> = [
  usagePage.preload,
  () => Promise.resolve(prefetchUsageStats()),
  preloadPreviewPane,
  preloadTerminalPane,
  artifactLibraryPage.preload
]

export function scheduleIdlePreloads(): () => void {
  let cancelled = false
  let handle = 0
  const step = (index: number): void => {
    if (cancelled || index >= IDLE_PRELOADS.length) return
    handle = window.requestIdleCallback(() => {
      void IDLE_PRELOADS[index]().catch(() => undefined).finally(() => step(index + 1))
    }, { timeout: 4000 })
  }
  step(0)
  return () => {
    cancelled = true
    window.cancelIdleCallback(handle)
  }
}
