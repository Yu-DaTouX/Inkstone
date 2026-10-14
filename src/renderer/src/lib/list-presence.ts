/**
 * 列表增删呈现的**纯 diff 辅助**（设计规范 §6「列表增删」）。
 *
 * 只回答「哪些行新来、哪些行要走、走的那几行要保留多久的投影」，
 * 不碰 React、不碰任务数据源、不复制任何状态机。
 *
 * 身份必须由调用方给**稳定 id**：
 *   · 有 id 才能在排序 / 文字更新时仍认出「还是同一行」，从而不做动画；
 *   · 没有稳定 id 的列表（例如当前任务本体只有 `text/done/status`）不适用 ——
 *     拿文字当 id 会让每次改文字都变成删 + 增，违背「文字更新不动画」。
 *
 * 退场行是**只读投影**：`interactive=false`，调用方据此渲染 `inert` /
 * `aria-hidden`，让它不可点、不进 Tab 顺序；`settle(id)` 在退场动画结束后
 * 移除快照，`reset()` 在卸载 / 换作用域时清掉计时器要用的快照与基线。
 */

/** 退场需要保留多久：与 `.ui-grow` 收起时长 `--mo-slow`（240ms）同源 */
export const LIST_EXIT_MS = 240
export const LIST_STAGGER_MS = 60
export const LIST_MAX_STAGGER = 8

export type ListPhase = 'stable' | 'entering' | 'exiting'

export interface ListPresenceInput<T> {
  id: string
  item: T
}

export interface ListPresenceRow<T> {
  id: string
  item: T
  phase: ListPhase
  /** 入场错峰序号（0 起，已按上限压平） */
  stagger: number
  /** 退场行只是投影：不可点、不进 Tab 顺序 */
  interactive: boolean
}

export interface ListPresenceOptions {
  /** 动效是否开启；false 时退场不保留投影，立即移除（默认 true） */
  motion?: boolean
}

export interface ListPresence<T> {
  /**
   * 每渲染一次调用一次。首次调用（或 reset 后）建立基线：当前的行全是
   * `stable`，不播入场；之后只对新增 id 标 `entering`、消失 id 标 `exiting`。
   */
  reconcile(current: readonly ListPresenceInput<T>[], options?: ListPresenceOptions): ListPresenceRow<T>[]
  /** 退场动画结束：移除某条投影；返回是否真的移除了 */
  settle(id: string): boolean
  /** 换 scope / 卸载：清基线、清退场快照 */
  reset(): void
  /** 诊断 / 测试：当前保留的退场投影 id */
  exitingIds(): string[]
}

/** 第 n 个新行的错峰序号（0 起）；第 8 个及以后并入最后一档 */
export function listStaggerIndex(order: number): number {
  if (!Number.isFinite(order) || order <= 0) return 0
  return Math.min(Math.floor(order), LIST_MAX_STAGGER - 1)
}

export function createListPresence<T>(): ListPresence<T> {
  /** 上一次已见到的 id 顺序；null = 还没有基线 */
  let baseline: string[] | null = null
  /** 上一次的行内容（给退场快照用） */
  let items = new Map<string, T>()
  /** 正在退场的 id → 快照（内容 + 原来的位置） */
  const exiting = new Map<string, { item: T; index: number }>()
  let lastSignature = ''
  let lastRows: ListPresenceRow<T>[] | null = null

  const clearCache = (): void => {
    lastSignature = ''
    lastRows = null
  }

  return {
    reconcile(current, options) {
      const motion = options?.motion !== false
      const signature = `${motion ? 'm' : 'r'}|${current.map((x) => x.id).join('\u0000')}`
      if (lastRows && signature === lastSignature) {
        /* 同一输入重复调用（StrictMode 双渲染）：复用决定，但把内容换成最新引用 */
        const byId = new Map(current.map((x) => [x.id, x.item] as const))
        for (const [id, item] of byId) items.set(id, item)
        lastRows = lastRows.map((row) => (byId.has(row.id) ? { ...row, item: byId.get(row.id) as T } : row))
        return lastRows
      }

      const currentIds = current.map((x) => x.id)

      /* 首次观察：全部算已有，不播入场（历史 / 恢复不乱动） */
      if (baseline === null) {
        baseline = currentIds
        items = new Map(current.map((x) => [x.id, x.item] as const))
        exiting.clear()
        lastRows = current.map(({ id, item }) => ({ id, item, phase: 'stable', stagger: 0, interactive: true }))
        lastSignature = signature
        return lastRows
      }

      const previous = new Set(baseline)
      const currentSet = new Set(currentIds)
      const entering = currentIds.filter((id) => !previous.has(id))
      const removing = baseline.filter((id) => !currentSet.has(id))

      /* 退场：保留最后已知内容与位置；motion=false 时不保留任何投影 */
      if (!motion) exiting.clear()
      for (const id of removing) {
        if (!motion) continue
        if (exiting.has(id)) continue
        const snapshot = items.get(id)
        if (snapshot === undefined) continue
        exiting.set(id, { item: snapshot, index: baseline.indexOf(id) })
      }
      /* 又回来的行不再是退场投影 */
      for (const id of currentIds) exiting.delete(id)

      const enteringOrder = new Map<string, number>()
      entering.forEach((id, i) => enteringOrder.set(id, listStaggerIndex(i)))

      const rows: ListPresenceRow<T>[] = current.map(({ id, item }) => ({
        id,
        item,
        phase: enteringOrder.has(id) ? 'entering' : 'stable',
        stagger: enteringOrder.get(id) ?? 0,
        interactive: true
      }))

      /* 退场行按原位置插回，视觉上「原地反向收起」而不是跳走 */
      const exitRows = [...exiting.entries()]
        .sort((a, b) => a[1].index - b[1].index)
        .map(([id, snapshot]) => ({ id, item: snapshot.item, phase: 'exiting' as const, stagger: 0, interactive: false }))
      for (const exitRow of exitRows) {
        const at = Math.max(0, Math.min(exiting.get(exitRow.id)?.index ?? rows.length, rows.length))
        rows.splice(at, 0, exitRow)
      }

      baseline = currentIds
      items = new Map(current.map((x) => [x.id, x.item] as const))
      lastRows = rows
      lastSignature = signature
      return rows
    },

    settle(id) {
      const removed = exiting.delete(id)
      if (removed) clearCache()
      return removed
    },

    reset() {
      baseline = null
      items = new Map()
      exiting.clear()
      clearCache()
    },

    exitingIds() {
      return [...exiting.keys()]
    }
  }
}
