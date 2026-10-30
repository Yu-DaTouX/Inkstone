import type { EnvironmentId, ScopedThreadRef } from './contracts'

export const LOCAL_ENVIRONMENT_ID: EnvironmentId = 'local'

export function scopeThreadRef(
  threadId: string,
  environmentId: EnvironmentId = LOCAL_ENVIRONMENT_ID
): ScopedThreadRef {
  return { environmentId, threadId }
}

export function scopedThreadKey(ref: ScopedThreadRef): string {
  return `${ref.environmentId}:${ref.threadId}`
}

export function parseScopedThreadKey(key: string): ScopedThreadRef | null {
  const at = key.indexOf(':')
  if (at <= 0 || at === key.length - 1) return null
  return { environmentId: key.slice(0, at) as EnvironmentId, threadId: key.slice(at + 1) }
}

export function scopedProjectKey(projectId: string, environmentId: EnvironmentId = LOCAL_ENVIRONMENT_ID): string {
  return `${environmentId}:${projectId}`
}
