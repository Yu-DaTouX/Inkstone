/**
 * 提示气泡（Tip）的调度器 —— 纯逻辑，不依赖 React / DOM，可在 Node 里直接验证。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决的问题
 * ══════════════════════════════════════════════════════════════════
 * 原生 `title` 悬停约 1 秒才出现、键盘聚焦不显示、不能排版、也不跟深浅主题。
 * 统一提示气泡要更克制：
 *
 *   · **首次悬停**等约 400ms 才出现 —— 指针扫过工具栏时不至于一路弹；
 *   · 一个气泡出现后进入「热」状态：之后移到相邻按钮用短延迟（0ms）切换，
 *     连续探索不用每次重等；
 *   · **键盘聚焦**立即出现（走 `immediate`）；
 *   · 任何时刻只显示一个；
 *   · 离开、卸载、Esc 都要清掉待开定时器，不能泄漏。
 *
 * 这里只做「什么时候开 / 关」的决策，实际的 DOM 与 portal 由 `Tip` 组件负责。
 * 通过注入 `TipTimerHost` 可以拿到确定性的时间与定时器，便于单测。
 */

export const TIP_FIRST_DELAY_MS = 400
/** 已经出现过气泡后的相邻切换延迟（几乎是立即，但不与上一帧同一拍） */
export const TIP_WARM_DELAY_MS = 0
/** 「热」状态保持的窗口：在这段时间内再次悬停都走短延迟 */
export const TIP_WARM_WINDOW_MS = 600

export interface TipTimerHost {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

const defaultHost: TipTimerHost = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now()
}

export class TipScheduler {
  private visibleId: symbol | null = null
  private visibleHide: (() => void) | null = null
  private pendingId: symbol | null = null
  private pendingTimer: unknown = null
  private warmUntil = 0

  constructor(private readonly host: TipTimerHost = defaultHost) {}

  /**
   * 请示打开某个提示。`show` 在延迟到点时调用，`hide` 留给之后关闭它。
   * 返回实际采用的延迟（毫秒），便于测试断言。
   */
  request(id: symbol, show: () => void, hide: () => void, immediate = false): number {
    /* 已经显示的就是它：只刷新关闭回调，不重启动画（标签/快捷键更新不走这里） */
    if (this.visibleId === id) {
      this.visibleHide = hide
      return 0
    }
    this.clearPendingTimer()
    /* 已有气泡显示 / 刚关过：都算「热」，相邻切换不再重等首次延迟 */
    const warm = this.visibleId !== null || this.host.now() < this.warmUntil
    const delay = immediate ? 0 : warm ? TIP_WARM_DELAY_MS : TIP_FIRST_DELAY_MS
    if (delay <= 0) {
      this.show(id, show, hide)
      return 0
    }
    this.pendingId = id
    this.pendingTimer = this.host.setTimeout(() => {
      this.pendingTimer = null
      this.pendingId = null
      this.show(id, show, hide)
    }, delay)
    return delay
  }

  /** 悬停还没到延迟就离开：取消待开定时器，不进入热状态。 */
  cancel(id: symbol): void {
    if (this.pendingId === id) this.clearPendingTimer()
  }

  /**
   * 组件不再需要这个提示（离开 / 卸载）。待开则取消；已显示则只清登记。
   * 这里**不调用** `hide`（调用方正在卸载 / 已自行收场），避免 setState 落在
   * 正在卸载的组件上；留下的「可见」登记必须清掉，否则下一个提示会误以为
   * 还有气泡在显示。
   */
  release(id: symbol): void {
    if (this.pendingId === id) this.clearPendingTimer()
    if (this.visibleId === id) {
      this.visibleId = null
      this.visibleHide = null
      this.markWarm()
    }
  }

  /** Esc：关掉当前提示。返回是否真的关掉了一个。 */
  dismiss(): boolean {
    if (this.visibleId === null) return false
    this.hideVisible()
    this.markWarm()
    return true
  }

  isVisible(id: symbol): boolean {
    return this.visibleId === id
  }

  get hasPending(): boolean {
    return this.pendingId !== null
  }

  /** 测试与热重载用：清空全部状态与定时器。 */
  reset(): void {
    this.clearPendingTimer()
    this.visibleId = null
    this.visibleHide = null
    this.warmUntil = 0
  }

  private show(id: symbol, show: () => void, hide: () => void): void {
    if (this.visibleId !== null && this.visibleId !== id) this.hideVisible()
    this.visibleId = id
    this.visibleHide = hide
    this.markWarm()
    show()
  }

  private hideVisible(): void {
    const hide = this.visibleHide
    this.visibleId = null
    this.visibleHide = null
    hide?.()
  }

  private markWarm(): void {
    this.warmUntil = this.host.now() + TIP_WARM_WINDOW_MS
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== null) this.host.clearTimeout(this.pendingTimer)
    this.pendingTimer = null
    this.pendingId = null
  }
}

/** 应用内共享实例：保证任何时刻只显示一个提示。 */
export const tipScheduler = new TipScheduler()

/**
 * 悬停与聚焦的合取：任一存在就保持提示，两者都无才收起。
 * 鼠标移入后再失焦、或键盘聚焦后鼠标扫过又离开，都不会闪断。
 */
export function isTipActive(input: { hover: boolean; focused: boolean }): boolean {
  return input.hover || input.focused
}
