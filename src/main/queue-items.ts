import type { QueueItem, QueueSnapshot, QueueState } from '../shared/ipc'

export function consumeQueuedItem(state: QueueState, text: string, images?: QueueItem['images']): QueueState | null {
  const want = (text ?? '').trim()
  if (!want && !images?.length) return null

  const take = (list: QueueItem[]): QueueItem[] | null => {
    const i = list.findIndex((item) => (item.text ?? '').trim() === want &&
      (images === undefined || sameQueueImages(item.images, images)))
    if (i < 0) return null
    return [...list.slice(0, i), ...list.slice(i + 1)]
  }

  const steering = take(state.steering)
  if (steering) return { steering, followUp: state.followUp }
  const followUp = take(state.followUp)
  if (followUp) return { steering: state.steering, followUp }
  return null
}

export function sameQueueImages(a: QueueItem['images'], b: QueueItem['images']): boolean {
  return (a?.length ?? 0) === (b?.length ?? 0) &&
    (a ?? []).every((image, index) => image.data === b?.[index].data && image.mimeType === b?.[index].mimeType)
}

export function reconcileQueueItems(raw: string[], previous: QueueItem[], create: (text: string) => QueueItem): QueueItem[] {
  const buckets = new Map<string, QueueItem[]>()
  const counts = new Map<string, number>()
  for (const text of raw) counts.set(text, (counts.get(text) ?? 0) + 1)
  for (const item of previous) {
    const bucket = buckets.get(item.text) ?? []
    bucket.push(item)
    buckets.set(item.text, bucket)
  }
  for (const [text, bucket] of buckets) {
    const excess = bucket.length - (counts.get(text) ?? 0)
    if (excess > 0) bucket.splice(0, excess)
  }
  return raw.map(text => buckets.get(text)?.shift() ?? create(text))
}

export function snapshotQueue(state: QueueState): QueueSnapshot {
  const snapshot: QueueSnapshot = {
    steering: state.steering.map(item => item.text),
    followUp: state.followUp.map(item => item.text)
  }
  if ([...state.steering, ...state.followUp].some(item => item.images?.length)) {
    const clone = (items: QueueItem[]) => items.map(item => ({ ...item, ...(item.images?.length ? { images: item.images.map(image => ({ ...image })) } : {}) }))
    snapshot.items = { steering: clone(state.steering), followUp: clone(state.followUp) }
  }
  return snapshot
}

export function reclaimedTexts(cleared: {
  steering?: string[]
  followUp?: string[]
}): string[] {
  return [...(cleared.steering ?? []), ...(cleared.followUp ?? [])].filter((t) => !!t && t.trim().length > 0)
}
