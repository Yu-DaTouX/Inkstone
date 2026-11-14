export const STARTUP_INSTALL_WINDOW_MS = 2 * 60 * 1000

export interface StartupInstallProbe {
  pending?: string
  downloaded?: string
  current: string
  automatic: boolean
  busy: boolean
  sinceLaunchMs: number
}

export function startupInstallDue(probe: StartupInstallProbe): boolean {
  return !!probe.pending && probe.pending === probe.downloaded && probe.pending !== probe.current && probe.automatic && !probe.busy && probe.sinceLaunchMs <= STARTUP_INSTALL_WINDOW_MS
}

export interface AppUpdateWhatsNew {
  version: string
  notes: string
}

export interface AppUpdateStatus {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'error' | 'manual'
  current: string
  latest?: string
  percent?: number
  error?: string
  automatic: boolean
  packaged: boolean
  releaseUrl: string
}
