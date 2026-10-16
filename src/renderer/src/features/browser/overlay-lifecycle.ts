/**
 * 遮挡 blocker 的生命周期（可注入，脱离 React / DOM 单测）。
 *
 * 背景：`useBrowserOverlayBlocker` 用 MutationObserver 观察浮层，回调里
 * `schedule` 一帧再 `evaluate`。卸载时若只 `disconnect` + `release`，已经排队
 * 的 rAF 仍会跑，`evaluate` 可能重新 `acquire` 一个没人再 release 的 blocker，
 * 把之后的原生浏览器永久挡住。这里把「调度 / 评估 / 处置」抽成一个不依赖
 * React 的小对象：
 *   · `dispose` 置 `disposed` 并取消挂起帧；
 *   · `evaluate` 先看 `disposed`，即使回调已经出队也直接返回，绝不重领；
 *   · 释放与领取都只经过注入的 `acquire`，沿用上游 `OverlayBlockers` 的
 *     token 语义，不在这里造第二套可见性状态。
 */
export interface OverlayBlockerLifecycleDeps {
  /** 当前界面上是否存在遮挡浮层。 */
  hasOverlay: () => boolean
  /** 领取 blocker：返回释放函数（真实调用点是 store 的 acquireOverlayBlocker）。 */
  acquire: () => () => void
  /** 帧调度；默认 requestAnimationFrame。 */
  requestFrame?: (callback: () => void) => number
  /** 帧取消；默认 cancelAnimationFrame。 */
  cancelFrame?: (handle: number) => void
}

export interface OverlayBlockerLifecycle {
  /** 请求在一帧后评估；重复调用只排一帧。 */
  schedule: () => void
  /** 立即评估一次（挂载时的首帧判定）。 */
  evaluate: () => void
  /** 停止调度并归还持有中的 blocker；幂等，只归还自己领的那一次。 */
  dispose: () => void
  /** 当前是否持有 blocker（测试/排查用）。 */
  holding: () => boolean
}

export function createOverlayBlockerLifecycle(deps: OverlayBlockerLifecycleDeps): OverlayBlockerLifecycle {
  const requestFrame = deps.requestFrame ?? ((callback) => requestAnimationFrame(callback))
  const cancelFrame = deps.cancelFrame ?? ((handle) => cancelAnimationFrame(handle))

  let disposed = false
  let release: (() => void) | null = null
  let frame: number | null = null

  const evaluate = (): void => {
    frame = null
    /* 已处置：帧回调可能已经出队，这里必须拦住，否则会重领一个无人释放的 blocker。 */
    if (disposed) return
    const present = deps.hasOverlay()
    if (present && !release) {
      release = deps.acquire()
    } else if (!present && release) {
      const releaseNow = release
      release = null
      releaseNow()
    }
  }

  const schedule = (): void => {
    if (disposed || frame !== null) return
    frame = requestFrame(evaluate)
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (frame !== null) {
      cancelFrame(frame)
      frame = null
    }
    const releaseNow = release
    release = null
    releaseNow?.()
  }

  return {
    schedule,
    evaluate,
    dispose,
    holding: () => release !== null
  }
}
