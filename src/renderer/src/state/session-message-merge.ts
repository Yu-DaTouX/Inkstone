import type { UIMessage } from '../../../shared/ipc'
import { keepLocalImages } from './keep-images'
import { latestTimestamp } from './split-snapshots'

export function messageContentWeight(message: UIMessage): number {
  let weight = message.text?.length ?? 0
  if (message.thinking) weight += message.thinking.length
  for (const call of message.toolCalls ?? []) {
    weight += call.output?.length ?? 0
    if (call.argsRaw) weight += call.argsRaw.length
    if (call.images?.length) weight += call.images.length
  }
  if (message.images?.length) weight += message.images.length
  return weight
}

export function newerMessageVersion(snapshot: UIMessage, live: UIMessage): UIMessage {
  const chosen = messageContentWeight(snapshot) > messageContentWeight(live) ? snapshot : live
  return chosen.entryId || !snapshot.entryId ? chosen : { ...chosen, entryId: snapshot.entryId }
}

export function mergePeekedHistory(fromFile: UIMessage[], live: UIMessage[]): UIMessage[] {
  if (!live.length) return fromFile
  if (!fromFile.length) return live
  if (latestTimestamp(fromFile) > latestTimestamp(live)) return fromFile
  const remaining = new Map(live.map((message) => [message.id, message]))
  const merged: UIMessage[] = []
  for (const fileMessage of fromFile) {
    const liveMessage = remaining.get(fileMessage.id)
    if (!liveMessage) {
      merged.push(fileMessage)
      continue
    }
    merged.push(newerMessageVersion(fileMessage, liveMessage))
    remaining.delete(fileMessage.id)
  }
  for (const liveMessage of live) {
    if (!remaining.has(liveMessage.id)) continue
    remaining.delete(liveMessage.id)
    merged.push(liveMessage)
  }
  return merged
}

function mergeById(snapshot: UIMessage[], live: UIMessage[]): UIMessage[] {
  if (!snapshot.length || !live.length) return snapshot
  const byId = new Map(live.map((message) => [message.id, message]))
  let changed = false
  const merged = snapshot.map((message) => {
    const liveMessage = byId.get(message.id)
    if (!liveMessage) return message
    const version = newerMessageVersion(message, liveMessage)
    if (version !== message) changed = true
    return version
  })
  return changed ? merged : snapshot
}

export function mergeSyncHistory(
  snapshot: UIMessage[],
  live: UIMessage[],
  protectedTailId?: string
): UIMessage[] {
  if (!snapshot.length) return []
  if (!live.length) return snapshot
  const withImages = keepLocalImages(live, snapshot)
  if (!protectedTailId) return withImages
  const merged = mergeById(withImages, live)
  const tailIndex = live.findIndex((message) => message.id === protectedTailId)
  if (tailIndex < 0) return merged
  const snapshotIds = new Set(withImages.map((message) => message.id))
  const mergedIds = new Set(merged.map((message) => message.id))
  let out = merged
  for (const message of live.slice(tailIndex)) {
    if (snapshotIds.has(message.id) || mergedIds.has(message.id)) continue
    if (out === merged) out = merged.slice()
    mergedIds.add(message.id)
    out.push(message)
  }
  return out
}
