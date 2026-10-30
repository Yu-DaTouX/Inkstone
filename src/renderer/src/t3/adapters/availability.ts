import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { PanelUnavailableReason } from '../../features/workbench/right-panel-text'
import type { WorkspaceOwner } from '../../features/workbench/types'
import type { PanelToolKind } from '../../state/right-panel'
import type { AndroidSdkStatus } from '../../../../shared/android-sdk'
import type { GithubStatus } from '../../../../shared/github'

export type { PanelUnavailableReason } from '../../features/workbench/right-panel-text'

export type GithubProbe = 'ready' | 'no-cli' | 'no-auth' | 'no-repo'
export type AndroidProbe = 'ready' | 'no-sdk' | 'no-device'

interface CwdProbe {
  git: boolean | null
  github: GithubProbe | null
}

export interface WorkspaceProbes {
  git: boolean | null
  github: GithubProbe | null
  android: AndroidProbe | null
  nativeSession: boolean
}

export interface PanelAvailability {
  available: boolean
  reason: PanelUnavailableReason | null
}

export type AvailabilityMap = Readonly<Record<PanelToolKind, PanelAvailability>>

export const PROBE_TTL_MS = 15_000

const AVAILABLE: PanelAvailability = Object.freeze({ available: true, reason: null })

function unavailable(reason: PanelUnavailableReason): PanelAvailability {
  return { available: false, reason }
}

interface ProbeState {
  byCwd: Record<string, CwdProbe>
  android: AndroidProbe | null
  patch: (cwd: string, next: Partial<CwdProbe>) => void
  setAndroid: (probe: AndroidProbe) => void
}

const useProbeStore = create<ProbeState>((set) => ({
  byCwd: {},
  android: null,
  patch: (cwd, next) =>
    set((state) => {
      const current = state.byCwd[cwd] ?? { git: null, github: null }
      const merged = { ...current, ...next }
      if (merged.git === current.git && merged.github === current.github) return state
      return { byCwd: { ...state.byCwd, [cwd]: merged } }
    }),
  setAndroid: (probe) => set((state) => (state.android === probe ? state : { android: probe }))
}))

const startedAt = new Map<string, number>()
const inFlight = new Set<string>()
let androidProbedAt = 0

interface NativeSessionWindow {
  yan?: { nativeSession?: unknown }
}

function hasNativeSession(): boolean {
  if (typeof window === 'undefined') return false
  const yan = (window as unknown as NativeSessionWindow).yan
  return typeof yan?.nativeSession === 'function'
}

function androidProbeOf(status: AndroidSdkStatus): AndroidProbe {
  if (!status.sdkRoot) return 'no-sdk'
  if (status.avds.length > 0) return 'ready'
  return status.components.some((component) => component.id === 'platformTools' && component.state === 'installed') ? 'ready' : 'no-sdk'
}

function githubProbeOf(status: GithubStatus): GithubProbe {
  if (!status.installed) return 'no-cli'
  if (!status.authed) return 'no-auth'
  if (!status.repo) return 'no-repo'
  return 'ready'
}

function probeAndroid(force: boolean): void {
  const now = Date.now()
  if (!force && now - androidProbedAt < PROBE_TTL_MS) return
  androidProbedAt = now
  const android = typeof window === 'undefined' ? undefined : window.yan?.android
  if (!android) return
  void android
    .status()
    .then((status) => androidProbeOf(status), () => 'no-sdk' as AndroidProbe)
    .then((probe) => useProbeStore.getState().setAndroid(probe))
    .catch(() => undefined)
}

function probe(cwd: string, force = false): void {
  if (!cwd) return
  if (inFlight.has(cwd)) return
  const now = Date.now()
  if (!force && now - (startedAt.get(cwd) ?? 0) < PROBE_TTL_MS) return
  const yan = typeof window === 'undefined' ? undefined : window.yan
  if (!yan) return
  startedAt.set(cwd, now)
  inFlight.add(cwd)
  const git = yan.git ? yan.git.state(cwd).then((state) => !!state.repo, () => false) : Promise.resolve<boolean | null>(null)
  const github = yan.github ? yan.github.status(cwd).then((status) => githubProbeOf(status), () => 'no-cli' as GithubProbe) : Promise.resolve<GithubProbe | null>(null)
  Promise.all([git, github])
    .then(([repo, gh]) => useProbeStore.getState().patch(cwd, { git: repo, github: gh }))
    .catch(() => undefined)
    .then(() => inFlight.delete(cwd))
  probeAndroid(force)
}

function watch(cwd: string): () => void {
  const refresh = (): void => probe(cwd, true)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  return () => {
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refresh)
  }
}

export function useWorkspaceProbes(cwd: string | null, enabled: boolean): WorkspaceProbes {
  const probeState = useProbeStore((state) => (cwd ? state.byCwd[cwd] : undefined))
  const android = useProbeStore((state) => state.android)
  useEffect(() => {
    if (!cwd || !enabled || typeof window === 'undefined') return undefined
    probe(cwd)
    return watch(cwd)
  }, [cwd, enabled])
  return useMemo(
    () => ({ git: probeState?.git ?? null, github: probeState?.github ?? null, android, nativeSession: hasNativeSession() }),
    [probeState, android]
  )
}

export function panelAvailability(kind: PanelToolKind, owner: WorkspaceOwner | null, probes: WorkspaceProbes): PanelAvailability {
  if (kind === 'context' || kind === 'logs' || kind === 'quota') return AVAILABLE
  if (!owner) return unavailable('no-session')
  if (kind === 'terminal' || kind === 'browser') return owner.active ? AVAILABLE : unavailable('inactive')
  if (kind === 'branch') {
    if (!owner.sessionId) return unavailable('no-session')
    return probes.nativeSession ? AVAILABLE : unavailable('no-native-session')
  }
  if (kind === 'files' || kind === 'changes' || kind === 'pullRequests') {
    if (probes.git === false) return unavailable('no-repo')
    if (kind !== 'pullRequests') return AVAILABLE
    if (probes.github === 'no-cli') return unavailable('no-github')
    if (probes.github === 'no-auth') return unavailable('no-gh-auth')
    if (probes.github === 'no-repo') return unavailable('no-repo')
    return AVAILABLE
  }
  if (kind === 'device') {
    if (probes.android === 'no-sdk') return unavailable('no-sdk')
    if (probes.android === 'no-device') return unavailable('no-device')
    return AVAILABLE
  }
  return AVAILABLE
}

export function availabilityMap(owner: WorkspaceOwner | null, probes: WorkspaceProbes): AvailabilityMap {
  return {
    changes: panelAvailability('changes', owner, probes),
    terminal: panelAvailability('terminal', owner, probes),
    files: panelAvailability('files', owner, probes),
    browser: panelAvailability('browser', owner, probes),
    context: panelAvailability('context', owner, probes),
    branch: panelAvailability('branch', owner, probes),
    logs: panelAvailability('logs', owner, probes),
    quota: panelAvailability('quota', owner, probes),
    device: panelAvailability('device', owner, probes),
    pullRequests: panelAvailability('pullRequests', owner, probes)
  }
}

export function usePanelAvailability(owner: WorkspaceOwner | null, enabled = true): AvailabilityMap {
  const probes = useWorkspaceProbes(owner?.cwd ?? null, enabled && !!owner)
  return useMemo(() => availabilityMap(owner, probes), [owner, probes])
}
