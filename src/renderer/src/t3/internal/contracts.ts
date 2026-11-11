export type EnvironmentId = 'local'
export type RunId = string
export type MessageId = string
export type PlanId = string
export type ProviderInstanceId = string

export type EnvironmentMachineKind =
  | 'server'
  | 'cloud'
  | 'linux'
  | 'desktop'
  | 'laptop'
  | 'mac-mini'
  | 'mac-studio'

export type PendingSubagentRequest = 'approval' | 'user_input'

export type OrchestrationV2RunStatus =
  | 'preparing'
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'rolled_back'

export type OrchestrationV2ProviderFailureClass = 'usage_limit' | 'auth' | 'rate_limit' | 'network' | 'unknown'

export type SidebarProjectSortOrder = 'manual' | 'updated_at' | 'created_at'
export type TimestampFormat = 'locale' | '12-hour' | '24-hour'

export interface ContextMenuItem<T extends string = string> {
  id: T
  label: string
  destructive?: boolean
  disabled?: boolean
  header?: boolean
  icon?: string
  separatorBefore?: boolean
  checked?: boolean
  children?: readonly ContextMenuItem<T>[]
}

export type AppLang = 'zh-CN' | 'en-US'
