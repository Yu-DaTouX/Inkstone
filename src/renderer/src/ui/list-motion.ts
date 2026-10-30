import { prefersReducedMotion } from '../lib/reduced-motion'
import { motionHeld, motionMs } from './motion-hooks'
import { flipOffset, listChurn, listMotionAllowed, remainingShare, ridingDelta, rowTravel } from './motion-model'

interface RowBox {
  top: number
  left: number
  width: number
  height: number
}

const STRIPPED_ATTRIBUTES = new Set(['data-testid', 'data-panel-tab', 'aria-current', 'aria-selected'])

function progressOf(animation: Animation): number {
  if (animation.playState === 'finished') return 1
  return Number(animation.effect?.getComputedTiming().progress ?? 0)
}

function easing(parent: HTMLElement): string {
  const view = parent.ownerDocument.defaultView
  const value = view ? view.getComputedStyle(parent).getPropertyValue('--ease').trim() : ''
  return value || 'ease-out'
}

export interface ListMotion {
  update: (animate: boolean) => void
  suspend: () => void
  dispose: () => void
}

export function createListMotion(parent: HTMLElement): ListMotion {
  let positions: Map<HTMLElement, RowBox> | null = null
  let disposed = false
  const running = new Map<HTMLElement, { animation: Animation; offset: number }>()
  const entering = new Map<HTMLElement, { animation: Animation; travel: number }>()
  const exiting = new Map<HTMLElement, Animation>()
  const timing = (): KeyframeAnimationOptions => ({ duration: motionMs('quick'), easing: easing(parent) })

  const remaining = (node: HTMLElement): number => {
    const run = running.get(node)
    const entry = entering.get(node)
    return (run ? remainingShare(run.offset, progressOf(run.animation)) : 0) + (entry ? remainingShare(entry.travel, progressOf(entry.animation)) : 0)
  }

  const clearFades = (): void => {
    for (const entry of entering.values()) entry.animation.cancel()
    for (const animation of exiting.values()) animation.cancel()
    for (const node of exiting.keys()) node.remove()
    entering.clear()
    exiting.clear()
  }

  const fadeOut = (node: HTMLElement, box: RowBox, travel: number): void => {
    if (box.height === 0 || typeof node.animate !== 'function') return
    const clone = node.cloneNode(true) as HTMLElement
    for (const element of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
      for (const attribute of Array.from(element.attributes)) {
        if ((attribute.name === 'id' && element.namespaceURI !== 'http://www.w3.org/2000/svg') || STRIPPED_ATTRIBUTES.has(attribute.name)) element.removeAttribute(attribute.name)
      }
    }
    clone.setAttribute('aria-hidden', 'true')
    clone.setAttribute('data-motion-ghost', '')
    clone.inert = true
    Object.assign(clone.style, {
      position: 'absolute',
      top: `${box.top + remaining(node)}px`,
      left: `${box.left}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      margin: '0',
      boxSizing: 'border-box',
      transform: 'none',
      transition: 'none',
      pointerEvents: 'none'
    })
    parent.append(clone)
    const entry = entering.get(node)
    const from = entry ? progressOf(entry.animation) : 1
    const animation = clone.animate(
      [
        { opacity: from, transform: 'translateY(0px)' },
        { opacity: 0, transform: `translateY(${travel}px)` }
      ],
      timing()
    )
    exiting.set(clone, animation)
    animation.addEventListener(
      'finish',
      () => {
        clone.remove()
        exiting.delete(clone)
      },
      { once: true }
    )
  }

  const cancel = (node: HTMLElement): void => {
    running.get(node)?.animation.cancel()
    running.delete(node)
  }

  const suspend = (): void => {
    for (const node of [...running.keys()]) cancel(node)
    clearFades()
    positions = null
  }

  const move = (node: HTMLElement, offset: number): void => {
    cancel(node)
    const entry = entering.get(node)
    if (entry) entry.travel = 0
    if (offset === 0 && !entry) return
    if (typeof node.animate !== 'function') return
    const animation = node.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0px)' }], timing())
    running.set(node, { animation, offset })
    animation.addEventListener(
      'finish',
      () => {
        if (running.get(node)?.animation === animation) running.delete(node)
      },
      { once: true }
    )
  }

  return {
    update(animate) {
      if (disposed) return
      const next = new Map<HTMLElement, RowBox>()
      for (const node of Array.from(parent.children)) {
        if (!(node instanceof HTMLElement) || exiting.has(node)) continue
        next.set(node, { top: node.offsetTop, left: node.offsetLeft, width: node.offsetWidth, height: node.offsetHeight })
      }
      const previous = positions
      const allowed = listMotionAllowed({
        animate,
        measured: previous !== null,
        reduced: prefersReducedMotion(),
        held: motionHeld(),
        churn: previous ? listChurn(previous, next) : 0
      })
      const moved = new Map<HTMLElement, number>()
      const nextOrder = [...next.keys()]
      const oldOrder = previous ? [...previous.keys()] : []
      if (!allowed || !previous) clearFades()
      else {
        for (const [node, box] of next) {
          const before = previous.get(node)?.top
          if (before === undefined || before === box.top) continue
          moved.set(node, flipOffset(before, remaining(node), box.top))
        }
        for (const [node, box] of previous) {
          if (next.has(node)) continue
          const delta = ridingDelta(oldOrder, oldOrder.indexOf(node), moved, (key) => (next.has(key) ? remaining(key) : undefined))
          fadeOut(node, box, delta === undefined ? rowTravel(box.height) : -delta)
        }
      }
      for (const [node, entry] of entering) {
        if (next.has(node)) continue
        entry.animation.cancel()
        entering.delete(node)
      }
      for (const node of [...running.keys()]) {
        if (!allowed || !next.has(node)) cancel(node)
      }
      if (allowed && previous) {
        nextOrder.forEach((node, index) => {
          const box = next.get(node)
          if (!box) return
          if (!previous.has(node)) {
            if (box.height <= 0 || typeof node.animate !== 'function') return
            const delta = ridingDelta(nextOrder, index, moved, (key) => (previous.has(key) ? remaining(key) : undefined))
            const travel = delta === undefined ? -rowTravel(box.height) : delta
            const animation = node.animate(
              [
                { opacity: 0, transform: `translateY(${travel}px)` },
                { opacity: 1, transform: 'translateY(0px)' }
              ],
              timing()
            )
            entering.set(node, { animation, travel })
            animation.addEventListener(
              'finish',
              () => {
                if (entering.get(node)?.animation === animation) entering.delete(node)
              },
              { once: true }
            )
            return
          }
          const delta = moved.get(node)
          if (delta !== undefined) move(node, delta)
        })
      }
      positions = next
    },
    suspend,
    dispose() {
      suspend()
      disposed = true
    }
  }
}
