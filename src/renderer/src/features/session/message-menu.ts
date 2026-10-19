import { useSyncExternalStore } from 'react'

export interface MessageMenuItem {
  id: string
  label: string
  run: () => void
}

export interface MessageMenuRequest {
  x: number
  y: number
  label: string
  items: MessageMenuItem[]
}

type Listener = () => void

let hosts = 0
let current: MessageMenuRequest | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): MessageMenuRequest | null {
  return current
}

export function registerMessageMenuHost(): () => void {
  hosts += 1
  return () => {
    hosts = Math.max(0, hosts - 1)
    if (!hosts && current) {
      current = null
      emit()
    }
  }
}

export function hasSelectedText(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false
  return (window.getSelection()?.toString() ?? '').trim().length > 0
}

export function openMessageMenu(event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, label: string, items: MessageMenuItem[]): boolean {
  if (!hosts || !items.length || hasSelectedText()) return false
  event.preventDefault()
  event.stopPropagation()
  current = { x: event.clientX, y: event.clientY, label, items }
  emit()
  return true
}

export function closeMessageMenu(): void {
  if (!current) return
  current = null
  emit()
}

export function useMessageMenu(): MessageMenuRequest | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
