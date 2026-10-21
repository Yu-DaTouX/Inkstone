export type AuxLocale = 'zh-CN' | 'en-US'

export type AuxTarget = 'new' | 'current'

export interface AuxProjectOption {
  id: string
  name: string
  path: string
}

export interface AuxModelOption {
  key: string
  id: string
  label: string
  provider: string
}

export interface AuxSessionRef {
  sessionId?: string
  sessionPath?: string
  projectId?: string
  cwd?: string
  title?: string
}

export interface QuickAskStateView {
  locale: AuxLocale
  projects: AuxProjectOption[]
  models: AuxModelOption[]
  currentSession: AuxSessionRef | null
  defaultTarget: AuxTarget
  defaultProjectId: string | null
  defaultModelId: string | null
  accelerator: string
}

export interface QuickAskSubmit {
  prompt: string
  target: AuxTarget
  projectId?: string | null
  model?: { provider: string; id: string } | null
  expand?: boolean
}

export type QuickAskErrorCode =
  | 'empty'
  | 'no-current'
  | 'start-failed'
  | 'create-failed'
  | 'model-failed'
  | 'send-failed'
  | 'unavailable'

export interface QuickAskResult {
  ok: boolean
  code?: QuickAskErrorCode
  message?: string
  sessionId?: string
  sessionPath?: string
  runId?: string
}

export type AuxPush = { ch: 'quick-ask'; payload: unknown }
