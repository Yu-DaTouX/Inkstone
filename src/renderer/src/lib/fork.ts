import { useStore } from '../state/store'

export async function forkLatest(): Promise<void> {
  const points = await window.yan.forkPoints()
  const last = points[points.length - 1]
  if (!last) return
  await useStore.getState().fork(last.entryId)
}

export async function forkAt(entryId: string): Promise<boolean> {
  return useStore.getState().fork(entryId)
}

export async function forkFromText(text: string): Promise<void> {
  const points = await window.yan.forkPoints()
  const hit = [...points].reverse().find((p) => p.text.trim() === text.trim())
  if (!hit) return
  await useStore.getState().fork(hit.entryId)
}
