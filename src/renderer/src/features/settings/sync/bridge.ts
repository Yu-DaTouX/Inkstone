/**
 * 渲染端读取 `window.yan.sync` 的局部类型守卫。
 *
 * 为什么不在 preload 类型文件里声明：preload 是热点文件，v3 的接线补丁由整合者
 * 统一落地（见 .tmp/v3-ui/hotspot 说明）。在那之前，这里用局部守卫读取，
 * 拿不到时返回 null，界面如实提示「尚未接线」——绝不假装同步可用，
 * 也不用 `any` 绕过类型检查。
 */
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
