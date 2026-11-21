import { useCallback, useSyncExternalStore } from 'react'
import type { AntigravityModel, AntigravityModels } from '../../../shared/antigravity'
import { pick } from '../../../shared/ui-lang'

type Discovery = { loading?: boolean; models?: AntigravityModel[]; error?: string }
type Entry = { snapshot: Discovery; expiresAt?: number; request?: Promise<void> }
const MAX_PROJECTS = 32
const CACHE_MS = 60_000

export function createAntigravityDiscovery(fetchModels: (cwd: string) => Promise<AntigravityModels>, now = Date.now) {
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    snapshot: (cwd: string | undefined) => cwd ? entries.get(cwd)?.snapshot : undefined,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    discover(cwd: string, refresh = false): Promise<void> | undefined {
      const previous = entries.get(cwd)
      entries.delete(cwd)
      if (previous && (previous.request || (!refresh && previous.expiresAt !== undefined && now() < previous.expiresAt))) {
        entries.set(cwd, previous)
        return previous.request
      }
      const entry: Entry = { snapshot: { loading: true, models: previous?.snapshot.models } }
      entries.set(cwd, entry)
      if (entries.size > MAX_PROJECTS) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
      const finish = (snapshot: Discovery) => {
        if (entries.get(cwd) !== entry) return
        entry.snapshot = snapshot
        entry.request = undefined
        if (!snapshot.error) entry.expiresAt = now() + CACHE_MS
        notify()
      }
      entry.request = Promise.resolve().then(() => fetchModels(cwd)).then(({ available }) => {
        finish({ models: available })
      }, (error: unknown) => {
        const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
        const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '').trim()
        finish({ error: message || pick('无法检测 Antigravity 模型，请重试。', 'Could not discover Antigravity models. Try again.') })
      })
      notify()
      return entry.request
    }
  }
}

const discoveries = createAntigravityDiscovery((cwd) => window.yan.antigravity.discover(cwd))

export function useAntigravityDiscovery(cwd: string | undefined) {
  const snapshot = useCallback(() => discoveries.snapshot(cwd), [cwd])
  const discovery = useSyncExternalStore(discoveries.subscribe, snapshot)
  const discover = useCallback((refresh = false) => {
    if (cwd) void discoveries.discover(cwd, refresh)
  }, [cwd])
  return { discovery, discover }
}
