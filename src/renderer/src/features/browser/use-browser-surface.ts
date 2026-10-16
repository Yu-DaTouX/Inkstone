/**
 * 浏览器面板的边界 hook：坐标跟随、overlay 遮挡、显隐归还。
 *
 * 一律通过既有协调入口办事：
 *   · 坐标 → `window.yan.browser.setBounds`（去重在 `BrowserBoundsSync`）；
 *   · 显隐 → store 的 `setBrowserSurfaceActive` → `shouldShowBrowser` → `setVisible`；
 *   · 遮挡 → store 的 `acquireOverlayBlocker`。
 * hook 自己绝不直接 `setVisible`，避免和协调器抢同一个原生层。
 */
import { useEffect, useState, type RefObject } from 'react'
import { useStore } from '../../state/store'
import { BrowserBoundsSync } from './bounds'
import { BrowserSurfaceClaim } from './ownership'
import { rectOf, findClipElement } from './layout'
import { hasBlockingOverlay } from './overlay'
import { createOverlayBlockerLifecycle } from './overlay-lifecycle'

/** overlay blocker token（同一时刻只领一个）。 */
const OVERLAY_TOKEN = 'browser-overlay'

/**
 * 当前真正把原生浏览器标成 active 的那把 owner key 的认领令牌。
 *
 * 为什么需要它：store 的 `setBrowserSurfaceActive` 是个裸布尔值。分屏时每列都
 * 挂着一个 BrowserPane，没有 `active` 的那一列在挂载时会调 `false`，把有
 * `active` 那一列刚设的 `true` 盖掉 —— 原生网页就不出来了。这里只让**真正
 * 认领过的那把 key** 清掉自己的标记，与 `OverlayBlockers` 的 token 思路一致。
 */
const surfaceClaim = new BrowserSurfaceClaim()

/**
 * 把「本面板是否是当前原生浏览器表面」交给既有协调器；只有认领过的那把 key
 * 负责清除，避免分屏多列互相覆盖。
 */
export function useBrowserSurfaceActive(active: boolean, ownerKey: string): void {
  useEffect(() => {
    if (!active) return
    if (surfaceClaim.claim(ownerKey)) useStore.getState().setBrowserSurfaceActive(true)
    return () => {
      if (surfaceClaim.release(ownerKey)) useStore.getState().setBrowserSurfaceActive(false)
    }
  }, [active, ownerKey])
}

/**
 * 逐帧测量占位区并把坐标发给主进程，返回占位区当前是否真的在裁剪区内。
 *
 * 为什么是常驻 rAF 而不是只在 ResizeObserver 上：列宽过渡、窗口滚动都只改
 * 坐标不改尺寸；逐帧比对签名才能让原生视图跟着走。`active=false` 时整个循环
 * 不启动，也就不会去动别的会话的浏览器。
 *
 * `reset` 后接到 `void` 的 setBounds Promise 不会被 await —— setBounds 不影响
 * 显隐，晚到的坐标不会把旧视图「重新显示」出来；显隐只由 store 协调器决定。
 */
export function useBrowserBoundsSync(
  active: boolean,
  viewportRef: RefObject<HTMLElement | null>
): boolean {
  const [inView, setInView] = useState(true)

  useEffect(() => {
    if (!active) {
      setInView(true)
      return
    }
    const el = viewportRef.current
    if (!el) return

    const sync = new BrowserBoundsSync({
      setBounds: (bounds) => {
        void window.yan.browser.setBounds(bounds).catch(() => {
          /* 坐标发送失败不影响面板本身 */
        })
      }
    })
    /* 裁剪容器找一次即可；每帧只量它的位置。 */
    const clip = findClipElement(el)
    let frame = 0
    let disposed = false

    const tick = (): void => {
      if (disposed) return
      const bounds = sync.sync(rectOf(el), clip ? rectOf(clip) : null)
      const visible = bounds ? bounds.width > 0 && bounds.height > 0 : false
      setInView((prev) => (prev === visible ? prev : visible))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      sync.reset()
    }
  }, [active, viewportRef])

  return inView
}

/**
 * 有浮层（Ctrl+K、设置、菜单、下拉）时领取 overlay blocker，关闭后释放。
 *
 * 用 MutationObserver 观察真实 DOM：v3 的浮层由不同组件挂载，逐个去改它们的
 * 领取逻辑会散成多处；这里只做「界面上有浮层吗」这一件事，藏/归还仍由既有
 * 协调器统一做。回调不移动焦点，满足「不偷焦点」。
 *
 * 调度/评估/处置委托给 `overlay-lifecycle`：卸载时取消挂起帧并置 disposed，
 * 已经排队的回调即使仍被执行也不会重领 blocker，避免把之后的原生浏览器挡住。
 */
export function useBrowserOverlayBlocker(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    const lifecycle = createOverlayBlockerLifecycle({
      hasOverlay: () => hasBlockingOverlay((selector) => document.querySelector(selector) !== null),
      acquire: () => useStore.getState().acquireOverlayBlocker(OVERLAY_TOKEN)
    })

    const observer = new MutationObserver(() => lifecycle.schedule())
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-open', 'data-entering', 'data-exiting', 'role', 'aria-modal', 'hidden']
    })
    lifecycle.evaluate()

    return () => {
      observer.disconnect()
      lifecycle.dispose()
    }
  }, [enabled])
}
