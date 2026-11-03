import { useSyncExternalStore } from 'react'
import type { ExtensionUiRequest } from '../../../../shared/ipc'
import { useStore } from '../../state/store'

let activeId: string | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function answersInComposer(req: Pick<ExtensionUiRequest, 'method' | 'form' | 'sensitive' | 'purpose'>): boolean {
  if (req.form?.length || req.sensitive === true || req.purpose === 'approval') return false
  return req.method === 'select' || req.method === 'input'
}

export function setComposerQuestion(id: string | null): void {
  if (activeId === id) return
  activeId = id
  for (const listener of listeners) listener()
}

export function releaseComposerQuestion(id: string): void {
  if (activeId === id) setComposerQuestion(null)
}

export function composerQuestion(): ExtensionUiRequest | null {
  if (!activeId) return null
  const req = useStore.getState().uiRequests.find((item) => item.id === activeId)
  return req && answersInComposer(req) ? req : null
}

export function useComposerQuestionTitle(): string | null {
  const id = useSyncExternalStore(subscribe, () => activeId)
  return useStore((s) => {
    if (!id) return null
    const req = s.uiRequests.find((item) => item.id === id)
    return req && answersInComposer(req) ? (req.title ?? '') : null
  })
}
