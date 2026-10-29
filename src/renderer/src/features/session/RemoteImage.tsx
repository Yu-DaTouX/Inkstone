import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import { ImageDown } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../state/store'
import { Button } from '../../ui'
import { MessageImage } from './Image'
import type { RemoteImageResult } from '../../../../shared/ipc'

type RemoteState = { phase: 'checking' } | { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; dataUrl: string } | { phase: 'failed'; code: string }

const loaded = new Map<string, string>()
const LOADED_LIMIT = 32

function rememberLoaded(src: string, dataUrl: string): void {
  loaded.delete(src)
  loaded.set(src, dataUrl)
  while (loaded.size > LOADED_LIMIT) {
    const oldest = loaded.keys().next().value
    if (oldest === undefined) break
    loaded.delete(oldest)
  }
}

function remoteImageHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function remoteImageState(result: RemoteImageResult, prompted: boolean): RemoteState {
  if (result.ok) return { phase: 'ready', dataUrl: result.dataUrl }
  if (result.code === 'needs-consent' && !prompted) return { phase: 'idle' }
  return { phase: 'failed', code: result.code }
}

export interface RemoteImageGroupSummary {
  blocked: number
  loading: number
  failed: number
  hosts: readonly string[]
}

interface RemoteImageMember {
  src: string
  state: RemoteState
  load: (prompt: boolean) => void
}

export interface RemoteImageGroup {
  report(key: object, member: RemoteImageMember | null): void
  subscribe(listener: () => void): () => void
  summary(): RemoteImageGroupSummary
  loadBlocked(): void
  retryFailed(): void
}

const EMPTY_SUMMARY: RemoteImageGroupSummary = { blocked: 0, loading: 0, failed: 0, hosts: [] }

function summarize(members: Iterable<RemoteImageMember>): RemoteImageGroupSummary {
  let blocked = 0
  let loading = 0
  let failed = 0
  const hosts = new Set<string>()
  for (const member of members) {
    const phase = member.state.phase
    if (phase === 'idle') blocked += 1
    else if (phase === 'loading') loading += 1
    else if (phase === 'failed') failed += 1
    else continue
    hosts.add(remoteImageHost(member.src))
  }
  return blocked || loading || failed ? { blocked, loading, failed, hosts: [...hosts] } : EMPTY_SUMMARY
}

function sameSummary(a: RemoteImageGroupSummary, b: RemoteImageGroupSummary): boolean {
  return a.blocked === b.blocked && a.loading === b.loading && a.failed === b.failed &&
    a.hosts.length === b.hosts.length && a.hosts.every((host, index) => host === b.hosts[index])
}

export function createRemoteImageGroup(): RemoteImageGroup {
  const members = new Map<object, RemoteImageMember>()
  const listeners = new Set<() => void>()
  let snapshot = EMPTY_SUMMARY
  const settle = (): void => {
    const next = summarize(members.values())
    if (sameSummary(next, snapshot)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  return {
    report(key, member) {
      if (member) members.set(key, member)
      else members.delete(key)
      settle()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    summary: () => snapshot,
    loadBlocked() {
      for (const member of [...members.values()]) if (member.state.phase === 'idle') member.load(true)
    },
    retryFailed() {
      for (const member of [...members.values()]) if (member.state.phase === 'failed') member.load(true)
    }
  }
}

const RemoteImageGroupContext = createContext<RemoteImageGroup | null>(null)

export function useRemoteImageGroup(): RemoteImageGroup {
  return useState(createRemoteImageGroup)[0]
}

export function RemoteImageGroupScope({ group, children }: { group: RemoteImageGroup; children: ReactNode }): JSX.Element {
  return <RemoteImageGroupContext.Provider value={group}>{children}</RemoteImageGroupContext.Provider>
}

export function useInRemoteImageGroup(): boolean {
  return useContext(RemoteImageGroupContext) !== null
}

export function useRemoteImageGroupSummary(group: RemoteImageGroup): RemoteImageGroupSummary {
  return useSyncExternalStore(group.subscribe, group.summary, group.summary)
}

export function RemoteImage({ src, alt, className }: { src: string; alt?: string; className?: string }): JSX.Element | null {
  const t = useT()
  const sessionId = useStore((s) => s.session?.sessionId ?? s.session?.conversationId ?? '')
  const group = useContext(RemoteImageGroupContext)
  const memberKey = useState(() => ({}))[0]
  const cached = loaded.get(src)
  const [state, setState] = useState<RemoteState>(cached ? { phase: 'ready', dataUrl: cached } : { phase: 'checking' })

  const load = async (prompt: boolean): Promise<void> => {
    const bridge = window.yan?.browser
    if (!bridge?.remoteImage) {
      setState({ phase: 'failed', code: 'denied' })
      return
    }
    if (prompt) setState({ phase: 'loading' })
    const result = await bridge.remoteImage(sessionId, src, prompt).catch((): RemoteImageResult => ({ ok: false, code: 'network' }))
    if (result.ok) rememberLoaded(src, result.dataUrl)
    setState(remoteImageState(result, prompt))
  }
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    if (loaded.has(src)) return
    void load(false)
  }, [src, sessionId])

  useEffect(() => {
    group?.report(memberKey, { src, state, load: (prompt) => void loadRef.current(prompt) })
  }, [group, memberKey, src, state])

  useEffect(() => (group ? () => group.report(memberKey, null) : undefined), [group, memberKey])

  if (state.phase === 'ready') return <MessageImage src={state.dataUrl} alt={alt} className={className} />
  if (group) return null
  const host = remoteImageHost(src)
  const label = state.phase === 'failed'
    ? t(state.code === 'denied' ? 'chat.remoteImageDenied' : 'chat.remoteImageFailed', { host })
    : t('chat.remoteImageLoad', { host })
  return (
    <Button
      size="sm"
      variant="secondary"
      className="v3-remote-image"
      data-testid="v3-remote-image"
      data-phase={state.phase}
      isDisabled={state.phase === 'checking' || state.phase === 'loading'}
      onPress={() => void load(true)}
      aria-label={alt ? `${label} · ${alt}` : label}
    >
      <ImageDown size={14} aria-hidden />
      {label}
    </Button>
  )
}
