/**
 * 日常模式的中栏视图状态（实施-18 §3.4）。
 *
 * 只记「上次停在对话还是会话地图」这一个偏好。视图状态本身在 App 的
 * 内存 state 里 —— 不落业务数据、不进 `AppSettings`：地图是纯视图，
 * 跨设备同步或探针读取它都没有意义，写进设置只会制造噪声。
 */

export type DailyView = 'chat' | 'map'

export const DAILY_VIEW_KEY = 'yan.daily-view'

export function readDailyView(): DailyView {
  if (typeof localStorage === 'undefined') return 'chat'
  try {
    return localStorage.getItem(DAILY_VIEW_KEY) === 'map' ? 'map' : 'chat'
  } catch {
    return 'chat'
  }
}

export function writeDailyView(view: DailyView): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DAILY_VIEW_KEY, view)
  } catch {
    /* 存不了只是下次打开回到对话，不阻塞切换 */
  }
}
