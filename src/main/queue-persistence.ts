import { readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'
import { atomicWriteFile } from './sync/atomic'

export const QUEUE_RECOVERY_DIR = join(YAN_DIR, 'queue-recovery')

const MAX_ITEMS = 200

export interface PersistedQueueImage {
  data: string
  mimeType: string
}

export interface PersistedQueueItem {
  text: string
  images?: PersistedQueueImage[]
}

export interface PersistedQueue {
  version: 2
  sessionId: string
  at: number
  steering: string[]
  followUp: string[]
  items: { steering: PersistedQueueItem[]; followUp: PersistedQueueItem[] }
  lostImages?: number
}

export interface QueueToPersist {
  sessionId: string
  steering?: string[]
  followUp?: string[]
  items?: { steering: PersistedQueueItem[]; followUp: PersistedQueueItem[] }
}

const chains = new Map<string, Promise<unknown>>()
const pendingSaves = new Map<string, { record: PersistedQueue; done: Promise<void> }>()

function queueFile(sessionId: string): string {
  return join(QUEUE_RECOVERY_DIR, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

function cleanImages(value: unknown): PersistedQueueImage[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((image): image is PersistedQueueImage => !!image && typeof image.data === 'string' && !!image.data && typeof image.mimeType === 'string' && !!image.mimeType)
    .map((image) => ({ data: image.data, mimeType: image.mimeType }))
}

function cleanItems(value: unknown): PersistedQueueItem[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item): PersistedQueueItem | null => {
      if (typeof item === 'string') return item.trim() ? { text: item } : null
      if (!item || typeof item !== 'object') return null
      const text = typeof (item as PersistedQueueItem).text === 'string' ? (item as PersistedQueueItem).text : ''
      const images = cleanImages((item as PersistedQueueItem).images)
      if (!text.trim() && images.length === 0) return null
      return images.length ? { text, images } : { text }
    })
    .filter((item): item is PersistedQueueItem => item !== null)
    .slice(0, MAX_ITEMS)
}

const textsOf = (items: PersistedQueueItem[]): string[] => items.map((item) => item.text).filter((text) => text.trim().length > 0)
const hasContent = (items: PersistedQueueItem[]): boolean => items.length > 0

function serialize<T>(sessionId: string, task: () => Promise<T>, coalescing = false): Promise<T> {
  if (!coalescing) pendingSaves.delete(sessionId)
  const previous = chains.get(sessionId) ?? Promise.resolve()
  const next = previous.then(task, task)
  const tail = next.then(() => undefined, () => undefined)
  chains.set(sessionId, tail)
  void tail.then(() => {
    if (chains.get(sessionId) === tail) chains.delete(sessionId)
  })
  return next
}

export function saveQueue(input: QueueToPersist): Promise<void> {
  const sessionId = input.sessionId
  if (!sessionId) return Promise.resolve()
  const steering = cleanItems(input.items?.steering ?? input.steering)
  const followUp = cleanItems(input.items?.followUp ?? input.followUp)
  const record: PersistedQueue = {
    version: 2,
    sessionId,
    at: Date.now(),
    steering: textsOf(steering),
    followUp: textsOf(followUp),
    items: { steering, followUp }
  }
  const waiting = pendingSaves.get(sessionId)
  if (waiting) {
    waiting.record = record
    return waiting.done
  }
  const entry: { record: PersistedQueue; done: Promise<void> } = { record, done: Promise.resolve() }
  pendingSaves.set(sessionId, entry)
  entry.done = serialize(sessionId, async () => {
    if (pendingSaves.get(sessionId) === entry) pendingSaves.delete(sessionId)
    await atomicWriteFile(queueFile(sessionId), `${JSON.stringify(entry.record)}\n`)
  }, true)
  return entry.done
}

export function loadQueue(sessionId: string): Promise<PersistedQueue | null> {
  if (!sessionId) return Promise.resolve(null)
  return serialize(sessionId, async () => {
    const target = queueFile(sessionId)
    let text: string
    try {
      text = await readFile(target, 'utf8')
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      await rm(target, { force: true })
      return null
    }
    const source = parsed as (Omit<Partial<PersistedQueue>, 'version'> & { version?: number; images?: unknown }) | null
    if (!source || typeof source !== 'object' || (source.version !== 1 && source.version !== 2) || source.sessionId !== sessionId) {
      await rm(target, { force: true })
      return null
    }
    const steering = cleanItems(source.version === 2 ? source.items?.steering : source.steering)
    const followUp = cleanItems(source.version === 2 ? source.items?.followUp : source.followUp)
    const lostImages = source.version === 1 && typeof source.images === 'number' && Number.isSafeInteger(source.images) && source.images > 0 ? source.images : 0
    if (!hasContent(steering) && !hasContent(followUp) && !lostImages) return null
    return {
      version: 2,
      sessionId,
      at: typeof source.at === 'number' && Number.isFinite(source.at) ? source.at : 0,
      steering: textsOf(steering),
      followUp: textsOf(followUp),
      items: { steering, followUp },
      ...(lostImages ? { lostImages } : {})
    }
  })
}

export function clearQueueFile(sessionId: string): Promise<void> {
  if (!sessionId) return Promise.resolve()
  return serialize(sessionId, () => rm(queueFile(sessionId), { force: true }))
}

export const RECLAIMED_QUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export async function pruneReclaimedQueues(now = Date.now()): Promise<number> {
  const names = await readdir(QUEUE_RECOVERY_DIR).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.json.reclaimed')) continue
    const path = join(QUEUE_RECOVERY_DIR, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile() || now - info.mtimeMs < RECLAIMED_QUEUE_MAX_AGE_MS) continue
    await rm(path, { force: true }).then(() => { removed++ }, () => undefined)
  }
  return removed
}

export function keepReclaimedQueue(sessionId: string): Promise<void> {
  if (!sessionId) return Promise.resolve()
  return serialize(sessionId, async () => {
    const target = queueFile(sessionId)
    await rename(target, `${target}.reclaimed`).catch(() => rm(target, { force: true }))
  })
}
