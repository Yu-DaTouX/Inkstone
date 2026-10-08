import type { UIMessage } from '../../../shared/ipc'

/**
 * 分屏里各条会话「刚才屏幕上显示的消息」。
 *
 * 焦点换块时，失焦的那块要立刻接着显示原内容，新焦点那块也要先铺上已显示的内容 ——
 * 不等运行缓存或读会话文件，否则中间会闪一下空白或上一条会话。
 * 只是显示用的副本，不是会话真源：pi 的权威同步到达后照常覆盖。
 */
const shown = new Map<string, UIMessage[]>()
const LIMIT = 16

const normPath = (p: string): string => p.replace(/[\\/]+/g, '/').toLowerCase()
const keysOf = (ref: { sessionId?: string | null; path?: string | null }): string[] =>
  [ref.sessionId ? `id:${ref.sessionId}` : '', ref.path ? `path:${normPath(ref.path)}` : ''].filter(Boolean)

export function rememberShown(ref: { sessionId?: string | null; path?: string | null }, messages: UIMessage[]): void {
  if (!messages.length) return
  for (const key of keysOf(ref)) {
    shown.delete(key)
    shown.set(key, messages)
  }
  while (shown.size > LIMIT * 2) shown.delete(shown.keys().next().value as string)
}

/** 各条会话在屏幕上的滚动位置：换块后新挂载的那一块从这里接着显示，不跳回顶部或底部 */
export interface ShownScroll { top: number; atBottom: boolean }
const scrolls = new Map<string, ShownScroll>()

export function rememberScroll(ref: { sessionId?: string | null; path?: string | null }, scroll: ShownScroll): void {
  for (const key of keysOf(ref)) {
    scrolls.delete(key)
    scrolls.set(key, scroll)
  }
  while (scrolls.size > LIMIT * 2) scrolls.delete(scrolls.keys().next().value as string)
}

export function shownScroll(ref: { sessionId?: string | null; path?: string | null }): ShownScroll | undefined {
  for (const key of keysOf(ref)) {
    const hit = scrolls.get(key)
    if (hit) return hit
  }
  return undefined
}

/** 一份消息里最后一条带时间的消息时间；没有时间的算 0 */
export function latestTimestamp(messages: UIMessage[] | undefined): number {
  if (!messages) return 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = messages[i].timestamp
    if (typeof ts === 'number' && ts > 0) return ts
  }
  return 0
}

/**
 * 几份同一会话的消息里取最新的那份（比最后一条消息的时间）；一样新时取靠前的。
 * 不能比条数：运行缓存把工具结果单列成消息，条数多不代表新。
 */
export function newestMessages(...candidates: (UIMessage[] | undefined)[]): UIMessage[] | undefined {
  let best: UIMessage[] | undefined
  let bestTs = -1
  for (const list of candidates) {
    if (!list?.length) continue
    const ts = latestTimestamp(list)
    if (ts > bestTs) { best = list; bestTs = ts }
  }
  return best
}

export function shownMessages(ref: { sessionId?: string | null; path?: string | null }): UIMessage[] | undefined {
  for (const key of keysOf(ref)) {
    const hit = shown.get(key)
    if (hit?.length) return hit
  }
  return undefined
}
