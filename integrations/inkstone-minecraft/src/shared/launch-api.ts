import type { LoaderKind } from './api.ts'

export type LaunchStepId = 'account' | 'java' | 'files' | 'process' | 'window'
export type LaunchStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface LaunchStepProgress {
  done: number
  total: number
  unit: 'files' | 'bytes' | 'steps'
}

export interface LaunchStep {
  id: LaunchStepId
  label: string
  state: LaunchStepState
  detail: string | null
  progress: LaunchStepProgress | null
}

export type PreflightLevel = 'ok' | 'warn' | 'block'
export type PreflightActionKind = 'install-deps' | 'repair' | 'java' | 'memory' | 'disable-mod'

export interface PreflightItem {
  id: 'account' | 'java' | 'memory' | 'deps' | 'duplicates' | 'files'
  level: PreflightLevel
  title: string
  detail: string
  action: PreflightActionKind | null
  value: string | null
}

export interface PreflightRequest {
  folder: string
  versionId: string
  javaPath?: string
  maxMemoryMb?: number
}

export type SettingSource = 'instance' | 'pcl' | 'global'

export interface LaunchEffective {
  javaPath: string | null
  javaMajor: number | null
  javaSource: SettingSource
  maxMemoryMb: number
  memorySource: SettingSource
  jvmArgs: string
  jvmSource: SettingSource
  gameArgs: string
  gameArgsSource: SettingSource
  width: number | null
  height: number | null
  fullscreen: boolean
  windowSource: SettingSource
}

export interface PreflightReport {
  versionId: string
  loader: LoaderKind
  blocked: boolean
  items: PreflightItem[]
  javaPath: string | null
  javaMajor: number | null
  maxMemoryMb: number
}
