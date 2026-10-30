import { compactAgo } from '../../features/sidebar/sidebar-model'

export type EnvironmentId = 'local'
export type ThreadId = string
export type ProjectId = string
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

export type SidebarThreadSortOrder = 'updated_at' | 'created_at'
export type SidebarProjectSortOrder = 'manual' | 'updated_at' | 'created_at'
export type TimestampFormat = 'locale' | '12-hour' | '24-hour'

export interface ScopedThreadRef {
  readonly environmentId: EnvironmentId
  readonly threadId: ThreadId
}

export interface ScopedProjectRef {
  readonly environmentId: EnvironmentId
  readonly projectId: ProjectId
}

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

export function parseTimestampDate(at: number | string | null | undefined): number | null {
  if (at === null || at === undefined) return null
  const ms = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(ms) ? ms : null
}

export function formatRelativeTimeLabel(
  at: number | string | null | undefined,
  lang: AppLang,
  now = Date.now()
): string {
  const ms = parseTimestampDate(at)
  if (ms === null) return ''
  return compactAgo(ms, now, lang)
}
