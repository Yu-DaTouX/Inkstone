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
