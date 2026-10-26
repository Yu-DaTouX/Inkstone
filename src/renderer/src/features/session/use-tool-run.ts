import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toolExpansion } from './tool-expansion'
import { holdRunLabel, type HeldRunLabel } from './tool-run-model'
import { DEFAULT_TRANSCRIPT_VIEW, type TranscriptView } from './transcript-view-model'

export const ToolExpansionScope = createContext('')

export const TranscriptViewScope = createContext<TranscriptView>(DEFAULT_TRANSCRIPT_VIEW)

export function useTranscriptViewScope(): TranscriptView {
  return useContext(TranscriptViewScope)
}

export const AsideFitScope = createContext(false)

export function useAsideFit(): boolean {
  return useContext(AsideFitScope)
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
