export type AndroidComponentId = 'platformTools' | 'emulator' | 'systemImage' | 'jdk' | 'accel'

export const ANDROID_COMPONENTS: AndroidComponentId[] = ['platformTools', 'emulator', 'systemImage', 'jdk', 'accel']

export const ANDROID_SYSTEM_IMAGE_API = 36
export const ANDROID_DEFAULT_AVD = 'Inkstone_API_36'

export type AndroidComponentState = 'installed' | 'missing' | 'unsupported' | 'unknown'

export interface AndroidComponentStatus {
  id: AndroidComponentId
  state: AndroidComponentState
  detail?: string
  path?: string
  bytes?: number
}

export interface AndroidInstallProgress {
  queue: AndroidComponentId[]
  current: AndroidComponentId | null
  phase: 'download' | 'extract' | 'setup' | 'idle'
  received: number
  total: number
  done: AndroidComponentId[]
  state: 'running' | 'done' | 'failed' | 'cancelled'
  error?: string
}

export interface AndroidSdkStatus {
  sdkRoot: string
  sdkSource: 'env' | 'studio' | 'managed'
  components: AndroidComponentStatus[]
  avds: string[]
  install: AndroidInstallProgress | null
}

export interface AndroidDevice {
  serial: string
  state: string
  model?: string
  emulator: boolean
}

export type AndroidControl =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x: number; y: number; toX: number; toY: number; ms?: number }
  | { kind: 'key'; key: 'back' | 'home' | 'recents' | 'power' | 'wake' | 'volume_up' | 'volume_down' }
  | { kind: 'text'; text: string }

export interface AndroidFrame {
  serial: string
  png: Uint8Array
  width: number
  height: number
  sequence: number
}
