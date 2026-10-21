import { compileContentMatcher, matchContentLines } from './file-content-match'
import type { ContentLineMatch, ContentSearchOptions } from './file-content-match'

interface MatchMessage {
  type: 'match'
  id: string
  query: string
  options: ContentSearchOptions
  texts: string[]
  limit: number
}

interface CancelMessage {
  type: 'cancel'
  id: string
}

const cancelled = new Set<string>()

function handleMatch(message: MatchMessage): Record<string, unknown> {
  if (cancelled.delete(message.id)) return { id: message.id, cancelled: true }
  const matcher = compileContentMatcher(message.query, message.options)
  if (!matcher) return { id: message.id, error: 'pattern' }
  const outcome = matchContentLines(matcher, message.texts, message.limit, () => cancelled.has(message.id))
  cancelled.delete(message.id)
  const matches: ContentLineMatch[] = outcome.matches
  return {
    id: message.id,
    matches,
    longLines: outcome.longLines,
    limitReached: outcome.limitReached,
    ...(outcome.cancelled ? { cancelled: true } : {})
  }
}

const port = process.parentPort
port.on('message', (event: { data: unknown }) => {
  const message = event.data as MatchMessage | CancelMessage | null
  if (!message || typeof message !== 'object' || typeof message.id !== 'string') return
  if (message.type === 'cancel') {
    cancelled.add(message.id)
    if (cancelled.size > 256) cancelled.clear()
    return
  }
  if (message.type === 'match') {
    port.postMessage(handleMatch(message))
  }
})
