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

export function composerMenuClosed(): void {
  const handle = composerEditorHandle
  if (!handle) return
  const activeElement = document.activeElement
  if (activeElement !== document.body && !isInsideComposerFloatingLayer(activeElement)) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => handle.current?.focusAtEnd())
  })
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
