/**
 * 子 Agent 侧边详情的开合状态：打开的是哪一条运行、属于哪个会话视图。
 *
 * 归属键是 `SessionView` 的 `view.key`：切到别的会话时面板不跟过去（视图会把
 * 不属于自己的请求当作关闭），也就不会把 A 的子 Agent 详情挂在 B 上。
 * 关闭时把焦点还给打开它的那一行。
 */
import { create } from 'zustand'

interface SubagentPanelState {
  runId: string | null
  owner: string | null
  /** 打开面板的触发元素；关闭后焦点回到这里 */
  returnFocus: HTMLElement | null
  open(runId: string, owner: string, from?: HTMLElement | null): void
  toggle(runId: string, owner: string, from?: HTMLElement | null): void
  close(): void
}

export const useSubagentPanel = create<SubagentPanelState>((set, get) => ({
  runId: null,
  owner: null,
  returnFocus: null,
  open: (runId, owner, from) => set({ runId, owner, returnFocus: from ?? null }),
  toggle: (runId, owner, from) => {
    const state = get()
    if (state.runId === runId && state.owner === owner) state.close()
    else set({ runId, owner, returnFocus: from ?? null })
  },
  close: () => {
    const target = get().returnFocus
    set({ runId: null, owner: null, returnFocus: null })
    if (target?.isConnected) requestAnimationFrame(() => target.focus())
  }
}))
