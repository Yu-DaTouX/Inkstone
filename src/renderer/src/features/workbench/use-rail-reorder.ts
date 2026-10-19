import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { moveRailSection, type RailSectionId } from './rail-sections'
import type { RailGrip } from './RailCard'
import type { RailText } from './rail-text'

const DRAG_THRESHOLD_PX = 4

export interface RailReorder {
  dragging: RailSectionId | null
  announcement: string
  gripFor: (id: RailSectionId) => RailGrip
}

export function useRailReorder(
  container: RefObject<HTMLElement | null>,
  visible: readonly RailSectionId[],
  order: readonly RailSectionId[],
  setOrder: (order: RailSectionId[]) => void,
  text: RailText
): RailReorder {
  const [dragging, setDragging] = useState<RailSectionId | null>(null)
  const [picked, setPicked] = useState<RailSectionId | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const orderRef = useRef(order)
  const visibleRef = useRef(visible)
  const originRef = useRef<RailSectionId[] | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  orderRef.current = order
  visibleRef.current = visible

  useEffect(() => () => cleanupRef.current?.(), [])

  const nameOf = useCallback((id: RailSectionId) => text.sections[id], [text])
  const positionOf = (id: RailSectionId): number => visibleRef.current.indexOf(id) + 1

  const startPointer = useCallback(
    (id: RailSectionId, event: PointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return
      const host = container.current
      if (!host) return
      const startY = event.clientY
      const origin = [...orderRef.current]
      let active = false
      const move = (ev: globalThis.PointerEvent): void => {
        if (!active) {
          if (Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) return
          active = true
          setDragging(id)
        }
        const cards = [...host.querySelectorAll<HTMLElement>('[data-rail-section]')]
        let target: RailSectionId | null = null
        let place: 'before' | 'after' = 'before'
        for (const card of cards) {
          const rect = card.getBoundingClientRect()
          if (ev.clientY < rect.top || ev.clientY > rect.bottom) continue
          target = card.dataset.railSection as RailSectionId
          place = ev.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
          break
        }
        if (!target || target === id) return
        const next = moveRailSection(orderRef.current, id, target, place)
        if (next.every((item, index) => orderRef.current[index] === item)) return
        orderRef.current = next
        setOrder(next)
      }
      const finish = (commit: boolean): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('keydown', key, true)
        window.removeEventListener('blur', cancel)
        cleanupRef.current = null
        if (!active) return
        setDragging(null)
        if (!commit) {
          orderRef.current = origin
          setOrder(origin)
          setAnnouncement(text.cancelled(nameOf(id)))
          return
        }
        setAnnouncement(text.dropped(nameOf(id), positionOf(id), visibleRef.current.length))
      }
      const up = (): void => finish(true)
      const cancel = (): void => finish(false)
      const key = (ev: globalThis.KeyboardEvent): void => {
        if (ev.key !== 'Escape' || !active) return
        ev.preventDefault()
        ev.stopPropagation()
        finish(false)
      }
      cleanupRef.current?.()
      cleanupRef.current = () => finish(false)
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
      window.addEventListener('keydown', key, true)
      window.addEventListener('blur', cancel)
    },
    [container, nameOf, setOrder, text]
  )

  const gripFor = (id: RailSectionId): RailGrip => ({
    label: text.reorder(nameOf(id)),
    picked: picked === id,
    onPointerDown: (event) => startPointer(id, event),
    onPress: () => {
      if (picked === id) {
        setPicked(null)
        originRef.current = null
        setAnnouncement(text.dropped(nameOf(id), positionOf(id), visibleRef.current.length))
        return
      }
      originRef.current = [...orderRef.current]
      setPicked(id)
      setAnnouncement(text.pickedUp(nameOf(id), positionOf(id), visibleRef.current.length))
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (picked !== id) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (originRef.current) setOrder(originRef.current)
        originRef.current = null
        setPicked(null)
        setAnnouncement(text.cancelled(nameOf(id)))
        return
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const list = visibleRef.current
      const at = list.indexOf(id)
      const neighbor = list[event.key === 'ArrowUp' ? at - 1 : at + 1]
      if (!neighbor) return
      const next = moveRailSection(orderRef.current, id, neighbor, event.key === 'ArrowUp' ? 'before' : 'after')
      orderRef.current = next
      setOrder(next)
      setAnnouncement(text.movedTo(nameOf(id), event.key === 'ArrowUp' ? at : at + 2, list.length))
    },
    onBlur: () => {
      if (picked !== id) return
      setPicked(null)
      originRef.current = null
    }
  })

  return { dragging, announcement, gripFor }
}
