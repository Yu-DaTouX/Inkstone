import type { Store } from '../store'
import type { SliceContext } from './shared'

export type CheckpointsSlice = Pick<Store, 'checkpoints' | 'rewind' | 'refreshCheckpoints' | 'openRewind' | 'closeRewind'>

export function createCheckpointsSlice({ set, get }: SliceContext): CheckpointsSlice {
  return {
  checkpoints: [],
  rewind: null,
  refreshCheckpoints: async () => {
    try {
      const list = await window.yan.checkpoints.list()
      const prev = get().checkpoints
      if (prev.length === list.length && prev.every((r, i) => r.id === list[i].id)) return
      set({ checkpoints: list })
    } catch {
    }
  },
  openRewind: (recordId, preview) => set({ rewind: { recordId, preview } }),
  closeRewind: () => set({ rewind: null }),
  }
}
