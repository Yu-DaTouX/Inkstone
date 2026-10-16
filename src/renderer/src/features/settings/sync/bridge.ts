import type { SyncBridge } from '../../../../../shared/sync'

export function syncBridge(): SyncBridge | null {
  const yan = (window as unknown as { yan?: { sync?: SyncBridge } }).yan
  const sync = yan?.sync
  if (
    !sync ||
    typeof sync.status !== 'function' ||
    typeof sync.configure !== 'function' ||
    typeof sync.now !== 'function' ||
    typeof sync.conflicts !== 'function' ||
    typeof sync.resolve !== 'function' ||
    typeof sync.exportSession !== 'function' ||
    typeof sync.importSession !== 'function'
  ) {
    return null
  }
  return sync
}
