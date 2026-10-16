/**
 * 预览快照的**有界生命周期**与**每个实例独立的身份**（WP-32 · R5/T3）。
 *
 * 背景（T3 确证）：`WidgetBlock` 与 `MessageParts` 的 HTML 成果在挂载时就
 * `prepare` 出宿主快照，离屏/冻结后只卸 iframe、不释放快照；主进程
 * `HtmlArtifactPreviewStore` 只有 16 个并发位，于是 17 个块就永久 `busy`。
 * 同时两边都拿「消息内字符 offset」当身份，跨消息/跨会话会串状态。
 *
 * 本模块只做两件事，且都可在 Node 里直接跑（不启动 Electron、不碰真实 IPC）：
 *   1. `PreviewSnapshotLifecycle`：按 near/active 懒申请、总量有界、离屏/退场/
 *      被抢占时释放、迟到的 prepare 也释放、budget 满时明确暂停并可用户恢复；
 *      不靠捕获 `busy` 无限重试。两个入口共用同一个实例，因此上限作用于
 *      「所有受管快照」，而不是各管各的 iframe 数。
 *
 *      预算按**宿主 reservation** 计：prepare 在途、URL 就绪、release 已发但
 *      未确认都占位；UI 条目删除/换代/被抢占只解除与 reservation 的绑定，不提前
 *      归还预算。迟到的成功必须 release 并等确认才让位，迟到失败立即归还。
 *      release 拒绝或同步抛错时不让 Promise 变成 unhandled，并保守地继续占位
 *      （无法确认宿主已释放，不假定已释放）。
 *   2. 身份派生：优先用调用方给的 session/message 身份；缺失时退到 React
 *      `useId` 的**每实例唯一**值，绝不用全局 `'widget'` 或裸 offset。
 *
 * 安全边界不变：不新改主进程 limit、不放宽 CSP、不接触 `allow`/`srcDoc`。
 */
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

/* ─────────────────────────────────────────────── 身份 */

/**
 * 消息级身份上下文。`messageId` 只有调用方真的知道时才填；
 * 缺失就是 `null`，**不伪造**。`instanceId` 是 Markdown/MarkdownPre 实例的
 * `useId`，保证同一份缓存正文被两条消息复用时仍各自独立。
 */
export interface WidgetIdentity {
  readonly sessionId: string | null
  readonly messageId: string | null
  readonly instanceId: string
}

export const WidgetIdentityContext = createContext<WidgetIdentity | null>(null)

export function useWidgetIdentity(): WidgetIdentity | null {
  return useContext(WidgetIdentityContext)
}

/** Markdown 层用的稳定实例身份：real 身份可缺，`instanceId` 一定唯一。 */
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
  /** Markdown 显示实例身份（`useId`），真实消息也可能同时显示多次。 */
  readonly instanceId: string
  /** 消息内位置标识（Markdown 字符 offset），可能缺省。 */
  readonly localKey?: string | undefined
  /** Widget 实例级 fallback（`useId`），在同一消息内区分多个小部件。 */
  readonly widgetId: string
}

/**
 * 小部件身份键。
 *
 * 有真实 `messageId` 时：`msg\0sessionId\0messageId\0markdownInstanceId\0localKey`；
 * 同一消息在不同显示实例里也不共享状态。位置缺失则用 Widget 实例的 `useId`。
 * 没有 `messageId` 时：`inst\0markdownInstanceId\0widgetId`。两种情况都保证
 * 「同内容两条消息」得到不同的键，因此 `savedWidgetState` 与 `ArtifactFrame`
 * 身份不会串。
 *
 * 已知限制：显示实例身份只在挂载期间稳定。卸载再挂载（例如消息被虚拟化
 * 回收后重新渲染）会换新键，届时内存态不保证恢复——这是明确接受的取舍，
 * 不假装有持久会话身份。
 */
export function deriveWidgetIdentityKey(parts: WidgetKeyParts): string {
  if (parts.messageId) {
    const local = parts.localKey && parts.localKey.length > 0 ? parts.localKey : `w:${parts.widgetId}`
    return ['msg', parts.sessionId ?? '', parts.messageId, parts.instanceId, local].join('\u0000')
  }
  return ['inst', parts.instanceId, parts.widgetId].join('\u0000')
}

/** 成果卡（HTML 文件）身份键：有真实消息身份就用，否则用 artifact id（全局唯一）。 */
export function deriveArtifactIdentityKey(sessionId: string | null, messageId: string | null, artifactId: string): string {
  return messageId ? ['msg', sessionId ?? '', messageId, artifactId].join('\u0000') : ['art', artifactId].join('\u0000')
}

/* ─────────────────────────────────────────────── 快照生命周期 */

/**
 * 客户端快照并发上限。主进程 `HtmlArtifactPreviewStore` 的上限是 16；
 * 这里取 12，留出余量给非受管预览调用，不去改主进程也不放宽 CSP。
 * 达到上限时新的块进入 `paused`（可见、可恢复），而不是撞上宿主 `busy`。
 */
export const MAX_PREVIEW_SNAPSHOTS = 12

export type SnapshotStatus = 'idle' | 'preparing' | 'ready' | 'paused' | 'error'

export interface SnapshotView {
  readonly status: SnapshotStatus
  readonly url: string | null
  readonly error: string | null
}

const IDLE_VIEW: SnapshotView = Object.freeze({ status: 'idle', url: null, error: null })

export interface SnapshotRequest {
  /** 内容/来源版本。同一身份、同一 revision 重复申请不重建。 */
  readonly revision: string
  readonly prepare: () => Promise<HtmlArtifactPreviewResult>
  readonly release: (url: string) => void | Promise<void>
}

/**
 * 一个**宿主快照位**（reservation）。它的生命期独立于 UI 的 `Entry`：
 * UI 条目可以在离屏/换代时删除，但只要宿主仍在 prepare、或还没确认 release，
 * 这个 reservation 就必须继续占预算。`occupancy()` 数的是它，而不是可见条目。
 *
 * 每个 reservation 固定绑定它 start 时的 `release`（lease），因此后来的
 * `want` 换 request 也不会覆盖旧回包的释放通道；旧回包只作用于自己的 reservation，
 * 绝不会写到新的 view。
 */
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
  /** 单调递增的最近使用序（不依赖墙钟，避免 Date.now 同毫秒时抢占/恢复抖动）。 */
  order: number
  revision: string
  request: SnapshotRequest | null
  /** 当前 attempt 的宿主 reservation；释放中/被孤立时置空，但 reservation 仍在登记表内。 */
  reservation: Reservation | null
  status: SnapshotStatus
  url: string | null
  error: string | null
  view: SnapshotView
}

/**
 * 受管预览快照登记表。
 *
 * 用法（组件里）：
 *   · `want(key, request)`：进入视口（active）时申请；
 *   · `unwant(key)`：离屏/卸载时释放（异步合并，StrictMode 双调用下不抖动）；
 *   · `resume(key)`：用户在「已暂停」上点恢复时强制让位并重新申请。
 *
 * 测试可用 `new PreviewSnapshotLifecycle(budget, now, schedule)` 注入假时钟/
 * 假桥，直接驱动异步 prepare/release，不需要真实 Electron 或网络。
 */
export class PreviewSnapshotLifecycle {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  /**
   * 所有尚未归还宿主的快照位：prepare 在途、URL 就绪、release 已发但未确认。
   * 预算按这个集合计，而不是按可见条目计——所以 UI 条目被删除/换代时，
   * 在途或释放中的位仍然占着预算。
   */
  private readonly reservations = new Set<Reservation>()
  /** 每次 want/resume 递增，给 LRU 排序提供确定性的先后（不受 Date.now 同毫秒影响）。 */
  private sequence = 0

  constructor(
    private readonly budget: number = MAX_PREVIEW_SNAPSHOTS,
    private readonly now: () => number = Date.now,
    private readonly schedule: (task: () => void) => void = (task) => queueMicrotask(task),
    /**
     * `release` 拒绝或同步抛错时的观察点。默认吞掉，绝不让 Promise 变成
     * unhandled rejection；同时**保守地继续把该 reservation 计入占用**，
     * 因为无法确认宿主已经让位（安全失败优先于假定已释放）。
     */
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

  /**
   * 已占用的宿主快照位数：prepare 在途、URL 就绪、release 未确认都算。
   * 用它而不是可见条目数来核对有界性。
   */
  occupancy(): number {
    return this.reservations.size
  }

  /** 进入视口 / 仍在视口：申请（或保持）一个快照。 */
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

    /* 同一身份、同一来源已经就绪：切换形态等纯呈现变化不重建快照。 */
    if (entry.status === 'ready' && entry.revision === request.revision) return

    if (entry.revision !== request.revision) {
      /* 内容换代：旧 URL 走异步 release 确认，旧的在途 prepare 作为孤立位继续占预算。 */
      this.releaseCurrent(entry)
      entry.status = 'idle'
      entry.error = null
      entry.revision = request.revision
    }
    if (entry.status === 'preparing') return
    this.admit(entry)
  }

  /** 离屏 / 卸载：释放该身份的快照。异步合并，短时间内的反复切换不抖动。 */
  unwant(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.wanted = false
    /* 只要还持有宿主位（在途或就绪）就延后合并释放；paused/error 没有位，直接移除。 */
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

  /**
   * 用户在「已暂停」上点恢复：明确让出最久未见的活跃快照，再重新申请。
   * 这是唯一会抢占其它身份的入口，避免所有 near 块自动抢槽造成抖动。
   */
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

  /**
   * 真正占一个宿主位并启动 prepare。reservation 一旦登记，就只由
   * `settlePrepare`（失败归还）或 `performRelease` 的确认（成功归还）移除。
   */
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
      /* 同步抛错也当一次失败结算，不让 reservation 永远卡住预算。 */
      this.settlePrepare(entry, reservation, { ok: false, error: 'read' })
      return
    }
    Promise.resolve(prepared).then(
      (result) => this.settlePrepare(entry, reservation, result),
      () => this.settlePrepare(entry, reservation, { ok: false, error: 'read' })
    )
  }

  /**
   * 结算一次 prepare。迟到的回包按 reservation 身份判断归属：
   *   · 仍属于当前可见条目 → 登记为 held；
   *   · 已被删除/换代/离屏（孤立）→ ok 立即 release 并等确认，失败直接归还。
   */
  private settlePrepare(entry: Entry, reservation: Reservation, result: HtmlArtifactPreviewResult): void {
    if (!this.reservations.has(reservation)) {
      /* 防御分支：位已不在（理论上不该发生），若还成功拿到 URL 仍需释放。 */
      if (result.ok) this.performRelease(reservation, result.url)
      return
    }
    const attached = this.entries.get(entry.key) === entry && entry.reservation === reservation
    const live = attached && entry.wanted && !entry.releasePending
    if (!live) {
      if (attached) {
        /* UI 条目还在但不再需要：脱钩，让后续 want 能重新 admit。 */
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
    /* prepare 明确失败：归还 reservation，让等待者有机会上来。 */
    this.settleReservation(reservation)
    entry.reservation = null
    entry.url = null
    if (result.error === 'busy') {
      /* 宿主真的满了：明确暂停等用户恢复，不在这里无限重试。 */
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

  /** 被更高优先级/用户恢复抢占：释放该位，条目变成可恢复的暂停。 */
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

  /**
   * 把条目的当前 reservation 交还给宿主：
   *   · held → 发起 release，确认前仍占位；
   *   · pending → 只脱钩，等 prepare 结算时释放 URL（仍是占位）。
   */
  private releaseCurrent(entry: Entry): void {
    const reservation = entry.reservation
    entry.reservation = null
    entry.url = null
    if (!reservation) return
    if (reservation.state === 'pending') return
    if (reservation.state === 'held') this.performRelease(reservation, reservation.url ?? '')
  }

  /** 发起一次 release 并等它确认；同步抛错/拒绝都不算已释放（保守占位）。 */
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

  /** 归还一个 reservation（宿主已确认不再持有）。 */
  private settleReservation(reservation: Reservation): void {
    this.reservations.delete(reservation)
  }

  /** 有位置时按最近可见顺序接纳被预算挡下的块（不接纳宿主 busy 的）。 */
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

/* ─────────────────────────────────────────────── React 接线 */

let sharedLifecycle: PreviewSnapshotLifecycle | null = null

/** 两个入口（小部件 / HTML 成果卡）共用的同一个受管实例。 */
export function sharedPreviewSnapshots(): PreviewSnapshotLifecycle {
  if (!sharedLifecycle) sharedLifecycle = new PreviewSnapshotLifecycle()
  return sharedLifecycle
}

export interface NearViewportOptions {
  /** 进入该距离即视为 near（与 `ArtifactFrame` 的装载阈值一致）。 */
  readonly rootMargin?: string
  /** 离开该距离才取消 near，避免边缘来回抖动。 */
  readonly exitRootMargin?: string
}

/**
 * 把「是否靠近视口」的观察抽出来，供申请快照与 `ArtifactFrame` 共用同一信号。
 * 返回 `[near, ref]`；`ref` 是回调 ref，元素换挂载也会重新观察。
 */
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
  /** 内容/来源；`null` 表示此实例当前没有可申请的快照（例如源码态）。 */
  readonly source: string | null
  /** near / 可见等「值得持有快照」的信号。 */
  readonly active: boolean
  readonly prepare: (source: string) => Promise<HtmlArtifactPreviewResult>
  readonly release: (url: string) => void | Promise<void>
  readonly lifecycle?: PreviewSnapshotLifecycle
}

export interface PreviewSnapshotHandle extends SnapshotView {
  readonly resume: () => void
}

/** 组件侧 glue：把 near/身份接到 `PreviewSnapshotLifecycle` 上，不重复实现状态机。 */
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
