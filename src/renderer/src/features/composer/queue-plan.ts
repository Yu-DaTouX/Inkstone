/**
 * 队列编辑 / 重排的纯逻辑（WP-24b）。
 *
 * 只做「按 id 在当前队列里定位 → 算出目标顺序」，不碰 store、RPC 与 DOM，
 * 因此可在 Node 里直接单测（scripts/test-v3-queue-edit.mjs）。真正落到 pi 的
 * clear_queue + 重建在 store.applyQueueOrder → 主进程 queue-edit.ts。
 *
 * 上/下移只在**同一类**内进行：steering 与 followUp 是两种投递时机，
 * 跨类提升走「插队」（pi steer），不在这里伪造顺序。
 */
import type { QueueItem, QueueState } from '../../../../shared/ipc'

export type QueueKind = 'steering' | 'followUp'
export type QueueMove = 'up' | 'down'

export interface QueueLocation {
  kind: QueueKind
  index: number
  item: QueueItem
}

const KINDS: readonly QueueKind[] = ['steering', 'followUp']

/** 按稳定 id 定位；id 不在快照里说明这条已被 pi 接收 / 撤回。 */
export function locateQueueItem(state: QueueState, id: string): QueueLocation | undefined {
  for (const kind of KINDS) {
    const index = state[kind].findIndex((item) => item.id === id)
    if (index >= 0) return { kind, index, item: state[kind][index] }
  }
  return undefined
}

function replaceList(state: QueueState, kind: QueueKind, items: QueueItem[]): QueueState {
  return kind === 'steering'
    ? { steering: items, followUp: state.followUp }
    : { steering: state.steering, followUp: items }
}

/** 同一类里上/下移一格；到边界返回 null（界面据此禁用按钮，不做空操作）。 */
export function planQueueMove(state: QueueState, id: string, direction: QueueMove): QueueState | null {
  const found = locateQueueItem(state, id)
  if (!found) return null
  const target = found.index + (direction === 'up' ? -1 : 1)
  const list = state[found.kind]
  if (target < 0 || target >= list.length) return null
  const items = [...list]
  const [moved] = items.splice(found.index, 1)
  items.splice(target, 0, moved)
  return replaceList(state, found.kind, items)
}

/** 改文本；空文本或与原文相同返回 null。 */
export function planQueueEdit(state: QueueState, id: string, text: string): QueueState | null {
  const found = locateQueueItem(state, id)
  if (!found) return null
  const next = text.trim()
  if (!next || next === found.item.text) return null
  const items = [...state[found.kind]]
  items[found.index] = { ...found.item, text: next }
  return replaceList(state, found.kind, items)
}

/** 删除一条（不回填草稿）；id 已被接收时返回 null。 */
export function planQueueRemove(state: QueueState, id: string): QueueState | null {
  const found = locateQueueItem(state, id)
  if (!found) return null
  const items = state[found.kind].filter((item) => item.id !== id)
  return replaceList(state, found.kind, items)
}

/** 重建失败无法恢复时回填输入框的文本；顺序与停止回收一致（steering 在前）。 */
export function droppedQueueText(state: QueueState): string {
  return [...state.steering, ...state.followUp]
    .map((item) => item.text)
    .filter((text) => !!text)
    .join('\n')
}
