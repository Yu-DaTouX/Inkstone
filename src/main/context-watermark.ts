import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { watermarkFromEntryIds, type RawEntryId, type SourceWatermark } from '../shared/context-state'

const HEAD_CHARS = 512

export interface SessionEntryIndex {
  sessionId?: string
  entryIds: RawEntryId[]
  contextMessageEntryIds: RawEntryId[]
  contextMessageWatermark: SourceWatermark
  watermark: SourceWatermark
  incompleteTail: boolean
  unreadableEntries: number
}

interface LineIdentity {
  type: string
  id: string | null
}

const TYPE_RE = /"type"\s*:\s*"([A-Za-z_]+)"/
const ID_RE = /"id"\s*:\s*"([^"\\]{1,200})"/

function lineIdentity(line: string): LineIdentity | null {
  const text = line.trim()
  if (!text || text[0] !== '{' || !text.endsWith('}')) return null
  const head = text.slice(0, HEAD_CHARS)
  const type = TYPE_RE.exec(head)?.[1]
  if (!type) return null
  const id = ID_RE.exec(head)?.[1] ?? null
  return { type, id }
}

export async function readSessionEntryIndex(path: string): Promise<SessionEntryIndex | null> {
  const entryIds: RawEntryId[] = []
  const contextMessageEntryIds: RawEntryId[] = []
  let sessionId: string | undefined
  let unreadableEntries = 0
  let incompleteTail = false
  let sawPartial = false
  let sawAnyLine = false

  let stream: ReturnType<typeof createReadStream>
  try {
    stream = createReadStream(path, { encoding: 'utf8' })
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve())
      stream.once('error', reject)
    })
  } catch {
    return null
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      sawAnyLine = true
      const identity = lineIdentity(line)
      if (!identity) {
        if (line.trim().endsWith('}')) {
          unreadableEntries++
        } else {
          incompleteTail = true
          sawPartial = true
        }
        continue
      }
      if (sawPartial) return null
      if (identity.type === 'session') {
        if (!sessionId && identity.id) sessionId = identity.id
        continue
      }
      if (!identity.id) {
        unreadableEntries++
        continue
      }
      entryIds.push(identity.id)
      if (identity.type === 'message') contextMessageEntryIds.push(identity.id)
    }
  } catch {
    return null
  } finally {
    rl.close()
    stream.destroy()
  }

  if (!sawAnyLine) return null

  return {
    ...(sessionId ? { sessionId } : {}),
    entryIds,
    contextMessageEntryIds,
    watermark: watermarkFromEntryIds(entryIds),
    contextMessageWatermark: watermarkFromEntryIds(contextMessageEntryIds),
    incompleteTail,
    unreadableEntries
  }
}
