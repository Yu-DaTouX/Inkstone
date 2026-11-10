import type { PinnedGuardAttachResult } from './net/pinned-network'

export interface PinnedGuardNotice {
  message: string
}

export function pinnedGuardNotice(result: PinnedGuardAttachResult): PinnedGuardNotice | null {
  const raw = result as unknown as { status?: string; message?: string; resolution?: string }
  if (raw.status === 'attached') return null
  if (raw.status === 'system-proxy') return { message: raw.resolution?.trim() || 'system proxy route is not pinned' }
  return { message: raw.message?.trim() || 'pinned network guard failed' }
}
