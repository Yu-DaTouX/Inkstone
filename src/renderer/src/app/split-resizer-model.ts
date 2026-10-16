/**
 * 并排视图两列在「像素」与「份额」之间的换算（SideBySide 分隔条适配层）。
 *
 * 分隔条原语 `ui/Splitter` 的值是**像素**标量（受控值时原语按 min/max 夹取，
 * 拖动用按下那一刻的值 + 指针位移，不依赖调用方在 pointerdown 后立刻重渲）；
 * 分屏状态 `state/split-view.weights` 记的是各列的相对份额，窗口变宽变窄时各列
 * 按比例跟着变。这里只做算术与一次「读相邻两列真实像素」的绑定：调宽只在相邻
 * 两列之间分配，两列合计份额不变，其余列不动。
 *
 * 不 import React / store / DOM 类型，便于 `scripts/test-v3-side-by-side-resize.mjs`
 * 在 Node 里用纯值、SSR 与 mockResizeObserver 钉死；真实拖动与窗口行为另在运行验收。
 */

/** 拖动时一列至少留这么宽（与 v3 并排视图原有取值一致）。 */
export const MIN_COLUMN = 300

/** 键盘每按一下挪多少像素。 */
export const KEY_STEP = 24

export interface PairMetrics {
  /** 左列像素宽 */
  left: number
  /** 相邻两列合计像素宽 */
  total: number
}

export interface PairBounds {
  min: number
  max: number
}

const usable = (value: number): boolean => Number.isFinite(value) && value > 0

/** 两栏像素宽（非有限值或负值按 0，避免算出 NaN 份额）。 */
export function measurePair(leftWidth: number, rightWidth: number): PairMetrics {
  const left = usable(leftWidth) ? leftWidth : 0
  const right = usable(rightWidth) ? rightWidth : 0
  return { left, total: left + right }
}

/** 两个度量是否一致；一致时调用方应保留旧对象，别为同一像素多渲染一次。 */
export function samePair(a: PairMetrics | null, b: PairMetrics | null): boolean {
  return !!a && !!b && a.left === b.left && a.total === b.total
}

/**
 * 由合计宽度得出被拖动那一列的取值范围。
 * 放不下两列最小宽时退化为「整条都可分配（0..total）」，与旧分隔条的窄宽夹取一致。
 */
export function pairBounds(total: number, minColumn: number = MIN_COLUMN): PairBounds {
  if (!usable(total)) return { min: 0, max: 0 }
  if (total < 2 * minColumn) return { min: 0, max: total }
  return { min: minColumn, max: total - minColumn }
}

/** 把像素值夹到拖动范围内；非有限值退回下界。 */
export function clampPairValue(value: number, bounds: PairBounds): number {
  if (!Number.isFinite(value)) return bounds.min
  if (value < bounds.min) return bounds.min
  if (value > bounds.max) return bounds.max
  return value
}

/**
 * 按住左列的新像素宽重新分配这两列的合计份额。
 * 合计宽未知或合计份额非法时退回等分，不产生 NaN；夹取到 `[0, total]` 让左右都非负。
 */
export function weightsForLeft(leftPx: number, total: number, share: number): { left: number; right: number } {
  const safeShare = usable(share) ? share : 1
  if (!usable(total)) return { left: safeShare / 2, right: safeShare / 2 }
  const at = clampPairValue(leftPx, { min: 0, max: total })
  const left = (safeShare * at) / total
  return { left, right: safeShare - left }
}

/** 由两栏份额与合计宽反推左列像素宽（首帧/还没量到 DOM 时给原语的显示值）。 */
export function leftPxForWeights(
  leftWeight: number,
  rightWeight: number,
  metrics: PairMetrics,
  minColumn: number = MIN_COLUMN
): number {
  const bounds = pairBounds(metrics.total, minColumn)
  const left = usable(leftWeight) ? leftWeight : 0
  const right = usable(rightWeight) ? rightWeight : 0
  if (!usable(metrics.total) || !usable(left + right)) return bounds.min
  return clampPairValue((metrics.total * left) / (left + right), bounds)
}

/* ── 相邻两列真实像素的读取与观察（DOM 绑定，可在 Node 里用替身验证） ─────── */

export interface MeasuredElement {
  getBoundingClientRect(): { width: number }
}

export interface PairHost {
  previousElementSibling: MeasuredElement | null
  nextElementSibling: MeasuredElement | null
}

export interface PairObserver {
  observe(target: MeasuredElement): void
  disconnect(): void
}

export type PairObserverFactory = (onResize: () => void) => PairObserver

/** 没有 ResizeObserver 的环境（SSR / 老运行时）退回空观察器，只保留首次读取。 */
export const createPairObserver: PairObserverFactory = (onResize) =>
  typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => onResize())
    : { observe: () => {}, disconnect: () => {} }

/** 读一次相邻两列的真实像素宽；缺任一侧返回 null。 */
export function readPair(host: PairHost): PairMetrics | null {
  const a = host.previousElementSibling
  const b = host.nextElementSibling
  if (!a || !b) return null
  return measurePair(a.getBoundingClientRect().width, b.getBoundingClientRect().width)
}

/**
 * 绑定相邻两列的宽度测量：挂载时立刻读一次（首帧就有值），之后由观察器在窗口
 * 变化、列宽变化时复读；返回的函数断开观察。同一像素重复上报由 `samePair` 挡。
 * 缺任一侧时什么都不做，返回空清理函数。
 */
export function bindPairObserver(
  host: PairHost,
  onMeasure: (metrics: PairMetrics) => void,
  createObserver: PairObserverFactory = createPairObserver
): () => void {
  const a = host.previousElementSibling
  const b = host.nextElementSibling
  const read = (): void => {
    const metrics = readPair(host)
    if (metrics) onMeasure(metrics)
  }
  read()
  if (!a || !b) return () => {}
  const observer = createObserver(read)
  observer.observe(a)
  observer.observe(b)
  return () => observer.disconnect()
}
