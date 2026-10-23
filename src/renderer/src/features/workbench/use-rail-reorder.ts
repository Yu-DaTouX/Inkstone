import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { moveRailSection, type RailSectionId } from './rail-sections'
import type { RailGrip } from './RailCard'
import type { RailText } from './rail-text'

const DRAG_THRESHOLD_PX = 5
const EDGE_SCROLL_PX = 36
const EDGE_SCROLL_STEP = 10
const SETTLE_FALLBACK_MS = 320

export interface RailReorder {
  dragging: RailSectionId | null
  announcement: string
  gripFor: (id: RailSectionId) => RailGrip
}

interface Slot {
  id: RailSectionId
  el: HTMLElement
  top: number
  height: number
}

function measureSlots(host: HTMLElement): Slot[] {
  return [...host.querySelectorAll<HTMLElement>('[data-rail-section]')].map((el) => {
    const rect = el.getBoundingClientRect()
    return { id: el.dataset.railSection as RailSectionId, el, top: rect.top, height: rect.height }
  })
}

function targetIndex(slots: readonly Slot[], from: number, draggedCenter: number): number {
  let index = from
  for (let i = from + 1; i < slots.length; i++) {
    if (draggedCenter > slots[i].top + slots[i].height / 2) index = i
  }
  for (let i = from - 1; i >= 0; i--) {
    if (draggedCenter < slots[i].top + slots[i].height / 2) index = i
  }
  return index
}

function gapAround(slots: readonly Slot[], from: number): number {
  const self = slots[from]
  const next = slots[from + 1]
  if (next) return Math.max(0, next.top - (self.top + self.height))
  const prev = slots[from - 1]
  return prev ? Math.max(0, self.top - (prev.top + prev.height)) : 0
}

function shiftOf(slots: readonly Slot[], from: number, to: number, i: number): number {
  const step = slots[from].height + gapAround(slots, from)
  if (to > from && i > from && i <= to) return -step
  if (to < from && i >= to && i < from) return step
  return 0
}

function landingOffset(slots: readonly Slot[], from: number, to: number): number {
  if (to > from) return slots[to].top + slots[to].height - (slots[from].top + slots[from].height)
  if (to < from) return slots[to].top - slots[from].top
  return 0
}

function settle(el: HTMLElement, done: () => void): void {
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    el.removeEventListener('transitionend', onEnd)
    window.clearTimeout(timer)
    done()
  }
  const onEnd = (event: TransitionEvent): void => {
    if (event.target === el && event.propertyName === 'transform') finish()
  }
  const timer = window.setTimeout(finish, SETTLE_FALLBACK_MS)
  el.addEventListener('transitionend', onEnd)
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
  const suppressPressRef = useRef(false)
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
      let pointerY = startY
      let startScroll = host.scrollTop
      let slots: Slot[] = []
      let from = -1
      let to = -1
      let active = false
      let settling = false
      let frame = 0
      const body = document.body
      const restoreCursor = body.style.cursor
      const restoreSelect = body.style.userSelect

      const layout = (): void => {
        const dy = pointerY - startY + host.scrollTop - startScroll
        const dragged = slots[from]
        dragged.el.style.transform = `translate3d(0, ${dy}px, 0)`
        const next = targetIndex(slots, from, dragged.top + dragged.height / 2 + dy)
        if (next === to) return
        to = next
        slots.forEach((slot, i) => {
          if (i === from) return
          const shift = shiftOf(slots, from, to, i)
          slot.el.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : ''
        })
      }

      const edgeScroll = (): void => {
        frame = 0
        if (!active || settling) return
        const rect = host.getBoundingClientRect()
        let step = 0
        if (pointerY < rect.top + EDGE_SCROLL_PX) step = -EDGE_SCROLL_STEP
        else if (pointerY > rect.bottom - EDGE_SCROLL_PX) step = EDGE_SCROLL_STEP
        if (!step) return
        const before = host.scrollTop
        host.scrollTop = before + step
        if (host.scrollTop === before) return
        layout()
        frame = window.requestAnimationFrame(edgeScroll)
      }

      const activate = (): boolean => {
        slots = measureSlots(host)
        from = slots.findIndex((slot) => slot.id === id)
        if (from < 0) return false
        to = from
        startScroll = host.scrollTop
        active = true
        suppressPressRef.current = true
        host.dataset.sorting = '1'
        body.style.cursor = 'grabbing'
        body.style.userSelect = 'none'
        setDragging(id)
        return true
      }

      const move = (ev: globalThis.PointerEvent): void => {
        if (settling) return
        pointerY = ev.clientY
        if (!active) {
          if (Math.abs(pointerY - startY) < DRAG_THRESHOLD_PX) return
          if (!activate()) return
        }
        layout()
        if (!frame) frame = window.requestAnimationFrame(edgeScroll)
      }

      const detach = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
        window.removeEventListener('keydown', key, true)
        window.removeEventListener('blur', cancel)
        if (frame) window.cancelAnimationFrame(frame)
        frame = 0
      }

      const reset = (next: RailSectionId[] | null): void => {
        flushSync(() => {
          if (next) {
            orderRef.current = next
            setOrder(next)
          }
          setDragging(null)
        })
        delete host.dataset.sorting
        for (const slot of slots) slot.el.style.transform = ''
        body.style.cursor = restoreCursor
        body.style.userSelect = restoreSelect
        window.setTimeout(() => {
          suppressPressRef.current = false
        }, 0)
      }

      const finish = (commit: boolean): void => {
        detach()
        cleanupRef.current = null
        if (!active) return
        settling = true
        const dragged = slots[from]
        const landed = commit ? to : from
        if (!commit) {
          for (const slot of slots) if (slot !== dragged) slot.el.style.transform = ''
        }
        const offset = landingOffset(slots, from, landed)
        dragged.el.dataset.settling = '1'
        dragged.el.style.transform = offset ? `translate3d(0, ${offset}px, 0)` : ''
        settle(dragged.el, () => {
          delete dragged.el.dataset.settling
          let next: RailSectionId[] | null = null
          if (landed !== from) {
            const target = slots[landed].id
            next = moveRailSection(orderRef.current, id, target, landed > from ? 'after' : 'before')
          }
          reset(next)
          setAnnouncement(commit ? text.dropped(nameOf(id), positionOf(id), visibleRef.current.length) : text.cancelled(nameOf(id)))
        })
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
      cleanupRef.current = () => {
        detach()
        if (active && !settling) reset(null)
      }
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
      if (suppressPressRef.current) {
        suppressPressRef.current = false
        return
      }
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
