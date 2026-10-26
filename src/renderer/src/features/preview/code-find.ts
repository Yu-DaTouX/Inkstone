import type { CodeToken } from './code-lines'

export interface FindOptions {
  matchCase: boolean
  wholeWord: boolean
  regexp: boolean
}

export interface MatchRange {
  start: number
  end: number
}

export interface FindMatch extends MatchRange {
  line: number
}

export interface FindResult {
  matches: FindMatch[]
  invalid: boolean
  capped: boolean
}

export interface CodeSegment {
  text: string
  classes: readonly string[]
  start: number
  match: boolean
}

export interface FindKeyState {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
  composing?: boolean
}

export const FIND_MATCH_LIMIT = 2000

export const DEFAULT_FIND_OPTIONS: FindOptions = { matchCase: false, wholeWord: false, regexp: false }

let rememberedOptions: FindOptions = DEFAULT_FIND_OPTIONS

export function rememberedFindOptions(): FindOptions {
  return rememberedOptions
}

export function rememberFindOptions(options: FindOptions): FindOptions {
  rememberedOptions = { ...options }
  return rememberedOptions
}

const LITERAL = /[.*+?^${}()|[\]\\]/g
const WORD_CHAR = '[\\p{L}\\p{N}_$]'

export function compileFind(query: string, options: FindOptions): RegExp | null {
  if (!query) return null
  const source = options.regexp ? query : query.replace(LITERAL, '\\$&')
  const wrapped = options.wholeWord ? `(?<!${WORD_CHAR})(?:${source})(?!${WORD_CHAR})` : source
  try {
    return new RegExp(wrapped, `${options.matchCase ? '' : 'i'}g${options.wholeWord ? 'u' : ''}`)
  } catch {
    return null
  }
}

export function findMatches(
  texts: readonly string[],
  query: string,
  options: FindOptions = DEFAULT_FIND_OPTIONS,
  limit = FIND_MATCH_LIMIT
): FindResult {
  if (!query) return { matches: [], invalid: false, capped: false }
  const matcher = compileFind(query, options)
  if (!matcher) return { matches: [], invalid: true, capped: false }
  const matches: FindMatch[] = []
  for (let line = 0; line < texts.length; line += 1) {
    const text = texts[line]
    matcher.lastIndex = 0
    let found: RegExpExecArray | null
    while ((found = matcher.exec(text))) {
      if (found[0].length === 0) {
        if (matcher.lastIndex >= text.length) break
        matcher.lastIndex += 1
        continue
      }
      matches.push({ line, start: found.index, end: found.index + found[0].length })
      if (matches.length >= limit) return { matches, invalid: false, capped: true }
    }
  }
  return { matches, invalid: false, capped: false }
}

export function stepFindIndex(index: number, delta: number, total: number): number {
  if (!total) return -1
  if (index < 0) return delta > 0 ? 0 : total - 1
  return (((index + delta) % total) + total) % total
}

export function firstMatchFromLine(matches: readonly FindMatch[], line: number | null): number {
  if (!matches.length) return -1
  if (line === null || !Number.isInteger(line)) return 0
  const index = matches.findIndex((match) => match.line >= line)
  return index < 0 ? 0 : index
}

export function findStatus(index: number, total: number, capped: boolean): { current: number; total: number; capped: boolean } {
  return { current: index >= 0 ? index + 1 : 0, total, capped }
}

export function matchesByLine(matches: readonly FindMatch[]): Map<number, MatchRange[]> {
  const map = new Map<number, MatchRange[]>()
  for (const match of matches) {
    const ranges = map.get(match.line)
    if (ranges) ranges.push(match)
    else map.set(match.line, [match])
  }
  return map
}

export function splitLineMatches(line: readonly CodeToken[], ranges: readonly MatchRange[]): CodeSegment[] {
  const segments: CodeSegment[] = []
  let cursor = 0
  for (const token of line) {
    const tokenStart = cursor
    const tokenEnd = tokenStart + token.text.length
    if (!ranges.length) {
      segments.push({ text: token.text, classes: token.classes, start: tokenStart, match: false })
      cursor = tokenEnd
      continue
    }
    const bounds = new Set<number>([tokenStart, tokenEnd])
    for (const range of ranges) {
      if (range.end <= tokenStart || range.start >= tokenEnd) continue
      bounds.add(Math.max(range.start, tokenStart))
      bounds.add(Math.min(range.end, tokenEnd))
    }
    const points = [...bounds].sort((a, b) => a - b)
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i]
      const to = points[i + 1]
      if (to <= from) continue
      segments.push({
        text: token.text.slice(from - tokenStart, to - tokenStart),
        classes: token.classes,
        start: from,
        match: ranges.some((range) => range.start <= from && range.end >= to)
      })
    }
    cursor = tokenEnd
  }
  return segments
}

export function findShortcut(state: FindKeyState, mac: boolean): 'open' | null {
  if (state.composing) return null
  const mod = mac ? state.meta && !state.ctrl : state.ctrl && !state.meta
  if (!mod || state.alt || state.shift) return null
  return state.key.toLowerCase() === 'f' ? 'open' : null
}

export function findStepKey(key: string, shift: boolean): -1 | 1 | null {
  if (key === 'Enter') return shift ? -1 : 1
  if (key === 'F3') return shift ? -1 : 1
  return null
}

export interface FindWorkerLike {
  postMessage(data: unknown): void
  terminate(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface WorkerSession<Req, Res> {
  run(request: Req): Promise<Res>
  dispose(): void
}

export const FIND_WORKER_TIMEOUT_MS = 1500

export function createWorkerSession<Req, Res>(
  buildResult: (invalid: boolean) => Res,
  timeoutMs: number,
  makeWorker: () => FindWorkerLike
): WorkerSession<Req, Res> {
  let worker: FindWorkerLike | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let settle: ((result: Res) => void) | null = null

  const finish = (result: Res): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (worker) {
      worker.terminate()
      worker = null
    }
    const done = settle
    settle = null
    done?.(result)
  }

  return {
    run(request) {
      finish(buildResult(false))
      return new Promise<Res>((resolve) => {
        settle = resolve
        try {
          const current = makeWorker()
          worker = current
          timer = setTimeout(() => finish(buildResult(true)), timeoutMs)
          current.onmessage = (event) => finish(event.data as Res)
          current.onerror = () => finish(buildResult(true))
          current.postMessage(request)
        } catch {
          finish(buildResult(true))
        }
      })
    },
    dispose(): void {
      finish(buildResult(false))
    }
  }
}

export interface LineFindRequest {
  kind: 'lines'
  texts: readonly string[]
  query: string
  options: FindOptions
  limit: number
}

export interface FindSession {
  find(texts: readonly string[], query: string, options: FindOptions, limit?: number): Promise<FindResult>
  dispose(): void
}

function emptyFindResult(invalid: boolean): FindResult {
  return { matches: [], invalid, capped: false }
}

function defaultFindWorker(): FindWorkerLike {
  return new Worker(new URL('./find-worker.ts', import.meta.url), { type: 'module' }) as unknown as FindWorkerLike
}

export function createFindSession(
  timeoutMs = FIND_WORKER_TIMEOUT_MS,
  makeWorker: () => FindWorkerLike = defaultFindWorker
): FindSession {
  const session = createWorkerSession<LineFindRequest, FindResult>(emptyFindResult, timeoutMs, makeWorker)
  return {
    find(texts, query, options, limit = FIND_MATCH_LIMIT) {
      if (!query) return Promise.resolve(emptyFindResult(false))
      if (!options.regexp) return Promise.resolve(findMatches(texts, query, options, limit))
      return session.run({ kind: 'lines', texts, query, options, limit })
    },
    dispose: session.dispose
  }
}
