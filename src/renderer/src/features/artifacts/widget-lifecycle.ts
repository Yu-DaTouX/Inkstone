import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useId
} from 'react'
import type { HtmlArtifactPreviewResult } from '../../../../shared/html-artifact-preview'

export interface WidgetIdentity {
  readonly sessionId: string | null
  readonly messageId: string | null
  readonly instanceId: string
}

export const WidgetIdentityContext = createContext<WidgetIdentity | null>(null)

export function useWidgetIdentity(): WidgetIdentity | null {
  return useContext(WidgetIdentityContext)
}

export function useMarkdownIdentity(sessionId: string | null | undefined, messageId: string | null | undefined): WidgetIdentity {
  const instanceId = useId()
  return useMemo(
    () => ({ sessionId: sessionId ?? null, messageId: messageId ?? null, instanceId }),
    [sessionId, messageId, instanceId]
  )
}

export interface WidgetKeyParts {
  readonly sessionId: string | null
  readonly messageId: string | null
  readonly instanceId: string
  readonly localKey?: string | undefined
  readonly widgetId: string
}

export function deriveWidgetIdentityKey(parts: WidgetKeyParts): string {
  if (parts.messageId) {
    const local = parts.localKey && parts.localKey.length > 0 ? parts.localKey : `w:${parts.widgetId}`
    return ['msg', parts.sessionId ?? '', parts.messageId, parts.instanceId, local].join('\u0000')
  }
  return ['inst', parts.instanceId, parts.widgetId].join('\u0000')
}

export function deriveArtifactIdentityKey(sessionId: string | null, messageId: string | null, artifactId: string): string {
  return messageId ? ['msg', sessionId ?? '', messageId, artifactId].join('\u0000') : ['art', artifactId].join('\u0000')
}

export const MAX_PREVIEW_SNAPSHOTS = 12

export type SnapshotStatus = 'idle' | 'preparing' | 'ready' | 'paused' | 'error'

export interface SnapshotView {
  readonly status: SnapshotStatus
  readonly url: string | null
  readonly error: string | null
}

const IDLE_VIEW: SnapshotView = Object.freeze({ status: 'idle', url: null, error: null })

export interface SnapshotRequest {
  readonly revision: string
  readonly prepare: () => Promise<HtmlArtifactPreviewResult>
  readonly release: (url: string) => void | Promise<void>
}

interface Reservation {
  readonly key: string
  state: 'pending' | 'held' | 'releasing'
  url: string | null
  readonly release: (url: string) => void | Promise<void>
}

interface Entry {
  readonly key: string
  wanted: boolean
  releasePending: boolean
  lastSeenAt: number
  order: number
  revision: string
  request: SnapshotRequest | null
  reservation: Reservation | null
  status: SnapshotStatus
  url: string | null
  error: string | null
  view: SnapshotView
}

export class PreviewSnapshotLifecycle {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  private readonly reservations = new Set<Reservation>()
  private sequence = 0

  constructor(
    private readonly budget: number = MAX_PREVIEW_SNAPSHOTS,
    private readonly now: () => number = Date.now,
    private readonly schedule: (task: () => void) => void = (task) => queueMicrotask(task),
    private readonly onReleaseError: (error: unknown, key: string) => void = () => {}
  ) {
    if (!Number.isInteger(budget) || budget < 1) {
      throw new Error('PreviewSnapshotLifecycle: budget must be a positive integer')
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  peek = (key: string): SnapshotView => this.entries.get(key)?.view ?? IDLE_VIEW

  occupancy(): number {
    return this.reservations.size
  }

  want(key: string, request: SnapshotRequest): void {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        key,
        wanted: true,
        releasePending: false,
        lastSeenAt: this.now(),
        order: ++this.sequence,
        revision: request.revision,
        request,
        reservation: null,
        status: 'idle',
        url: null,
        error: null,
        view: IDLE_VIEW
      }
      this.entries.set(key, entry)
    }
    entry.wanted = true
    entry.releasePending = false
    entry.lastSeenAt = this.now()
    entry.order = ++this.sequence
    entry.request = request

    if (entry.status === 'ready' && entry.revision === request.revision) return

    if (entry.revision !== request.revision) {
      this.releaseCurrent(entry)
      entry.status = 'idle'
      entry.error = null
      entry.revision = request.revision
    }
    if (entry.status === 'preparing') return
    this.admit(entry)
  }

  unwant(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.wanted = false
    if (entry.reservation) {
      if (entry.releasePending) return
      entry.releasePending = true
      const snapshot = entry
      this.schedule(() => {
        const current = this.entries.get(key)
        if (current !== snapshot || current.wanted || !current.releasePending) return
        this.drop(snapshot)
      })
      return
    }
    this.entries.delete(key)
    this.notify()
  }

  resume(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.wanted = true
    entry.releasePending = false
    entry.lastSeenAt = this.now()
    entry.order = ++this.sequence
    if (entry.reservation) return
    if (this.occupancy() >= this.budget) {
      const victim = this.evictionCandidate(key)
      if (victim) this.park(victim)
    }
    this.admit(entry)
  }

  private admit(entry: Entry): void {
    if (this.occupancy() >= this.budget) {
      const busy = entry.error === 'busy'
      entry.status = 'paused'
      entry.error = busy ? 'busy' : null
      this.publish(entry)
      return
    }
    this.start(entry)
  }

  private start(entry: Entry): void {
    const request = entry.request
    if (!request) return
    const reservation: Reservation = {
      key: entry.key,
      state: 'pending',
      url: null,
      release: request.release
    }
    this.reservations.add(reservation)
    entry.reservation = reservation
    entry.status = 'preparing'
    entry.error = null
    this.publish(entry)

    let prepared: Promise<HtmlArtifactPreviewResult>
    try {
      prepared = request.prepare()
    } catch {
      this.settlePrepare(entry, reservation, { ok: false, error: 'read' })
      return
    }
    Promise.resolve(prepared).then(
      (result) => this.settlePrepare(entry, reservation, result),
      () => this.settlePrepare(entry, reservation, { ok: false, error: 'read' })
    )
  }

  private settlePrepare(entry: Entry, reservation: Reservation, result: HtmlArtifactPreviewResult): void {
    if (!this.reservations.has(reservation)) {
      if (result.ok) this.performRelease(reservation, result.url)
      return
    }
    const attached = this.entries.get(entry.key) === entry && entry.reservation === reservation
    const live = attached && entry.wanted && !entry.releasePending
    if (!live) {
      if (attached) {
        entry.reservation = null
        entry.status = 'idle'
        entry.error = null
        this.publish(entry)
      }
      if (result.ok) {
        this.performRelease(reservation, result.url)
      } else {
        this.settleReservation(reservation)
        this.promote()
      }
      return
    }
    if (result.ok) {
      reservation.state = 'held'
      reservation.url = result.url
      entry.url = result.url
      entry.status = 'ready'
      entry.error = null
      this.publish(entry)
      return
    }
    this.settleReservation(reservation)
    entry.reservation = null
    entry.url = null
    if (result.error === 'busy') {
      entry.status = 'paused'
      entry.error = 'busy'
      this.publish(entry)
      return
    }
    entry.status = 'error'
    entry.error = result.error
    this.publish(entry)
    this.promote()
  }

  private park(entry: Entry): void {
    this.releaseCurrent(entry)
    entry.status = 'paused'
    entry.error = null
    this.publish(entry)
  }

  private drop(entry: Entry): void {
    entry.releasePending = false
    this.releaseCurrent(entry)
    this.entries.delete(entry.key)
    this.notify()
    this.promote()
  }

  private releaseCurrent(entry: Entry): void {
    const reservation = entry.reservation
    entry.reservation = null
    entry.url = null
    if (!reservation) return
    if (reservation.state === 'pending') return
    if (reservation.state === 'held') this.performRelease(reservation, reservation.url ?? '')
  }

  private performRelease(reservation: Reservation, url: string): void {
    reservation.state = 'releasing'
    reservation.url = null
    let outcome: void | Promise<void>
    try {
      outcome = reservation.release(url)
    } catch (error) {
      this.onReleaseError(error, reservation.key)
      return
    }
    Promise.resolve(outcome).then(
      () => {
        this.settleReservation(reservation)
        this.promote()
      },
      (error) => {
        this.onReleaseError(error, reservation.key)
      }
    )
  }

  private settleReservation(reservation: Reservation): void {
    this.reservations.delete(reservation)
  }

  private promote(): void {
    if (this.occupancy() >= this.budget) return
    const waiting = [...this.entries.values()]
      .filter((entry) => entry.wanted && !entry.releasePending && entry.status === 'paused' && entry.error !== 'busy')
      .sort((a, b) => b.order - a.order || b.lastSeenAt - a.lastSeenAt)
    for (const entry of waiting) {
      if (this.occupancy() >= this.budget) break
      this.start(entry)
    }
  }

  private evictionCandidate(exclude: string): Entry | null {
    let candidate: Entry | null = null
    for (const entry of this.entries.values()) {
      if (entry.key === exclude || !entry.wanted || !entry.reservation) continue
      if (!candidate || entry.order < candidate.order || (entry.order === candidate.order && entry.lastSeenAt < candidate.lastSeenAt)) candidate = entry
    }
    return candidate
  }

  private publish(entry: Entry): void {
    entry.view = Object.freeze({ status: entry.status, url: entry.url, error: entry.error })
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

let sharedLifecycle: PreviewSnapshotLifecycle | null = null

export function sharedPreviewSnapshots(): PreviewSnapshotLifecycle {
  if (!sharedLifecycle) sharedLifecycle = new PreviewSnapshotLifecycle()
  return sharedLifecycle
}

export interface NearViewportOptions {
  readonly rootMargin?: string
  readonly exitRootMargin?: string
}

export function useNearViewport<T extends Element>(
  options: NearViewportOptions = {}
): [boolean, (node: T | null) => void] {
  const { rootMargin = '240px', exitRootMargin = '1200px' } = options
  const [near, setNear] = useState(false)
  const [node, setNode] = useState<T | null>(null)
  const ref = useCallback((next: T | null) => setNode(next), [])
  useEffect(() => {
    if (!node || typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return undefined
    }
    const load = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      { rootMargin }
    )
    const keep = new IntersectionObserver(
      (entries) => {
        if (entries.every((entry) => !entry.isIntersecting)) setNear(false)
      },
      { rootMargin: exitRootMargin }
    )
    load.observe(node)
    keep.observe(node)
    return () => {
      load.disconnect()
      keep.disconnect()
    }
  }, [node, rootMargin, exitRootMargin])
  return [near, ref]
}

export interface PreviewSnapshotOptions {
  readonly identityKey: string
  readonly source: string | null
  readonly active: boolean
  readonly prepare: (source: string) => Promise<HtmlArtifactPreviewResult>
  readonly release: (url: string) => void | Promise<void>
  readonly lifecycle?: PreviewSnapshotLifecycle
}

export interface PreviewSnapshotHandle extends SnapshotView {
  readonly resume: () => void
}

export function usePreviewSnapshot(options: PreviewSnapshotOptions): PreviewSnapshotHandle {
  const lifecycle = options.lifecycle ?? sharedPreviewSnapshots()
  const { identityKey, source, active } = options
  const prepareRef = useRef(options.prepare)
  const releaseRef = useRef(options.release)
  prepareRef.current = options.prepare
  releaseRef.current = options.release

  const view = useSyncExternalStore(
    lifecycle.subscribe,
    () => lifecycle.peek(identityKey),
    () => lifecycle.peek(identityKey)
  )

  useEffect(() => {
    if (!source || !active) {
      lifecycle.unwant(identityKey)
      return undefined
    }
    lifecycle.want(identityKey, {
      revision: source,
      prepare: () => prepareRef.current(source),
      release: (url) => releaseRef.current(url)
    })
    return () => lifecycle.unwant(identityKey)
  }, [lifecycle, identityKey, source, active])

  const resume = useCallback(() => lifecycle.resume(identityKey), [lifecycle, identityKey])
  return { ...view, resume }
}
