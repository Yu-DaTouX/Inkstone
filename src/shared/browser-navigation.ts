/**
 * 浏览器导航的状态判定（纯函数）。
 *
 * 为什么单独一个文件：这些判断主进程（决定要不要把加载失败推给界面）
 * 与渲染端（地址栏草稿与已提交地址的取舍）都要用，而且必须能被单测钉住 ——
 * 塞进 `browser.ts` / `BrowserSurface.tsx` 就只能靠真实窗口碰运气了。
 *
 * 语义边界：这里只处理“哪个地址算数、什么算错误”，
 * 不碰权限、网络边界与下载（那些各有自己的模块）。
 */

/** Chromium `net::ERR_ABORTED`：用户取消、或被新导航取代 —— 不算“打不开” */
export const ERR_ABORTED = -3

export interface BrowserLoadFailure {
  /** Chromium 的 net error（负数） */
  code: number
  description: string
  /** 出错的那个地址（界面据此重试 / 在外部浏览器打开） */
  url: string
}

/**
 * 这次加载失败要不要显示给用户？
 *
 * · 子框架失败（广告 iframe、埋点统计）不打扰用户 —— 顶层页面是好的；
 * · 主动取消 / 被新导航取代（ERR_ABORTED）不是错误，是正常操作。
 */
export function shouldSurfaceLoadError(errorCode: number, isMainFrame: boolean): boolean {
  if (!isMainFrame) return false
  return errorCode !== ERR_ABORTED
}

/**
 * 地址栏该显示什么：**正在编辑的草稿优先**。
 *
 * 后台导航（另一个标签、页面自己跳转、重定向）会不断更新已提交地址，
 * 但用户正在输入时不能把他的输入冲掉 —— 那是“打字打一半被吞”。
 */
export function nextAddressInput(committed: string, draft: string, dirty: boolean): string {
  return dirty ? draft : committed
}

/** 出错时要保留的地址：优先 Chromium 报的 validatedURL，退回当前已知地址 */
export function failureUrl(validatedUrl: string | undefined | null, fallback: string): string {
  const value = (validatedUrl ?? '').trim()
  return value || fallback
}

/**
 * 两个地址是不是同一个已提交地址（末尾斜杠不算差别）。
 *
 * 用途：导航结果回来时判断“这是不是已经被新导航取代的旧结果”。
 */
export function sameCommittedUrl(a: string, b: string): boolean {
  const trim = (value: string): string => value.replace(/\/+$/, '')
  return trim(a ?? '') === trim(b ?? '')
}
