import { useCallback, useLayoutEffect, useState } from 'react'
import { resolveRestingComposerControlsLayout } from '../../t3/components/chat/composerFooterLayout'
import { measureRestingComposerControls } from '../../t3/components/chat/restingComposerControlsMeasurement'

export interface ComposerControlsLayout {
  attachHost: (node: HTMLElement | null) => void
  hiddenBlockCount: number
  iconOnlyBlockCount: number
  visible: boolean
}

const INITIAL_LAYOUT = { hiddenCount: 0, iconOnlyCount: 0, visible: true }

const CONTROLS_HOST_SELECTOR = '[data-chat-composer-controls="footer"]'
const MEASURED_NODE_SELECTOR =
  '[data-resting-block], [data-composer-control-label], [data-chat-provider-model-picker-label]'

export function useComposerControlsLayout(): ComposerControlsLayout {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [layout, setLayout] = useState(INITIAL_LAYOUT)

  const attachHost = useCallback((node: HTMLElement | null) => {
    setHost(node ? node.closest<HTMLElement>(CONTROLS_HOST_SELECTOR) : null)
  }, [])

  useLayoutEffect(() => {
    if (!host) return
    const measure = () => {
      const measurement = measureRestingComposerControls(host)
      if (!measurement) return
      const style = getComputedStyle(host)
      const hostWidth =
        host.clientWidth -
        (Number.parseFloat(style.paddingInlineStart) || 0) -
        (Number.parseFloat(style.paddingInlineEnd) || 0)
      setLayout((current) => {
        const next = resolveRestingComposerControlsLayout({
          ...measurement,
          hostWidth,
          previous: current
        })
        const iconOnlyCount = next.iconOnlyCount ?? 0
        if (
          next.hiddenCount === current.hiddenCount &&
          iconOnlyCount === current.iconOnlyCount &&
          next.visible === current.visible
        ) {
          return current
        }
        return { hiddenCount: next.hiddenCount, iconOnlyCount, visible: next.visible }
      })
    }

    const observer = new ResizeObserver(measure)
    const observeTargets = () => {
      observer.observe(host)
      for (const node of host.querySelectorAll<HTMLElement>(MEASURED_NODE_SELECTOR)) {
        observer.observe(node)
      }
    }
    observeTargets()
    measure()

    const mutations = new MutationObserver(() => {
      observeTargets()
      measure()
    })
    mutations.observe(host, { childList: true, subtree: true, characterData: true })
    document.fonts.addEventListener('loadingdone', measure)

    return () => {
      observer.disconnect()
      mutations.disconnect()
      document.fonts.removeEventListener('loadingdone', measure)
    }
  }, [host])

  return {
    attachHost,
    hiddenBlockCount: layout.hiddenCount,
    iconOnlyBlockCount: layout.iconOnlyCount,
    visible: layout.visible
  }
}
