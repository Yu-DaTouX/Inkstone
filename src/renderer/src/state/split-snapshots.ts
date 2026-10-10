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

/**
 * 各条会话在屏幕上的滚动位置：换块后新挂载的那一块从这里接着显示，不跳回顶部或底部。
 *
 * `anchor` 是阅读位置的真源：视口顶端落在哪一回合、进入它多少像素。焦点那块长会话用虚拟列表
 *（未测量的回合按估算高度），只读那块完整渲染，同一个 `top` 在两边对应的内容不同 ——
 * 只按像素恢复，换焦点后另一块会跳到别处。`top` 只在找不到锚点回合时兜底。
 */
export interface ScrollAnchor { turnId: string; offset: number }
export interface ShownScroll { top: number; atBottom: boolean; anchor?: ScrollAnchor }
const scrolls = new Map<string, ShownScroll>()

/** 视口顶端所在的回合与进入它的距离（取回合行外层，虚拟列表里是 `.stream-row`） */
export function scrollAnchorOf(container: HTMLElement | null | undefined): ScrollAnchor | undefined {
  if (!container) return undefined
  const box = container.getBoundingClientRect()
  if (box.height <= 0) return undefined
  const x = box.left + box.width / 2
  for (let dy = 4; dy < Math.min(box.height, 160); dy += 12) {
    const hit = document.elementFromPoint(x, box.top + dy)
    const turn = hit && container.contains(hit) ? hit.closest<HTMLElement>('[data-turn-id]') : null
    if (!turn?.dataset.turnId) continue
    const row = turn.closest<HTMLElement>('.stream-row') ?? turn
    return { turnId: turn.dataset.turnId, offset: Math.round(box.top - row.getBoundingClientRect().top) }
  }
  return undefined
}

/** 完整渲染的列表按锚点恢复；找不到锚点回合返回 false，调用方用像素兜底 */
export function restoreScrollAnchor(container: HTMLElement | null | undefined, anchor: ScrollAnchor | undefined): boolean {
  if (!container || !anchor) return false
  const turn = container.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(anchor.turnId)}"]`)
  if (!turn) return false
  const row = turn.closest<HTMLElement>('.stream-row') ?? turn
  container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top + anchor.offset
  return true
}

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
