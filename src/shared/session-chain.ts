export const SESSION_CHAIN_FILE_NAME = 'session-chains.json'

export interface SessionSegment {
  sessionFile: string
  startedAt: number
  handoffId: string | null
}

export interface SessionChain {
  chainId: string
  segments: SessionSegment[]
  updatedAt: number
}

export function normalizeChainKey(file: unknown): string | null {
  if (typeof file !== 'string') return null
  const trimmed = file.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!trimmed || trimmed.length > 400) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  return trimmed
}

export function createChain(segment: SessionSegment): SessionChain | null {
  const key = normalizeChainKey(segment?.sessionFile)
  if (!key) return null
  return {
    chainId: key,
    segments: [{ ...segment, sessionFile: key }],
    updatedAt: Number.isFinite(segment.startedAt) ? segment.startedAt : 0
  }
}

export function appendSegment(chain: SessionChain, segment: SessionSegment): SessionChain {
  const key = normalizeChainKey(segment?.sessionFile)
  if (!key) return chain
  if (chain.segments.some((item) => normalizeChainKey(item.sessionFile) === key)) return chain
  const next: SessionSegment = { ...segment, sessionFile: key }
  return {
    ...chain,
    segments: [...chain.segments, next],
    updatedAt: Number.isFinite(segment.startedAt) ? segment.startedAt : chain.updatedAt
  }
}

export function chainRepresentative(chain: SessionChain | null | undefined): SessionSegment | null {
  const segments = chain?.segments ?? []
  return segments.length ? segments[segments.length - 1] : null
}

export function chainForFile(chains: SessionChain[], sessionFile: string): SessionChain | null {
  const key = normalizeChainKey(sessionFile)
  if (!key) return null
  for (const chain of chains ?? []) {
    if (chain.segments.some((item) => normalizeChainKey(item.sessionFile) === key)) return chain
  }
  return null
}

export function isRepresentative(chains: SessionChain[], sessionFile: string): boolean {
  const key = normalizeChainKey(sessionFile)
  if (!key) return false
  const chain = chainForFile(chains, key)
  if (!chain) return true
  return normalizeChainKey(chainRepresentative(chain)?.sessionFile) === key
}

export function planHistoryRead(chain: SessionChain | null | undefined): string[] {
  return (chain?.segments ?? [])
    .map((item) => normalizeChainKey(item.sessionFile))
    .filter((key): key is string => !!key)
}

export function sanitizeSessionChain(raw: unknown): SessionChain | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<SessionChain>
  const segments: SessionSegment[] = []
  for (const seg of Array.isArray(item.segments) ? item.segments : []) {
    const key = normalizeChainKey((seg as Partial<SessionSegment>)?.sessionFile)
    if (!key) continue
    if (segments.some((existing) => existing.sessionFile === key)) continue
    const startedAt = Number.isFinite((seg as Partial<SessionSegment>)?.startedAt)
      ? Number((seg as Partial<SessionSegment>).startedAt)
      : 0
    const handoffId = typeof (seg as Partial<SessionSegment>)?.handoffId === 'string' ? (seg as SessionSegment).handoffId : null
    segments.push({ sessionFile: key, startedAt, handoffId })
  }
  if (!segments.length) return null
  const chainId = normalizeChainKey(item.chainId) ?? segments[0].sessionFile
  const safeId = segments.some((seg) => seg.sessionFile === chainId) ? chainId : segments[0].sessionFile
  return {
    chainId: safeId,
    segments,
    updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : 0
  }
}

export function sanitizeSessionChains(raw: unknown): SessionChain[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { chains?: unknown } | null)?.chains)
      ? (raw as { chains: unknown[] }).chains
      : []
  const out: SessionChain[] = []
  for (const item of list) {
    const chain = sanitizeSessionChain(item)
    if (!chain) continue
    if (out.some((existing) => existing.segments.some((seg) => chain.segments.some((mine) => mine.sessionFile === seg.sessionFile)))) {
      continue
    }
    out.push(chain)
  }
  return out
}

export function chainSummary(chain: SessionChain | null | undefined): string {
  const segments = chain?.segments ?? []
  if (segments.length <= 1) return '单段'
  return `${segments.length} 段（同一会话）`
}
