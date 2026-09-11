import { useEffect, useRef, useState } from 'react'

/**
 * 让浮层**有退场动画**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这个 hook
 * ══════════════════════════════════════════════════════════════════
 * React 在 `open` 变 false 的那一刻就**立刻卸载** DOM 节点，
 * 所以纯 CSS 的 `animation` 只能演出场（入场）—— 退场根本没机会跑。
 * 表现就是：打开时是「淡入放大」，关闭时是「啪一下消失」，
 * 两边不对称，感觉像卡了一下。
 *
 * 这个 hook 做的就是「延迟卸载」：
 *   open=true            → mounted=true, closing=false（演入场）
 *   open 变 false        → closing=true（演退场），等 ms 后再 mounted=false
 *   ms 内又 open=true    → 取消卸载（中断退场，重新演入场）
 *
 * 为什么用 `closing` 类名而不是直接依赖 CSS 的 `animationend`：
 *   动画可能因为 `prefers-reduced-motion` 被禁掉（那时不会触发 animationend）、
 *   也可能因为节点刚挂上就被换掉而漏掉事件 —— 那就会永久卡在 closing 态。
 *   用定时器是「一定会发生」的，而且时长与 CSS 里的值同源（都由调用方传）。
 */
export function usePresence(open: boolean, ms: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }

    if (open) {
      // 打开（或中断退场）：立刻挂上，清掉 closing
      setMounted(true)
      setClosing(false)
      return
    }

    // 关闭：如果本来就没挂，什么都不用做
    setMounted((was) => {
      if (!was) return was
      setClosing(true)
      timer.current = setTimeout(() => {
        timer.current = null
        setClosing(false)
        setMounted(false)
      }, ms)
      return was
    })
  }, [open, ms])

  // 卸载时清掉定时器
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  return { mounted, closing }
}

/**
 * 系统是否要求减少动效。
 *
 * 用途：动画时长在 JS 侧也要知道（`usePresence` 的延迟卸载），
 * 否则「CSS 动画被禁 + JS 还等 180ms」会出现一段空白期。
 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  } catch {
    return false
  }
}
