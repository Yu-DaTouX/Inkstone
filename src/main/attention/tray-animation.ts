/**
 * 托盘柔和闪动播放器（v3 L12）。
 *
 * 只做一件事：把「当前应用外状态」映射成托盘帧的展示，并驱动一个定时器在
 * 预加载好的内存帧之间切换。它**不**自己判断任务状态（那由 `summary.ts` 的
 * 运行快照投影负责），也不读盘、不创建 NativeImage、不碰托盘菜单 —— 那些都在
 * 宿主接线里，且只在启动 / 主题变化时发生一次。
 *
 * 关键约束：
 *   · **单链 timer**：全应用最多一个待触发的定时器；任何状态切换先清旧 timer。
 *   · **绝对时间定位**：按真实帧时长累加定位当前帧，卡顿/休眠后直接跳到正确帧，
 *     不逐帧补发，避免「补帧突发」。
 *   · **立即停**：idle、减少动态、销毁时清 timer 并显示静态亮帧，不停在暗帧。
 *   · **缺素材安全回退**：帧集缺失或形状不对时退回静态图；再缺就不改图，由宿主
 *     保留启动时的静态精修标志，绝不冒名使用旧图或崩溃。
 *
 * 纯逻辑 + 注入端口，因此可以用虚拟时钟在 node 里回归（见
 * scripts/test-v3-tray-animation.mjs）。
 */
import type { TrayAnimationState, TrayFrameSet, TrayTheme } from './tray-assets'

export type { TrayAnimationState, TrayFrameSet, TrayTheme } from './tray-assets'

export interface TrayAnimationClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface TrayAnimationPorts {
  /** 同步取当前主题 + 状态**预载好的**帧集；纯内存，允许返回 undefined。 */
  assets(state: TrayAnimationState, theme: TrayTheme): TrayFrameSet | undefined
  /** 当前系统任务栏深浅。 */
  theme(): TrayTheme
  /** 应用一张图到托盘。 */
  apply(image: unknown): void
  clock?: TrayAnimationClock
  /** 播放器内部异常（只用于诊断，不影响运行）。 */
  onError?(error: unknown): void
}

export interface TrayAnimationPlayer {
  /** 状态变化：待用户操作 > 运行 > 空闲。 */
  setState(state: TrayAnimationState): void
  /** 减少动态效果 / 用户关闭动画。 */
  setMotionAllowed(allowed: boolean): void
  /** 主题变化：停止当前播放、用新主题的帧重取并立即应用。 */
  refresh(): void
  state(): TrayAnimationState
  /** 当前展示的帧下标（静态为 0）。 */
  frameIndex(): number
  animating(): boolean
  dispose(): void
}

const REAL_CLOCK: TrayAnimationClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** 帧集形状校验：至少一帧、每帧有正值时长。 */
function usable(set: TrayFrameSet | undefined): set is TrayFrameSet {
  if (!set || !Array.isArray(set.frames) || set.frames.length === 0) return false
  return set.frames.every((frame) => frame && typeof frame.durationMs === 'number' && frame.durationMs > 0)
}

export function createTrayAnimationPlayer(ports: TrayAnimationPorts): TrayAnimationPlayer {
  const clock = ports.clock ?? REAL_CLOCK
  let state: TrayAnimationState = 'idle'
  let motionAllowed = false
  let disposed = false
  let timer: unknown = null
  let frames: TrayFrameSet['frames'] | null = null
  let staticImage: unknown = undefined
  let index = 0
  let startAt = 0
  let period = 0
  /** 上次真正 apply 的帧下标；避免同一帧重复 setImage（nativeImage 比较开销）。 */
  let applied = -1

  const report = (error: unknown): void => {
    try {
      ports.onError?.(error)
    } catch {
      /* 诊断端口自身出错也不影响播放。 */
    }
  }

  const clearTimer = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer)
      timer = null
    }
  }

  const resolve = (): TrayFrameSet | undefined => {
    try {
      const direct = ports.assets(state, ports.theme())
      if (usable(direct)) return direct
      if (state !== 'idle') {
        const idle = ports.assets('idle', ports.theme())
        if (usable(idle)) return idle
      }
      return undefined
    } catch (error) {
      report(error)
      return undefined
    }
  }

  const applyImage = (image: unknown): void => {
    if (image === undefined || image === null) return
    try {
      ports.apply(image)
    } catch (error) {
      report(error)
    }
  }

  /** 显示当前状态的静态亮帧（中止就停在这里）。 */
  const showStatic = (): void => {
    clearTimer()
    applied = -1
    index = 0
    const set = resolve()
    frames = set ? set.frames : null
    staticImage = set ? (set.static ?? set.frames[0]?.image) : undefined
    applyImage(staticImage)
  }

  const schedule = (): void => {
    if (disposed || !frames || frames.length < 2) return
    clearTimer()
    const elapsed = clock.now() - startAt
    const pos = period > 0 ? ((elapsed % period) + period) % period : 0
    let acc = 0
    let next = frames.length - 1
    for (let i = 0; i < frames.length; i += 1) {
      if (pos < acc + frames[i].durationMs) {
        next = i
        break
      }
      acc += frames[i].durationMs
    }
    if (next !== applied) {
      index = next
      applied = next
      applyImage(frames[next].image)
    }
    const wait = Math.max(1, acc + frames[next].durationMs - pos)
    timer = clock.setTimeout(() => {
      timer = null
      schedule()
    }, wait)
  }

  const startAnimation = (): void => {
    clearTimer()
    applied = -1
    const set = resolve()
    if (!usable(set) || set.frames.length < 2) {
      showStatic()
      return
    }
    frames = set.frames
    staticImage = set.static ?? set.frames[0]?.image
    period = set.frames.reduce((acc, frame) => acc + frame.durationMs, 0)
    startAt = clock.now()
    index = 0
    applied = 0
    applyImage(set.frames[0].image)
    schedule()
  }

  const restart = (): void => {
    if (disposed) return
    if (!motionAllowed || state === 'idle') showStatic()
    else startAnimation()
  }

  return {
    setState(next) {
      if (disposed || next === state) return
      state = next
      restart()
    },
    setMotionAllowed(allowed) {
      if (disposed || allowed === motionAllowed) return
      motionAllowed = allowed
      restart()
    },
    refresh() {
      restart()
    },
    state: () => state,
    frameIndex: () => index,
    animating: () => timer !== null,
    dispose() {
      disposed = true
      clearTimer()
      frames = null
      staticImage = undefined
    }
  }
}
