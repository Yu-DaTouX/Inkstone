/**
 * 空间视图（实施-25 P04 / T04-1）。
 *
 * **刻意与 `daily-view.ts` 分开**：那边只记「上次停在对话还是地图」。
 * 如果把「空间概览」塞进同一个枚举，用户从空间视图退回地图时，
 * 要么覆盖掉他的地图偏好，要么得在类型里额外记「前一个视图是什么」——
 * 两种都是把两个无关偏好耦合起来。这里只记「空间视图里停在哪个入口」，
 * 而「此刻是否在空间视图」是内存状态（与地图的 open 一样，不进设置）。
 *
 * 另外：不落任何业务数据。当前展示哪个空间由**当前会话的 `spaceId`** 决定
 *（T04-8：导航只是投影），这里存不下也不需要存。
 */

export type SpaceView = 'overview' | 'library' | 'artifact'

export const SPACE_VIEW_KEY = 'yan.space-view'

export const SPACE_VIEWS: readonly SpaceView[] = ['overview', 'library', 'artifact']

function isSpaceView(value: unknown): value is SpaceView {
  return typeof value === 'string' && (SPACE_VIEWS as readonly string[]).includes(value)
}

/** 读不到 / 存的是旧版本里的非法值 → 回落到概览（概览是永远成立的默认页） */
export function readSpaceView(): SpaceView {
  if (typeof localStorage === 'undefined') return 'overview'
  try {
    const raw = localStorage.getItem(SPACE_VIEW_KEY)
    return isSpaceView(raw) ? raw : 'overview'
  } catch {
    return 'overview'
  }
}

export function writeSpaceView(view: SpaceView): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SPACE_VIEW_KEY, view)
  } catch {
    /* 存不了只是下次打开回到概览，不阻塞切换 */
  }
}
