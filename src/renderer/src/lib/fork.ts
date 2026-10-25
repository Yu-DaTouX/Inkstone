import { useStore } from '../state/store'

export async function forkAt(entryId: string): Promise<boolean> {
  return useStore.getState().fork(entryId)
}
