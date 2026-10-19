import { collectCandidates } from './file-name-candidates'
import type { CandidateSet } from './file-name-candidates'
import { searchCandidates } from './file-name-search-core'

interface SearchMessage {
  type: 'search'
  id: string
  root: string
  query: string
  limit: number
}

interface CancelMessage {
  type: 'cancel'
  id: string
}

const CACHE_TTL_MS = 3000
const CACHE_ROOTS = 4
const cache = new Map<string, { at: number; set: CandidateSet }>()
const cancelled = new Set<string>()

async function candidatesFor(root: string): Promise<CandidateSet> {
  const hit = cache.get(root)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.set
  const set = await collectCandidates(root)
  cache.delete(root)
  cache.set(root, { at: Date.now(), set })
  while (cache.size > CACHE_ROOTS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return set
}

async function handleSearch(message: SearchMessage): Promise<Record<string, unknown>> {
  try {
    const set = await candidatesFor(message.root)
    if (cancelled.delete(message.id)) return { id: message.id, cancelled: true }
    const found = searchCandidates(set.candidates, message.query, message.limit)
    return {
      id: message.id,
      matches: found.matches,
      truncated: found.truncated || set.truncated,
      source: set.source,
      scanned: set.candidates.length
    }
  } catch (error) {
    return { id: message.id, error: error instanceof Error ? error.message : String(error) }
  }
}

const port = process.parentPort
port.on('message', (event: { data: unknown }) => {
  const message = event.data as SearchMessage | CancelMessage | null
  if (!message || typeof message !== 'object' || typeof message.id !== 'string') return
  if (message.type === 'cancel') {
    cancelled.add(message.id)
    if (cancelled.size > 256) cancelled.clear()
    return
  }
  if (message.type === 'search') {
    void handleSearch(message).then((reply) => {
      cancelled.delete(message.id)
      port.postMessage(reply)
    })
  }
})
