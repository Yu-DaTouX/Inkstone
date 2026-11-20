import { useCallback, useSyncExternalStore } from 'react'
import type { AntigravityModel } from '../../../shared/antigravity'

type Discovery = { loading?: boolean; models?: AntigravityModel[]; error?: string }

const discoveries = new Map<string, Discovery>()
const listeners = new Set<() => void>()

function publish(cwd: string, discovery: Discovery): void {
  discoveries.set(cwd, discovery)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAntigravityDiscovery(cwd: string | undefined) {
  const snapshot = useCallback(() => cwd ? discoveries.get(cwd) : undefined, [cwd])
  const discovery = useSyncExternalStore(subscribe, snapshot)
  const discover = useCallback((refresh = false) => {
    if (!cwd) return
    const previous = discoveries.get(cwd)
    if (previous?.loading || (!refresh && previous?.models?.length)) return
    publish(cwd, { loading: true, models: previous?.models })
    void window.yan.antigravity.discover(cwd).then(({ available }) => {
      publish(cwd, { models: available })
    }, (error: unknown) => {
      publish(cwd, { error: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '') })
    })
  }, [cwd])

  return { discovery, discover }
}
