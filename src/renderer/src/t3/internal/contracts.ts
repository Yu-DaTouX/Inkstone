export type EnvironmentId = 'local'
export type RunId = string
export type MessageId = string
export type ProviderInstanceId = string

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

export type AppLang = 'zh-CN' | 'en-US'
