/**
 * 一个窗口并排看多条会话（分屏，最多 5 块磁贴，参考 Claude Code 的多会话布局）。
 *
 * 磁贴按从左到右的顺序各绑一条会话。焦点 = 当前活动会话，只有焦点那一块
 * 渲染完整对话与输入框；其余从会话运行缓存（没有就读会话文件）投影，输入框收起。
 *
 * 这里只记「第几块放哪条会话」，不持有会话内容，也不决定活动会话 ——
 * 活动会话仍由主 store 的切换流程决定，这里按它推导焦点（`reconcileSplit`）：
 *   · 活动会话就是某一块绑的会话 → 焦点移到那一块（点了非焦点的磁贴）；
 *   · 活动会话不在任何一块（从左栏点了别的会话）→ 替换焦点那一块，其余不动。
 */
import { create } from 'zustand'

/** 同屏最多几块会话磁贴 */
export const MAX_SPLIT_TILES = 5

export interface SplitSessionRef {
  /** 会话 id；还没落盘的新会话可能暂时没有 */
  sessionId?: string
  /** 会话文件；切换与读历史都用它 */
  path?: string
}

export interface SplitLayout {
  /** 从左到右，至少 2 块 */
  tiles: SplitSessionRef[]
  /** 焦点（活动会话）所在磁贴的下标 */
  live: number
}

/** 分屏时工作区布局用这个键：焦点在会话之间切换时，磁贴排布保持不变 */
export const SPLIT_WORKSPACE_KEY = 'split'

const normPath = (p?: string): string => (p ?? '').replace(/[\\/]+/g, '/').toLowerCase()

export function sameSplitSession(a: SplitSessionRef | null | undefined, b: SplitSessionRef | null | undefined): boolean {
  if (!a || !b) return false
  if (a.sessionId && b.sessionId) return a.sessionId === b.sessionId
  return !!a.path && !!b.path && normPath(a.path) === normPath(b.path)
}

const indexOfSession = (tiles: SplitSessionRef[], target: SplitSessionRef): number => tiles.findIndex((t) => sameSplitSession(t, target))

/** 屏幕上正在显示的会话：切换途中先铺上的那条（peek）优先于运行实例当前的会话 */
export function displayedSessionOf(view: {
  peekedSessionId: string | null
  peekedPath: string | null
  session: { sessionId?: string; sessionFile?: string } | null
}): SplitSessionRef | null {
  if (view.peekedSessionId || view.peekedPath) return { sessionId: view.peekedSessionId ?? undefined, path: view.peekedPath ?? undefined }
  if (view.session?.sessionId || view.session?.sessionFile) return { sessionId: view.session.sessionId || undefined, path: view.session.sessionFile || undefined }
  return null
}

/* 新会话落盘后才有路径：同一条会话补上后来知道的字段，别的一概不动 */
const merge = (a: SplitSessionRef, b: SplitSessionRef): SplitSessionRef => ({ sessionId: b.sessionId ?? a.sessionId, path: b.path ?? a.path })
const sameFields = (a: SplitSessionRef, b: SplitSessionRef): boolean => (a.sessionId === (b.sessionId ?? a.sessionId)) && (a.path === (b.path ?? a.path))

/**
 * 按当前活动会话推导分屏。返回原对象表示无变化。
 * 纯函数：渲染时直接用它决定哪一块是焦点，变化再写回 store。
 */
export function reconcileSplit(split: SplitLayout, displayed: SplitSessionRef | null): SplitLayout {
  if (!displayed || (!displayed.sessionId && !displayed.path)) return split
  const at = indexOfSession(split.tiles, displayed)
  if (at >= 0) {
    if (split.live === at && sameFields(split.tiles[at], displayed)) return split
    const tiles = split.tiles.slice()
    tiles[at] = merge(tiles[at], displayed)
    return { tiles, live: at }
  }
  const tiles = split.tiles.slice()
  tiles[split.live] = { ...displayed }
  return { tiles, live: split.live }
}

/** 关掉焦点那一块时，焦点先去哪一块：优先右邻，没有就取左邻 */
export function neighborOf(split: SplitLayout, index: number): number {
  return index + 1 < split.tiles.length ? index + 1 : index - 1
}

/**
 * 把一条会话放进分屏。纯函数，`open` 与测试共用。
 *   · `at`：插入到第几块的位置（0..块数）；不给 = 追加到最右；
 *   · 目标会话已在某一块 → 挪到 `at`（不重复开），焦点跟着会话走；
 *   · 已满 5 块 → 先挤掉离落点最近的、没有焦点的一块；
 *   · 与当前会话相同 → 不动。
 */
export function placeInSplit(split: SplitLayout | null, target: SplitSessionRef, current: SplitSessionRef | null, at?: number): SplitLayout | null {
  if (!current) return split
  if (!split) {
    if (sameSplitSession(target, current)) return null
    return at === 0
      ? { tiles: [{ ...target }, { ...current }], live: 1 }
      : { tiles: [{ ...current }, { ...target }], live: 0 }
  }
  const liveRef = split.tiles[split.live]
  const existing = indexOfSession(split.tiles, target)
  let tiles = split.tiles.slice()
  let slot = Math.max(0, Math.min(at ?? tiles.length, tiles.length))
  if (existing >= 0) {
    tiles.splice(existing, 1)
    if (existing < slot) slot -= 1
  } else if (tiles.length >= MAX_SPLIT_TILES) {
    /* 离落点最近的非焦点块 */
    let drop = -1
    for (let i = 0; i < tiles.length; i++) {
      if (i === split.live) continue
      if (drop < 0 || Math.abs(i + 0.5 - slot) < Math.abs(drop + 0.5 - slot)) drop = i
    }
    if (drop < 0) return split
    tiles.splice(drop, 1)
    if (drop < slot) slot -= 1
  }
  tiles.splice(slot, 0, { ...target })
  const live = indexOfSession(tiles, liveRef)
  return { tiles, live: live >= 0 ? live : 0 }
}

/** 去掉一块；只剩一块就退出分屏（返回 null）。去掉的是焦点块时，调用方应先把焦点切走 */
export function removeSplitTile(split: SplitLayout, index: number): SplitLayout | null {
  if (index < 0 || index >= split.tiles.length) return split
  const tiles = split.tiles.filter((_, i) => i !== index)
  if (tiles.length < 2) return null
  const live = index < split.live ? split.live - 1 : Math.min(split.live, tiles.length - 1)
  return { tiles, live }
}

interface SplitViewState {
  split: SplitLayout | null
  /**
   * 在旁边打开一条会话。`at` 是插入位置（拖拽落点），不给就追加到最右；规则见 `placeInSplit`。
   */
  open(target: SplitSessionRef, current: SplitSessionRef | null, at?: number): void
  /** 按活动会话校正（见 reconcileSplit） */
  sync(displayed: SplitSessionRef | null): void
  /** 去掉第 index 块 */
  remove(index: number): void
  /** 回到单会话 */
  close(): void
}

export const useSplitView = create<SplitViewState>((set, get) => ({
  split: null,
  open: (target, current, at) => {
    const next = placeInSplit(get().split, target, current, at)
    if (next !== get().split) set({ split: next })
  },
  sync: (displayed) => {
    const split = get().split
    if (!split) return
    const next = reconcileSplit(split, displayed)
    if (next !== split) set({ split: next })
  },
  remove: (index) => {
    const split = get().split
    if (!split) return
    set({ split: removeSplitTile(split, index) })
  },
  close: () => set({ split: null })
}))
