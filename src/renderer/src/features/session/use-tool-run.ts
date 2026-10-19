import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toolExpansion } from './tool-expansion'
import { holdRunLabel, type HeldRunLabel } from './tool-run-model'

export const ToolExpansionScope = createContext('')

export function useToolExpansionScope(): string {
  return useContext(ToolExpansionScope)
}

export function useToolExpansion(id: string): [boolean | undefined, (open: boolean) => void] {
  const scope = useContext(ToolExpansionScope)
  const stored = useSyncExternalStore(toolExpansion.subscribe, () => toolExpansion.get(scope, id))
  return [stored, (open: boolean) => toolExpansion.set(scope, id, open)]
}

export function useHeldRunLabel(key: string | null, label: string): HeldRunLabel {
  const heldRef = useRef<HeldRunLabel | null>(null)
  const [, wake] = useState(0)
  const { held, wakeAt } = holdRunLabel(heldRef.current, { key, label }, Date.now())
  heldRef.current = held
  useEffect(() => {
    if (wakeAt === null) return undefined
    const timer = window.setTimeout(() => wake((n) => n + 1), Math.max(0, wakeAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [wakeAt])
  return held
}
