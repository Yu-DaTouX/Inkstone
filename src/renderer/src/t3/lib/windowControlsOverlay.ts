import { useSyncExternalStore } from 'react'

interface WindowControlsOverlayLike {
  readonly visible: boolean
  getTitlebarAreaRect(): DOMRect
  addEventListener(type: 'geometrychange', listener: EventListener): void
  removeEventListener(type: 'geometrychange', listener: EventListener): void
}

type NavigatorWithOverlay = Navigator & { windowControlsOverlay?: WindowControlsOverlayLike }

function getOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as NavigatorWithOverlay).windowControlsOverlay ?? null
}

function subscribe(listener: () => void): () => void {
  const overlay = getOverlay()
  overlay?.addEventListener('geometrychange', listener)
  return () => overlay?.removeEventListener('geometrychange', listener)
}

function getTitlebarHeight(): number {
  const overlay = getOverlay()
  return overlay?.visible ? overlay.getTitlebarAreaRect().bottom : 0
}

export function useNativeTitlebarHeight(): number {
  return useSyncExternalStore(subscribe, getTitlebarHeight, () => 0)
}
