import { useEffect, useState, type RefObject } from 'react'
import { useStore } from '../../state/store'
import { BrowserBoundsSync } from './bounds'
import { BrowserSurfaceClaim } from './ownership'
import { rectOf, findClipElement } from './layout'
import { BLOCKING_OVERLAY_SELECTOR, hasBlockingOverlay } from './overlay'
import { createOverlayBlockerLifecycle } from './overlay-lifecycle'

const OVERLAY_TOKEN = 'browser-overlay'

const surfaceClaim = new BrowserSurfaceClaim()

export function useBrowserSurfaceActive(active: boolean, ownerKey: string): void {
  useEffect(() => {
    if (!active) return
    if (surfaceClaim.claim(ownerKey)) useStore.getState().setBrowserSurfaceActive(true)
    return () => {
      if (surfaceClaim.release(ownerKey)) useStore.getState().setBrowserSurfaceActive(false)
    }
  }, [active, ownerKey])
}

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
        })
      }
    })
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

export function useBrowserOverlayBlocker(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    const lifecycle = createOverlayBlockerLifecycle({
      hasOverlay: () => hasBlockingOverlay((selector) => document.querySelector(selector) !== null),
      acquire: () => useStore.getState().acquireOverlayBlocker(OVERLAY_TOKEN)
    })

    const isRelevantNode = (node: Node): boolean =>
      node instanceof Element &&
      (node.matches(BLOCKING_OVERLAY_SELECTOR) || node.querySelector(BLOCKING_OVERLAY_SELECTOR) !== null)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          lifecycle.schedule()
          return
        }
        for (const node of mutation.addedNodes) {
          if (isRelevantNode(node)) {
            lifecycle.schedule()
            return
          }
        }
        for (const node of mutation.removedNodes) {
          if (isRelevantNode(node)) {
            lifecycle.schedule()
            return
          }
        }
      }
    })
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
