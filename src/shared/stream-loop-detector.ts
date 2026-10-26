export type LoopRule = 'reasoning-cycle' | 'reasoning-lines' | 'text-cycle' | 'text-lines'

export interface LoopHit {
  rule: LoopRule
  emittedChars: number
  repeatedChars: number
}

export interface StreamLoopDetector {
  onThinking(delta: string): LoopHit | null
  onText(delta: string): LoopHit | null
  reset(): void
}

const STREAM_LOOP_LIMITS = {
  thinkingMinRepeat: 512,
  textMinRepeat: 256,
  maxCycle: 512,
  checkInterval: 32,
  poolMinRepeat: 2048,
  poolMinCoverage: 0.6,
  poolMinConcentration: 4,
  poolMaxLineLength: 200,
  poolMaxLines: 4096
} as const

type StreamKind = 'thinking' | 'text'

interface StreamState {
  kind: StreamKind
  tail: string
  tailLimit: number
  minRepeat: number
  sinceCheck: number
  emitted: number
  pool: Map<string, number>
  poolChars: number
  poolRepeated: number
  poolOccurrences: number
  poolDisabled: boolean
  pending: string
  skipLine: boolean
  fence: { char: string; length: number; protocolTail: boolean } | null
}

const STRUCTURAL_CHARS = new Set([
  '{', '}', '[', ']', '<', '>', '|', '\\', ';', '`', '"', '\'', '(', ')', '=', '+', '*', '#', '/'
])

const WORDISH = /[\p{L}\p{N}]/u

function createStreamState(kind: StreamKind): StreamState {
  const maxCycle = STREAM_LOOP_LIMITS.maxCycle
  const minRepeat = kind === 'thinking' ? STREAM_LOOP_LIMITS.thinkingMinRepeat : STREAM_LOOP_LIMITS.textMinRepeat
  return {
    kind,
    tail: '',
    tailLimit: 2 * maxCycle + Math.max(minRepeat, maxCycle),
    minRepeat,
    sinceCheck: 0,
    emitted: 0,
    pool: new Map<string, number>(),
    poolChars: 0,
    poolRepeated: 0,
    poolOccurrences: 0,
    poolDisabled: false,
    pending: '',
    skipLine: false,
    fence: null
  }
}

function resetStreamState(state: StreamState): void {
  state.tail = ''
  state.sinceCheck = 0
  state.emitted = 0
  state.pool.clear()
  state.poolChars = 0
  state.poolRepeated = 0
  state.poolOccurrences = 0
  state.poolDisabled = false
  state.pending = ''
  state.skipLine = false
  state.fence = null
}

function looksLikeStructuredRecord(line: string): boolean {
  if (/^[ \t]/.test(line)) return true
  const trimmed = line.trim()
  if (trimmed.length < 2) return true
  if (trimmed.length > STREAM_LOOP_LIMITS.poolMaxLineLength) return true
  if (!WORDISH.test(trimmed)) return true
  for (const ch of trimmed) if (STRUCTURAL_CHARS.has(ch)) return true
  if (/^\d{1,2}:\d{2}(:\d{2})?/.test(trimmed)) return true
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return true
  if (/^(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\b/i.test(trimmed)) return true
  return false
}

function canonicalTemplate(period: string): string {
  const newline = period.indexOf('\n')
  if (newline === -1) return period
  const start = newline + 1
  if (start >= period.length) return period
  return period.slice(start) + period.slice(0, start)
}

function templateSuppressed(template: string): boolean {
  let sawContent = false
  let start = 0
  while (start <= template.length) {
    const newline = template.indexOf('\n', start)
    const end = newline === -1 ? template.length : newline
    const raw = template.slice(start, end)
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim().length > 0) {
      if (looksLikeStructuredRecord(line)) return true
      sawContent = true
    }
    if (end === template.length) break
    start = end + 1
  }
  return !sawContent
}

function templateQualifies(tail: string, n: number, p: number): boolean {
  const first = tail[n - p]
  let distinct = false
  let wordish = false
  for (let i = n - p; i < n; i++) {
    const ch = tail[i]
    if (!distinct && ch !== first) distinct = true
    if (!wordish && WORDISH.test(ch)) wordish = true
    if (distinct && wordish) return true
  }
  return false
}

function trailingCycleRepeats(tail: string, maxPeriod: number, minRepeat: number): number | null {
  const n = tail.length
  if (n < minRepeat + 1) return null
  const last = tail.charCodeAt(n - 1)
  let uniform = true
  for (let i = n - 2; i >= 0; i--) {
    if (tail.charCodeAt(i) !== last) {
      uniform = false
      break
    }
  }
  if (uniform) return null
  for (let p = 1; p <= maxPeriod; p++) {
    if (n < p + minRepeat) break
    if (tail.charCodeAt(n - 1) !== tail.charCodeAt(n - 1 - p)) continue
    const template = canonicalTemplate(tail.slice(n - p, n))
    if (templateSuppressed(template)) continue
    const needed = Math.max(minRepeat, 2 * p)
    let matched = 0
    for (let i = n - 1; i >= p && matched < needed; i--) {
      if (tail.charCodeAt(i) !== tail.charCodeAt(i - p)) break
      matched++
    }
    if (matched < needed) continue
    if (!templateQualifies(tail, n, p)) continue
    return matched
  }
  return null
}

function clearCandidates(state: StreamState): void {
  state.tail = ''
  state.pool.clear()
  state.poolChars = 0
  state.poolRepeated = 0
  state.poolOccurrences = 0
  state.poolDisabled = false
}

function fenceMarker(line: string): RegExpMatchArray | null {
  return line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
}

function openFence(state: StreamState, marker: RegExpMatchArray): void {
  const offset = state.tail.lastIndexOf(marker[1])
  const before = state.tail.slice(0, offset)
  const newline = state.tail.indexOf('\n', offset)
  const after = newline < 0 ? '' : state.tail.slice(newline + 1)
  const protocolTail = marker[2].trim() === '' && /<\/(?:function_calls|invoke|parameter)>\s*$/.test(before)
  state.fence = { char: marker[1][0], length: marker[1].length, protocolTail }
  clearCandidates(state)
  if (protocolTail) appendTail(state, after)
}

function processLine(state: StreamState, line: string): void {
  const marker = fenceMarker(line)
  if (state.fence) {
    if (marker && marker[1][0] === state.fence.char && marker[1].length >= state.fence.length && marker[2].trim() === '') {
      state.fence = null
      clearCandidates(state)
    }
    return
  }
  if (marker) {
    openFence(state, marker)
    return
  }
  countLine(state, line)
}

function countLine(state: StreamState, line: string): void {
  if (state.poolDisabled) return
  if (looksLikeStructuredRecord(line)) return
  const len = line.length
  const prev = state.pool.get(line)
  if (prev === undefined) {
    if (state.pool.size >= STREAM_LOOP_LIMITS.poolMaxLines) {
      state.poolDisabled = true
      return
    }
    state.pool.set(line, 1)
    state.poolChars += len
    state.poolOccurrences += 1
    return
  }
  state.poolRepeated += prev === 1 ? len * 2 : len
  state.pool.set(line, prev + 1)
  state.poolChars += len
  state.poolOccurrences += 1
}

function feedLines(state: StreamState, delta: string): void {
  let rest = state.pending + delta
  state.pending = ''
  let newline = rest.indexOf('\n')
  while (newline !== -1) {
    let line = rest.slice(0, newline)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (state.skipLine) state.skipLine = false
    else processLine(state, line)
    rest = rest.slice(newline + 1)
    newline = rest.indexOf('\n')
  }
  if (rest.length > STREAM_LOOP_LIMITS.poolMaxLineLength) {
    if (!state.fence) {
      const marker = fenceMarker(rest)
      if (marker) {
        openFence(state, marker)
      }
    }
    state.pending = ''
    state.skipLine = true
  } else {
    state.pending = rest
  }
}

function poolTriggers(state: StreamState): boolean {
  if (state.poolDisabled) return false
  if (state.poolRepeated < STREAM_LOOP_LIMITS.poolMinRepeat) return false
  if (state.poolChars === 0) return false
  if (state.poolRepeated / state.poolChars < STREAM_LOOP_LIMITS.poolMinCoverage) return false
  const concentration = state.poolOccurrences / Math.max(1, state.pool.size)
  return concentration >= STREAM_LOOP_LIMITS.poolMinConcentration
}

function appendTail(state: StreamState, segment: string): void {
  state.tail += segment
  if (state.tail.length > state.tailLimit) {
    state.tail = state.tail.slice(state.tail.length - state.tailLimit)
  }
}

function checkStream(state: StreamState): LoopHit | null {
  if ((state.fence && !state.fence.protocolTail) || fenceMarker(state.pending)) return null
  const protocol = state.tail.match(/((?:<\/(?:function_calls|invoke|parameter)>\s*){8,})(?:<\/?[a-z_]*(?:>)?)?$/)
  if (protocol && protocol[1].length >= state.minRepeat) {
    return {
      rule: state.kind === 'thinking' ? 'reasoning-cycle' : 'text-cycle',
      emittedChars: state.emitted,
      repeatedChars: protocol[1].length
    }
  }
  if (state.fence) return null
  const repeats = trailingCycleRepeats(state.tail, STREAM_LOOP_LIMITS.maxCycle, state.minRepeat)
  if (repeats !== null) {
    return {
      rule: state.kind === 'thinking' ? 'reasoning-cycle' : 'text-cycle',
      emittedChars: state.emitted,
      repeatedChars: repeats
    }
  }
  if (poolTriggers(state)) {
    return {
      rule: state.kind === 'thinking' ? 'reasoning-lines' : 'text-lines',
      emittedChars: state.emitted,
      repeatedChars: state.poolRepeated
    }
  }
  return null
}

function feed(state: StreamState, delta: string): LoopHit | null {
  if (delta.length === 0) return null
  let pos = 0
  while (pos < delta.length) {
    const take = Math.min(STREAM_LOOP_LIMITS.checkInterval - state.sinceCheck, delta.length - pos)
    const segment = pos === 0 && take === delta.length ? delta : delta.slice(pos, pos + take)
    state.emitted += take
    appendTail(state, segment)
    feedLines(state, segment)
    state.sinceCheck += take
    pos += take
    if (state.sinceCheck >= STREAM_LOOP_LIMITS.checkInterval) {
      state.sinceCheck = 0
      const result = checkStream(state)
      if (result) return result
    }
  }
  return null
}

export function createStreamLoopDetector(): StreamLoopDetector {
  const thinking = createStreamState('thinking')
  const text = createStreamState('text')
  let hit = false

  const dispatch = (state: StreamState, delta: string): LoopHit | null => {
    if (hit) return null
    const result = feed(state, delta ?? '')
    if (result) hit = true
    return result
  }

  return {
    onThinking(delta: string): LoopHit | null {
      return dispatch(thinking, delta)
    },
    onText(delta: string): LoopHit | null {
      return dispatch(text, delta)
    },
    reset(): void {
      hit = false
      resetStreamState(thinking)
      resetStreamState(text)
    }
  }
}
