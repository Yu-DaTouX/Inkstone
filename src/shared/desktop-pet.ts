export const DESKTOP_PET_PACKAGE = 'dsh-pet'
export const DESKTOP_PET_VERSION = '0.3.7'

export interface DesktopPetEdgeStatus {
  state: 'idle' | 'running' | 'done' | 'skipped' | 'failed'
  done: number
  total: number
  message?: string
}

export interface DesktopPetStatus {
  installed: boolean
  version: string
  running: boolean
  autoStart: boolean
  model: string | null
  installDir: string
  edges: DesktopPetEdgeStatus
  log: string[]
}

export interface DesktopPetResult {
  ok: boolean
  status?: DesktopPetStatus
  error?: string
}

export interface DesktopPetBridge {
  status(): Promise<DesktopPetStatus>
  install(): Promise<DesktopPetResult>
  start(): Promise<DesktopPetResult>
  stop(): Promise<DesktopPetResult>
  uninstall(): Promise<DesktopPetResult>
  autoStart(enabled: boolean): Promise<DesktopPetResult>
  setModel(model: string | null): Promise<DesktopPetResult>
}
