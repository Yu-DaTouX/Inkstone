const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]'
].join(',')

export const composerFloatingLayerProps = {
  'data-chat-composer-floating-layer': 'true'
} as const

type ComposerEditorHandle = {
  focusAtEnd: () => void
}

let composerEditorHandle: { current: ComposerEditorHandle | null } | null = null

export function setComposerEditorHandle(handle: { current: ComposerEditorHandle | null } | null) {
  composerEditorHandle = handle
}

export function useComposerMenuProps() {
  return {
    ...composerFloatingLayerProps,
    finalFocus: () => {
      const handle = composerEditorHandle
      if (!handle) return undefined
      const activeElement = document.activeElement
      if (activeElement !== document.body && !isInsideComposerFloatingLayer(activeElement)) return false
      handle.current?.focusAtEnd()
      return false
    }
  }
}

function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null
}

export function isInsideCollapsedComposerControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-chat-composer-collapsed-controls="true"]') !== null
  )
}

export function isInsideRestingComposerControlScope(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[data-chat-composer-resting-controls="true"]') !== null ||
      target.closest('[data-chat-composer-resting-images="true"]') !== null ||
      target.closest('[data-composer-context-control]') !== null ||
      isInsideComposerFloatingLayer(target))
  )
}

export function markOpenToPermissions(trigger: HTMLElement): void {
  trigger.dataset.openToPermissions = 'true'
}

export function focusRequestedPermission(open: boolean, trigger: HTMLElement | null): void {
  if (!trigger?.dataset.openToPermissions) return
  delete trigger.dataset.openToPermissions
  if (!open) return
  const popupId = trigger.getAttribute('aria-controls')
  const popup = popupId ? document.getElementById(popupId) : null
  popup
    ?.querySelector<HTMLElement>("[data-composer-permissions] [aria-checked='true']")
    ?.focus({ preventScroll: true })
}
