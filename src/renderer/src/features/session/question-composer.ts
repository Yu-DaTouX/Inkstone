import { useSyncExternalStore } from 'react'
import type { ExtensionUiRequest } from '../../../../shared/ipc'
import { useStore } from '../../state/store'

let activeId: string | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const formAnswers = new Map<string, (text: string) => boolean>()
let textPort: { read: () => string; clear: () => void } | null = null

export function composerFormField(req: Pick<ExtensionUiRequest, 'form' | 'sensitive' | 'purpose'>): string | null {
  if (!req.form?.length || req.sensitive === true || req.purpose === 'approval') return null
  if (req.form.some((field) => field.kind === 'secret')) return null
  const targets = req.form.filter((field) => field.kind === 'choice' || field.kind === 'multi' || field.kind === 'text')
  return targets.length === 1 ? targets[0].name : null
}

export function answersInComposer(req: Pick<ExtensionUiRequest, 'method' | 'form' | 'sensitive' | 'purpose'>): boolean {
  if (req.form?.length) return composerFormField(req) !== null
  if (req.sensitive === true || req.purpose === 'approval') return false
  return req.method === 'select' || req.method === 'input'
}

export function setComposerFormAnswer(id: string, answer: (text: string) => boolean): () => void {
  formAnswers.set(id, answer)
  return () => {
    if (formAnswers.get(id) === answer) formAnswers.delete(id)
  }
}

export function answerComposerForm(id: string, text: string): boolean {
  return formAnswers.get(id)?.(text) ?? false
}

export function setComposerTextPort(port: { read: () => string; clear: () => void }): () => void {
  textPort = port
  return () => {
    if (textPort === port) textPort = null
  }
}

export function readComposerText(): string {
  return textPort?.read() ?? ''
}

export function clearComposerText(): void {
  textPort?.clear()
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
