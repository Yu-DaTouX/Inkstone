import { useEffect, useState } from 'react'

export const BRANCH_REFRESH_MS = 10_000

export interface WorkspaceGitSnapshot {
  branch: string | null
  dirty: boolean
}

type Listener = (snapshot: WorkspaceGitSnapshot) => void

interface Poller {
  listeners: Set<Listener>
  snapshot: WorkspaceGitSnapshot
  timer: number
  inFlight: boolean
  lastReadAt: number
}

const EMPTY: WorkspaceGitSnapshot = { branch: null, dirty: false }
const pollers = new Map<string, Poller>()
let windowHooked = false

export function workspacePollActive(doc: Pick<Document, 'visibilityState' | 'hasFocus'>): boolean {
  return doc.visibilityState !== 'hidden' && doc.hasFocus()
}

function read(cwd: string, poller: Poller): void {
  const git = window.yan?.git
  if (!git || poller.inFlight) return
  poller.inFlight = true
  poller.lastReadAt = Date.now()
  git
    .state(cwd)
    .then((state) => ({ branch: state.repo?.branch ?? null, dirty: (state.repo?.changedCount ?? 0) > 0 }))
    .catch(() => EMPTY)
    .then((snapshot) => {
      poller.inFlight = false
      if (pollers.get(cwd) !== poller) return
      if (snapshot.branch === poller.snapshot.branch && snapshot.dirty === poller.snapshot.dirty) return
      poller.snapshot = snapshot
      for (const listener of poller.listeners) listener(snapshot)
    })
}

function schedule(cwd: string, poller: Poller): void {
  window.clearInterval(poller.timer)
  poller.timer = 0
  if (!workspacePollActive(document)) return
  if (Date.now() - poller.lastReadAt >= BRANCH_REFRESH_MS) read(cwd, poller)
  poller.timer = window.setInterval(() => read(cwd, poller), BRANCH_REFRESH_MS)
}

function rescheduleAll(): void {
  for (const [cwd, poller] of pollers) schedule(cwd, poller)
}

function hookWindow(): void {
  if (windowHooked) return
  windowHooked = true
  document.addEventListener('visibilitychange', rescheduleAll)
  window.addEventListener('focus', rescheduleAll)
  window.addEventListener('blur', rescheduleAll)
}

function subscribe(cwd: string, listener: Listener): () => void {
  hookWindow()
  let poller = pollers.get(cwd)
  if (!poller) {
    poller = { listeners: new Set(), snapshot: EMPTY, timer: 0, inFlight: false, lastReadAt: 0 }
    pollers.set(cwd, poller)
    read(cwd, poller)
    schedule(cwd, poller)
  }
  poller.listeners.add(listener)
  listener(poller.snapshot)
  const owned = poller
  return () => {
    owned.listeners.delete(listener)
    if (owned.listeners.size) return
    window.clearInterval(owned.timer)
    if (pollers.get(cwd) === owned) pollers.delete(cwd)
  }
}

function useWorkspaceGit(cwd: string | null, enabled: boolean): WorkspaceGitSnapshot {
  const [snapshot, setSnapshot] = useState<WorkspaceGitSnapshot>(EMPTY)
  useEffect(() => {
    if (!cwd || !enabled || typeof window === 'undefined' || !window.yan?.git) {
      setSnapshot(EMPTY)
      return undefined
    }
    return subscribe(cwd, setSnapshot)
  }, [cwd, enabled])
  return snapshot
}

export function useWorkspaceBranch(cwd: string | null, enabled: boolean): string | null {
  return useWorkspaceGit(cwd, enabled).branch
}

export function useWorkspaceHasChanges(cwd: string | null, enabled: boolean): boolean {
  return useWorkspaceGit(cwd, enabled).dirty
}
