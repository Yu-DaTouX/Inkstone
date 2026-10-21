import { open } from 'node:fs/promises'

const TAIL_BYTES = 512 * 1024

export interface SessionTailState {
  lastRole?: string
  stopReason?: string
  lastAt?: number
}

function timestampOf(entry: { timestamp?: unknown; message?: { timestamp?: unknown } }): number | undefined {
  const raw = entry.message?.timestamp ?? entry.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function sessionTailState(text: string): SessionTailState {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line || !line.startsWith('{')) continue
    let entry: { type?: unknown; timestamp?: unknown; message?: { role?: unknown; stopReason?: unknown; timestamp?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || entry.type !== 'message') continue
    const role = entry.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const at = timestampOf(entry)
    return {
      lastRole: role,
      ...(role === 'assistant' && typeof entry.message?.stopReason === 'string' ? { stopReason: entry.message.stopReason } : {}),
      ...(at !== undefined ? { lastAt: at } : {})
    }
  }
  return {}
}

export async function readSessionTail(file: string): Promise<SessionTailState> {
  let handle
  try {
    handle = await open(file, 'r')
    const stat = await handle.stat()
    const size = stat.size
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.allocUnsafe(size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start > 0) {
      const firstBreak = text.indexOf('\n')
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1)
    }
    return sessionTailState(text)
  } catch {
    return {}
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export function tailTurnInterrupted(tail: SessionTailState, lastSettledAt?: number): boolean {
  if (tail.lastRole === 'user') return true
  if (tail.lastRole !== 'assistant' || tail.stopReason !== 'aborted') return false
  if (lastSettledAt === undefined) return true
  return (tail.lastAt ?? 0) > lastSettledAt
}
