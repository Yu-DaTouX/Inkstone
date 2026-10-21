import { useStore } from '../state/store'

export async function forkAt(entryId: string): Promise<boolean> {
  return useStore.getState().fork(entryId)
}

export async function forkFromText(text: string): Promise<void> {
  const points = await window.yan.forkPoints()
  const hit = [...points].reverse().find((p) => p.text.trim() === text.trim())
  if (!hit) return
  await useStore.getState().fork(hit.entryId)
}
