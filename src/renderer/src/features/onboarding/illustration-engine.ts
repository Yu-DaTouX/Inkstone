export interface IllustrationState {
  readonly scene: number
  readonly light: boolean
  readonly soundOn: boolean
  readonly authed: boolean
  readonly limitIndex: number
}

export interface IllustrationEngine {
  update: (next: IllustrationState) => void
  dispose: () => void
}

export type ActorKind =
  | 'plain'
  | 'accent'
  | 'accent-soft'
  | 'shadow'
  | 'groove'
  | 'cable'
  | 'paper'
  | 'paper-picked'
  | 'night'
  | 'night-picked'
  | 'sun'
  | 'moon'
  | 'moon-bite'
  | 'ink-light'
  | 'ink-dark'

const PROPS = ['x', 'y', 'w', 'h', 'r', 'rot', 'o'] as const
type Prop = (typeof PROPS)[number]
type Box = Record<Prop, number>
interface Actor extends Box {
  readonly k: ActorKind
}
interface Offset {
  dx: number
  dy: number
  drot: number
  o: number
}

export const ACTOR_COUNT = 10
const STIFFNESS = 170
const DAMPING = 19
const SUBSTEPS = 2
const MAX_DT = 0.032
const STAGGER_MS = 32
const STAGGER_BASE_MS = 60
const IDLE_DELAY_MS = 700
const CONTEXT_CARD_WIDTHS = [132, 118, 126, 110, 122]

const actor = (x: number, y: number, w: number, h: number, r: number, k: ActorKind, o = 1, rot = 0): Actor => ({
  x,
  y,
  w,
  h,
  r,
  rot,
  o,
  k
})
const hidden = (x: number, y: number): Actor => ({ x, y, w: 0, h: 0, r: 0, rot: 0, o: 0, k: 'plain' })
const fill = (list: Actor[], x: number, y: number): Actor[] => {
  while (list.length < ACTOR_COUNT) list.push(hidden(x, y))
  return list
}

export function contextMarkerY(limitIndex: number): number {
  return 140 - limitIndex * 18
}

function contextCardCount(limitIndex: number): number {
  return Math.max(1, Math.min(5, Math.floor((164 - contextMarkerY(limitIndex)) / 22)))
}

interface SceneFlags {
  contextShown: number
  contextCompacted: boolean
  burst: 0 | 1 | 2
}

function sceneTargets(s: IllustrationState, f: SceneFlags): Actor[] {
  if (s.scene === 0) return fill([actor(120, 100, 136, 136, 30, 'plain')], 120, 100)
  if (s.scene === 1) {
    const l = s.light
    const lightLift = l ? -8 : 0
    const darkLift = l ? 0 : -8
    const lightGrow = l ? 6 : 0
    const darkGrow = l ? 0 : 6
    const lightO = l ? 1 : 0.75
    const darkO = l ? 0.75 : 1
    return [
      actor(120, 166, 176, 10, 5, 'shadow'),
      actor(78, 104 + lightLift, 76 + lightGrow, 108 + lightGrow, 12, l ? 'paper-picked' : 'paper', lightO),
      actor(162, 104 + darkLift, 76 + darkGrow, 108 + darkGrow, 12, l ? 'night' : 'night-picked', darkO),
      actor(78, 82 + lightLift, 22, 22, 11, 'sun', lightO),
      actor(78, 116 + lightLift, 46, 5, 2.5, 'ink-light', lightO),
      actor(72, 127 + lightLift, 34, 5, 2.5, 'ink-light', lightO),
      actor(162, 82 + darkLift, 22, 22, 11, 'moon', darkO),
      actor(169, 77 + darkLift, 18, 18, 9, 'moon-bite', darkO),
      actor(162, 116 + darkLift, 46, 5, 2.5, 'ink-dark', darkO),
      actor(156, 127 + darkLift, 34, 5, 2.5, 'ink-dark', darkO)
    ]
  }
  if (s.scene === 2) {
    return fill(
      [
        actor(120, 162, 44, 6, 3, 'shadow'),
        actor(120, 139, 11, 11, 5.5, 'accent'),
        actor(120, 98, 50, 64, 23, 'plain'),
        actor(120, 129, 66, 8, 4, 'plain'),
        actor(109, 98, 3.5, 22, 1.75, 'groove', 1, 10),
        actor(120, 62, 9, 9, 4.5, 'plain')
      ],
      120,
      98
    )
  }
  if (s.scene === 3) {
    const plug = s.authed ? 146 : 122
    return [
      hidden(120, 110),
      actor(56, 110, 60, 52, 10, 'plain'),
      actor(55, 113, 12, 3.5, 1.75, 'accent'),
      actor(184, 110, 52, 52, 26, s.authed ? 'accent-soft' : 'plain'),
      hidden(184, 110),
      actor(plug, 110, 16, 22, 4, 'plain'),
      hidden(120, 110),
      hidden(120, 110),
      actor((86 + plug - 8) / 2, 110, plug - 8 - 86, 2.5, 1.25, 'cable'),
      hidden(120, 110)
    ]
  }
  if (s.scene === 4) {
    const count = contextCardCount(s.limitIndex)
    const out: Actor[] = [actor(102, 172, 150, 8, 4, 'shadow')]
    CONTEXT_CARD_WIDTHS.forEach((w, k) => {
      const y = 154 - k * 22
      const x = 36 + w / 2
      if (k >= count) out.push(hidden(x, y))
      else if (f.contextCompacted) out.push(actor(102, 154, 132, 16, 5, 'plain', 0))
      else if (k < f.contextShown) out.push(actor(x, y, w, 16, 5, 'plain'))
      else out.push(actor(x, y - 16, w, 16, 5, 'plain', 0))
    })
    out.push(f.contextCompacted ? actor(102, 154, 132, 16, 5, 'accent-soft') : actor(102, 154, 96, 10, 5, 'accent-soft', 0))
    return fill(out, 102, 154)
  }
  const out: Actor[] = [hidden(120, 96), hidden(120, 96), hidden(120, 96), hidden(120, 96), actor(120, 96, 72, 72, 36, 'accent-soft')]
  for (let j = 0; j < 5; j++) {
    const a = ((-90 + j * 72 + 18) * Math.PI) / 180
    const radius = f.burst === 0 ? 0 : f.burst === 1 ? 50 : 64
    const size = f.burst === 2 ? 2 : 5
    out.push(actor(120 + radius * Math.cos(a), 96 + radius * Math.sin(a), size, size, size / 2, 'accent', f.burst === 1 ? 1 : 0))
  }
  return out
}

function rotateAbout(x: number, y: number, px: number, py: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = x - px
  const dy = y - py
  return [px + dx * c - dy * s - x, py + dx * s + dy * c - y]
}

function idleOffset(s: IllustrationState, i: number, t: number, x: number, y: number): Offset {
  const d: Offset = { dx: 0, dy: 0, drot: 0, o: 1 }
  if (s.scene === 1) {
    const floating = s.light ? [1, 3, 4, 5] : [2, 6, 7, 8, 9]
    if (floating.includes(i)) d.dy = -1.6 * Math.sin(t * 1.8)
  }
  if (s.scene === 2 && s.soundOn && i >= 1 && i <= 5) {
    const w = (t * 2 * Math.PI) / 1.5
    const deg = i === 1 ? 12 * Math.sin(w - 0.7) : 8 * Math.sin(w)
    const [ax, ay] = rotateAbout(x, y, 120, 60, deg)
    d.dx = ax
    d.dy = ay
    d.drot = deg
  }
  if (s.scene === 3 && !s.authed && i === 5) d.dx = 3 * (1 - Math.cos(t * 3.2))
  if (s.scene === 5 && i === 4) d.dy = -3 * Math.sin(t * 1.7)
  return d
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const DRAW_EASE = 'cubic-bezier(.165,.84,.44,1)'
const fixed = (n: number): string => n.toFixed(2)

export function startIllustration(svg: SVGSVGElement, box: HTMLElement, initial: IllustrationState): IllustrationEngine {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const layer = svg.querySelector<SVGGElement>('[data-actors]')
  const scenes = Array.from(svg.querySelectorAll<SVGGElement>('[data-scene]'))
  const anchors = scenes.map((el) =>
    Array.from(el.querySelectorAll<SVGGElement>('[data-anchor]')).map((g) => [g, Number(g.dataset.anchor)] as const)
  )
  const threshold = svg.querySelector<SVGElement>('[data-ctx-threshold]')
  const zip = svg.querySelector<SVGElement>('[data-ctx-zip]')
  const rects: SVGRectElement[] = []
  const pos: Box[] = []
  const vel: Box[] = []
  const target: Actor[] = []
  const pending: (Actor | null)[] = []
  const due: number[] = []
  const shown: { x: number; y: number }[] = []
  const offset: Offset[] = []
  for (let i = 0; i < ACTOR_COUNT; i++) {
    const rect = document.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('class', 'v3-ob-art-actor')
    rect.dataset.kind = 'plain'
    layer?.appendChild(rect)
    rects.push(rect)
    pos.push({ x: 120, y: 110, w: 0, h: 0, r: 0, rot: 0, o: 0 })
    vel.push({ x: 0, y: 0, w: 0, h: 0, r: 0, rot: 0, o: 0 })
    target.push(hidden(120, 110))
    pending.push(null)
    due.push(0)
    shown.push({ x: 120, y: 110 })
    offset.push({ dx: 0, dy: 0, drot: 0, o: 1 })
  }

  let state = initial
  let scene = -1
  const flags: SceneFlags = { contextShown: 0, contextCompacted: false, burst: 0 }
  let timers: number[] = []
  let idleWeight = 0
  let idleTarget = 0
  let last = performance.now()
  let raf = 0
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 }

  const later = (ms: number, fn: () => void): void => {
    timers.push(window.setTimeout(fn, ms))
  }
  const clearTimers = (): void => {
    timers.forEach((id) => window.clearTimeout(id))
    timers = []
  }

  const retarget = (stagger: boolean): void => {
    const next = sceneTargets(state, flags)
    const now = performance.now()
    next.forEach((t, i) => {
      pending[i] = t
      due[i] = now + (stagger ? STAGGER_BASE_MS + i * STAGGER_MS : 0)
    })
  }

  const draw = (selector: string, delay: number): void => {
    const el = svg.querySelector<SVGElement>(selector)
    if (!el || reduce) return
    el.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 520, delay, easing: DRAW_EASE, fill: 'backwards' })
  }

  const contextLoop = (): void => {
    const count = contextCardCount(state.limitIndex)
    flags.contextShown = 0
    flags.contextCompacted = false
    retarget(false)
    zip?.removeAttribute('data-on')
    const gap = 380
    const base = 350
    for (let k = 0; k < count; k++) {
      later(base + k * gap, () => {
        flags.contextShown = k + 1
        retarget(false)
      })
    }
    const hit = base + count * gap + 250
    later(hit, () => threshold?.setAttribute('data-hit', ''))
    later(hit + 260, () => {
      threshold?.removeAttribute('data-hit')
      flags.contextCompacted = true
      retarget(true)
      zip?.setAttribute('data-on', '')
    })
    later(hit + 2300, () => {
      flags.contextCompacted = false
      flags.contextShown = 0
      retarget(false)
      zip?.removeAttribute('data-on')
    })
    later(hit + 2800, contextLoop)
  }

  const enter = (next: number): void => {
    for (let k = 0; k < ACTOR_COUNT; k++) {
      const p = pos[k]
      const d = offset[k]
      p.x += d.dx
      p.y += d.dy
      p.rot += d.drot
      p.o *= d.o
      offset[k] = { dx: 0, dy: 0, drot: 0, o: 1 }
    }
    idleWeight = 0
    idleTarget = 0
    scene = next
    clearTimers()
    threshold?.removeAttribute('data-hit')
    later(IDLE_DELAY_MS, () => {
      idleTarget = 1
    })
    if (next === 4) contextLoop()
    else if (next === 5) {
      flags.burst = 0
      retarget(true)
      later(520, () => {
        flags.burst = 1
        retarget(false)
      })
      later(980, () => {
        flags.burst = 2
        retarget(false)
      })
      draw('[data-draw="check"]', 420)
    } else retarget(true)
    if (next === 0) {
      draw('[data-draw="frame"]', 200)
      draw('[data-draw="chevron"]', 560)
    }
  }

  const frame = (now: number): void => {
    const dt = Math.min(MAX_DT, Math.max(0, (now - last) / 1000))
    last = now
    const t = now / 1000
    for (let i = 0; i < ACTOR_COUNT; i++) {
      const queued = pending[i]
      if (queued && now >= due[i]) {
        target[i] = queued
        pending[i] = null
        rects[i].dataset.kind = queued.k
      }
      const p = pos[i]
      const v = vel[i]
      const goal = target[i]
      for (const key of PROPS) {
        if (reduce) {
          p[key] = goal[key]
          v[key] = 0
          continue
        }
        for (let s = 0; s < SUBSTEPS; s++) {
          const h = dt / SUBSTEPS
          v[key] += (STIFFNESS * (goal[key] - p[key]) - DAMPING * v[key]) * h
          p[key] += v[key] * h
        }
      }
    }
    idleWeight = reduce ? 0 : idleWeight + (idleTarget - idleWeight) * Math.min(1, dt * 2.5)
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 6)
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 6)
    for (let i = 0; i < ACTOR_COUNT; i++) {
      const p = pos[i]
      const d = idleOffset(state, i, t, p.x, p.y)
      const o: Offset = { dx: d.dx * idleWeight, dy: d.dy * idleWeight, drot: d.drot * idleWeight, o: 1 + (d.o - 1) * idleWeight }
      offset[i] = o
      const depth = reduce ? 0 : target[i].k === 'shadow' ? 2 : 6
      const x = p.x + o.dx + pointer.x * depth
      const y = p.y + o.dy + pointer.y * depth
      const w = Math.max(0, p.w)
      const h = Math.max(0, p.h)
      const r = Math.max(0, Math.min(p.r, w / 2, h / 2))
      const opacity = Math.min(1, Math.max(0, p.o)) * o.o
      const rect = rects[i]
      rect.setAttribute('x', fixed(x - w / 2))
      rect.setAttribute('y', fixed(y - h / 2))
      rect.setAttribute('width', fixed(w))
      rect.setAttribute('height', fixed(h))
      rect.setAttribute('rx', fixed(r))
      rect.setAttribute('opacity', opacity.toFixed(3))
      rect.setAttribute('transform', `rotate(${fixed(p.rot + o.drot)} ${fixed(x)} ${fixed(y)})`)
      shown[i] = { x, y }
    }
    if (scene >= 0) {
      for (const [g, index] of anchors[scene] ?? []) {
        const at = shown[index]
        if (at) g.setAttribute('transform', `translate(${fixed(at.x)} ${fixed(at.y)})`)
      }
    }
    raf = requestAnimationFrame(frame)
  }

  const onMove = (event: PointerEvent): void => {
    const r = box.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    pointer.tx = (event.clientX - r.left) / r.width - 0.5
    pointer.ty = (event.clientY - r.top) / r.height - 0.5
  }
  const onLeave = (): void => {
    pointer.tx = 0
    pointer.ty = 0
  }
  const tracksPointer = !reduce && window.matchMedia('(hover: hover)').matches
  if (tracksPointer) {
    box.addEventListener('pointermove', onMove)
    box.addEventListener('pointerleave', onLeave)
  }

  enter(state.scene)
  raf = requestAnimationFrame(frame)

  return {
    update(next) {
      const prev = state
      state = next
      if (next.scene !== scene) {
        enter(next.scene)
        return
      }
      if (scene === 4) {
        if (next.limitIndex !== prev.limitIndex) {
          clearTimers()
          idleTarget = 1
          contextLoop()
        }
        return
      }
      if (next.light !== prev.light || next.soundOn !== prev.soundOn || next.authed !== prev.authed) retarget(false)
    },
    dispose() {
      cancelAnimationFrame(raf)
      clearTimers()
      if (tracksPointer) {
        box.removeEventListener('pointermove', onMove)
        box.removeEventListener('pointerleave', onLeave)
      }
      rects.forEach((rect) => rect.remove())
    }
  }
}
