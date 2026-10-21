import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { YAN_DIR } from './paths'

export const QUEUE_RECOVERY_DIR = join(YAN_DIR, 'queue-recovery')

const MAX_ITEMS = 200
const MAX_TEXT_LENGTH = 20_000

export interface PersistedQueue {
  version: 1
  sessionId: string
  at: number
  steering: string[]
  followUp: string[]
  images: number
}

export interface QueueToPersist {
  sessionId: string
  steering: string[]
  followUp: string[]
  images?: number
}

const chains = new Map<string, Promise<unknown>>()

function queueFile(sessionId: string): string {
  return join(QUEUE_RECOVERY_DIR, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

function queueTexts(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.slice(0, MAX_TEXT_LENGTH))
    .filter((value) => value.trim().length > 0)
    .slice(0, MAX_ITEMS)
}

function imageCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve()
  const next = previous.then(task, task)
  chains.set(sessionId, next.catch(() => undefined))
  return next
}

export function saveQueue(input: QueueToPersist): Promise<void> {
  const sessionId = input.sessionId
  if (!sessionId) return Promise.resolve()
  const record: PersistedQueue = {
    version: 1,
    sessionId,
    at: Date.now(),
    steering: queueTexts(input.steering),
    followUp: queueTexts(input.followUp),
    images: imageCount(input.images)
  }
  return serialize(sessionId, async () => {
    await mkdir(QUEUE_RECOVERY_DIR, { recursive: true })
    const target = queueFile(sessionId)
    const temp = `${target}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(record)}\n`, 'utf8')
    await rename(temp, target)
  })
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
    const source = parsed as Partial<PersistedQueue> | null
    if (!source || typeof source !== 'object' || source.version !== 1 || source.sessionId !== sessionId) {
      await rm(target, { force: true })
      return null
    }
    const steering = queueTexts(source.steering)
    const followUp = queueTexts(source.followUp)
    const images = imageCount(source.images)
    if (!steering.length && !followUp.length && !images) return null
    return {
      version: 1,
      sessionId,
      at: typeof source.at === 'number' && Number.isFinite(source.at) ? source.at : 0,
      steering,
      followUp,
      images
    }
  })
}

export function clearQueueFile(sessionId: string): Promise<void> {
  if (!sessionId) return Promise.resolve()
  return serialize(sessionId, () => rm(queueFile(sessionId), { force: true }))
}
