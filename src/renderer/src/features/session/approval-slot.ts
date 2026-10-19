import { useLayoutEffect, useSyncExternalStore } from 'react'

type Listener = () => void

const claims = new Map<string, number>()
const listeners = new Set<Listener>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function claimApprovalSlot(id: string): () => void {
  claims.set(id, (claims.get(id) ?? 0) + 1)
  emit()
  return () => {
    const left = (claims.get(id) ?? 1) - 1
    if (left > 0) claims.set(id, left)
    else claims.delete(id)
    emit()
  }
}

export function approvalSlotClaimed(id: string | null | undefined): boolean {
  return !!id && (claims.get(id) ?? 0) > 0
}

export function useApprovalSlotVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

export function useApprovalSlotClaimed(id: string | null | undefined): boolean {
  useSyncExternalStore(subscribe, () => version, () => version)
  return approvalSlotClaimed(id)
}

export function useClaimApprovalSlot(id: string | null | undefined): void {
  useLayoutEffect(() => (id ? claimApprovalSlot(id) : undefined), [id])
}
