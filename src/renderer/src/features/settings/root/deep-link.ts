/**
 * 正式 `openSettings(name)` 事件 → v3 设置路由。
 *
 * v2 的 `useStore.openSettings(tab)` 会写 `settingsOpen / settingsTab`，并自增
 * `settingsRequestRevision`；v3 外壳不读前两个字段（路由在 `state/ui-v3`）。
 * 这里在设置模块加载时安装一次**只读**订阅：请求产生时记录页名，并把 v3 切到
 * 设置路由；设置面板挂载后经 `useSyncExternalStore` 读走，用 `types.ts` 的纯
 * 函数映射到 v3 分区。
 *
 * 为什么按 revision 而不是只比较 `settingsOpen / settingsTab`：v3 返回聊天时
 * 不调用 `closeSettings()`，`settingsOpen` 会一直为 true；用户又可能在设置内
 * 手动切到别的分区（只改面板本地状态）。这两种情况下「再次 openSettings 同一个
 * 页名」都不会改变那两个字段，只比较字段就会漏导航。revision 每次调用都变，
 * 同页、同毫秒的重复请求也能各自通知一次。
 *
 * 兼容：仍监听历史直接写 `settingsOpen / settingsTab` 的调用（不经过
 * `openSettings`），打开时按当前页名补记；字段没变化的无关推送一律忽略，
 * 关闭设置不导航。不包裹、不替换 store action，也不使用全局事件。
 */
import { useStore } from '../../../state/store'
import { useUiV3 } from '../../../state/ui-v3'

export interface SettingsRequest {
  /** 旧 `openSettings(name)` 的原名；空字符串表示调用方没给页名（落到外观）。 */
  view: string
  /** 记录时刻；仅作提示用，可能与其他请求同毫秒。 */
  at: number
  /** 产生本次请求的 `settingsRequestRevision`；同毫秒的两次请求靠它区分。 */
  revision: number
}

let current: SettingsRequest | null = null
const listeners = new Set<() => void>()

export function subscribeSettingsRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getSettingsRequest(): SettingsRequest | null {
  return current
}

function record(view: string, revision: number): void {
  current = { view, at: Date.now(), revision }
  if (useUiV3.getState().route.name !== 'settings') {
    useUiV3.getState().navigate({ name: 'settings' })
  }
  for (const listener of listeners) listener()
}

let installed = false
let uninstallStore: (() => void) | null = null

/** 安装一次 store 订阅；设置模块被外壳静态引用时即生效，不依赖面板是否挂载。 */
export function installSettingsDeepLink(): void {
  if (installed) return
  installed = true

  let lastRevision = useStore.getState().settingsRequestRevision
  let lastTab = useStore.getState().settingsTab
  let lastOpen = useStore.getState().settingsOpen
  /* 已经按 revision 记录过的最新值：订阅重入时同一 revision 不重复记录。 */
  let recordedRevision = -1

  uninstallStore = useStore.subscribe((state) => {
    const revision = state.settingsRequestRevision
    const tab = state.settingsTab ?? ''
    const open = state.settingsOpen

    const revisionChanged = revision !== lastRevision
    const fieldsChanged = tab !== lastTab || open !== lastOpen
    lastRevision = revision
    lastTab = tab
    lastOpen = open

    if (revisionChanged) {
      /* 正式 openSettings：每次调用都是一次新请求，同页、同毫秒也各通知一次。
         若订阅因同步重入拿到同一个 revision，不重复记录。 */
      if (revision === recordedRevision) return
      recordedRevision = revision
      record(tab, revision)
      return
    }

    /* 历史直接写 settingsOpen / settingsTab 的调用：只在「被打开」时补记；
       关闭、或无关推送导致的字段变化不导航。 */
    if (!fieldsChanged || !open) return
    record(tab, revision)
  })
}

/** 测试用：卸下订阅并清空记录，让下一次 `installSettingsDeepLink` 重新安装。 */
export function resetSettingsDeepLinkForTest(): void {
  uninstallStore?.()
  uninstallStore = null
  installed = false
  current = null
  listeners.clear()
}
