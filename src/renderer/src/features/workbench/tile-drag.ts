import { passedThreshold, useSessionDrag } from '../sidebar/session-drag'

export interface TileDragItem {
  id: string
  title: string
}

export interface TileDragStart {
  button: number
  clientX: number
  clientY: number
}

export function trackTileDrag(start: TileDragStart, item: TileDragItem, onDrop: (at: number) => void): void {
  if (start.button !== 0) return
  const sx = start.clientX
  const sy = start.clientY
  let active = false

  const move = (ev: PointerEvent): void => {
    if (!active) {
      if (!passedThreshold(ev.clientX - sx, ev.clientY - sy)) return
      active = true
      useSessionDrag.getState().begin({ id: item.id, path: `tile:${item.id}`, title: item.title }, ev.clientX, ev.clientY)
      document.body.dataset.v3Dragging = '1'
      return
    }
    useSessionDrag.getState().move(ev.clientX, ev.clientY)
  }
  const finish = (commit: boolean): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', cancel)
    if (!active) return
    const state = useSessionDrag.getState()
    const zone = state.hit >= 0 ? state.zones[state.hit] : null
    state.end()
    delete document.body.dataset.v3Dragging
    if (commit && zone) onDrop(zone.at)
  }
  const up = (): void => finish(true)
  const cancel = (): void => finish(false)
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || !active) return
    ev.preventDefault()
    ev.stopPropagation()
    finish(false)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', cancel)
}
