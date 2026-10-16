/**
 * 新会话主页 ASCII 涟漪的纯计算。
 *
 * 只在这里放可在 Node 里直接跑、可断言的决策：墨团值场、墨源与滴墨事件、字形状态、
 * 入场洇开与退场收拢、镂空遮罩、指针搅动、帧节拍、无障碍动效策略与开关读取。
 * Canvas 绘制、ResizeObserver、事件监听留在 `AsciiField.tsx`，本文件不引用 DOM、React 或运行时模块。
 *
 * 正式帧路径只采样三束随机落点的涟漪，以问候文字为中心，粗网格插值后绘制。
 * 不在每格求多层噪声；数组跨帧复用，字形按低频 tick 更新。早期噪声函数仍是独立纯函数，
 * 不进入正式绘制热路径。透明度低于正文，发送时由宿主停止计算并让 CSS 淡出。
 */
import type { AppSettings } from '../../../../shared/ipc'

/** 碎墨：墨团外缘的过渡字形。 */
export const DUST = ".,:;'"
/** 墨芯：墨团内部的随机字母数字。 */
export const CORE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
/** 图集字形表：碎墨在前、墨芯在后。只含拉丁字母、数字与少量符号，不含空白与中文。 */
export const CHARSET = DUST + CORE
/** 单元边长（CSS px），12–14 之间。 */
export const CELL_SIZE = 12
/** 透明度：碎墨下限、墨芯起点与上限。 */
export const MIN_ALPHA = 0.025
export const CORE_ALPHA = 0.045
export const MAX_ALPHA = 0.12
/** 入场边界提亮、指针加浓后的透明度硬上限，避免背景抢正文。 */
export const ALPHA_CEILING = 0.15
/** 透明度级数：图集按级预先烘焙，绘制时不切换 globalAlpha。 */
export const ALPHA_LEVELS = 16
/** 值场阈值：高于 INK_LOW 出碎墨，高于 INK_CORE 出墨芯。 */
export const INK_LOW = 0.4
export const INK_CORE = 0.48
/** 墨芯透明度满档对应的值。 */
export const INK_FULL = 0.86
/** 帧率目标：聚焦 60fps，失焦降到约 8fps。 */
export const TARGET_FPS = 60
export const BLURRED_FPS = 8
/** 节拍容差（ms）：刷新时间戳的抖动不应让本该落的帧推迟一整拍。 */
export const FRAME_SLACK_MS = 4
/** 固定种子：同一输入必得同一画面，便于测试与稳定观感。 */
export const FIELD_SEED = 1337
/** 入场淡入与退场淡出时长（ms）。 */
export const ENTER_MS = 480
export const EXIT_MS = 160
/** 洇开边界带宽（CSS px）与参差幅度（CSS px）。 */
export const FRONT_WIDTH = 64
export const FRONT_RAG = 180
/** 值场采样步长（格）：在粗网格上取样再双线性插值。 */
export const FIELD_STRIDE = 2
/** 墨源个数。 */
export const PLUME_COUNT = 4
/** 滴墨时间槽（秒）、出现概率与寿命（秒）。 */
export const DROP_SLOT = 1.7
export const DROP_CHANCE = 0.6
export const DROP_LIFE = 4.6
/** 字形换字概率（每帧）：内部底噪与边缘活跃带峰值。 */
export const MUTATE_BASE = 0.003
export const MUTATE_EDGE = 0.07
/** 减少动态时静态画面取的时刻（秒）：此刻有墨源与滴墨，画面完整。 */
export const STATIC_TIME = 11.3

export interface GridSpec {
  cols: number
  rows: number
  cell: number
}

export interface ClearZone {
  x: number
  y: number
  rx: number
  ry: number
  /** 边缘羽化宽度：椭圆区无量纲（1 表示一个半径）；矩形区为 CSS px。 */
  feather: number
  /** true = 矩形区（rx / ry 为半宽 / 半高），盖得住文字块四角；缺省椭圆。 */
  box?: boolean
}

export interface MousePoint {
  x: number
  y: number
}

export interface MotionInput {
  /** 页面可见且组件在视口内。 */
  visible: boolean
  /** 窗口是否聚焦。 */
  focused: boolean
  /** 系统是否要求减少动态。 */
  reducedMotion: boolean
}

export interface MotionPolicy {
  active: boolean
  fps: number
}

/** 一个墨源或滴墨：位置（以画面高为 1 的坐标）、半径与强度。 */
export interface InkSource {
  x: number
  y: number
  radius: number
  strength: number
}

export interface InkSources {
  plumes: InkSource[]
  drops: InkSource[]
}

export interface FieldFrameInput {
  width: number
  height: number
  cell?: number
  time: number
  /** 帧序号：字形换字的确定性随机源；缺省按时间推算。 */
  tick?: number
  seed?: number
  zones?: readonly ClearZone[]
  mouse?: MousePoint | null
  /** 点击涟漪（CSS px 位置 + 已过秒数）：从点击处向外扩散一圈，约 2.4s 消退。 */
  pulses?: ReadonlyArray<{ x: number; y: number; age: number }>
  /** 落点（CSS px）：入场洇开与退场收拢的起点；缺省为宽 50%、高 44%。 */
  anchor?: MousePoint | null
  /** 入场进度 0..1（1 = 已铺满，缺省 1）。 */
  enter?: number
  /** 退场进度 0..1（0 = 未开始，缺省 0）。 */
  exit?: number
}

export interface FieldFrame {
  cols: number
  rows: number
  cell: number
  /** 最终透明度（已含显影、遮罩与加浓），0 = 不画。 */
  alpha: Float32Array
  /** 值场 [0,1]（插值后、含逐格参差），测试与调试用。 */
  value: Float32Array
  /** 1 = 用强调色。 */
  accent: Uint8Array
  /** 每格字形（CHARSET 下标）：跨帧保留的状态。 */
  glyph: Uint8Array
  /** 每格墨带：0 空、1 碎墨、2 墨芯；跨帧保留，用于判断是否换字。 */
  band: Uint8Array
  /** 实际要画的格数。 */
  visible: number
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 平滑插值权重。 */
export function smoothstep(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

/** 入场缓动：快出慢收（墨晕推开后渐停）。 */
export function easeOutCubic(t: number): number {
  const x = 1 - clamp01(t)
  return 1 - x * x * x
}

/** 退场缓动：先慢后快（收墨）。 */
export function easeInCubic(t: number): number {
  const x = clamp01(t)
  return x * x * x
}

/** 32 位整数哈希 → [0,1)；不依赖平台随机源。 */
export function hashInt(n: number): number {
  let h = n | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967296
}

/** 三维格点哈希，带种子。 */
export function hash3i(x: number, y: number, z: number, seed: number): number {
  const mixed = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177) ^ Math.imul(seed | 0, 2654435761)
  return hashInt(mixed)
}

/** 三维 value noise，三线性 + smoothstep；返回值 [0,1)。 */
export function valueNoise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const u = smoothstep(x - xi)
  const v = smoothstep(y - yi)
  const w = smoothstep(z - zi)
  const c000 = hash3i(xi, yi, zi, seed)
  const c100 = hash3i(xi + 1, yi, zi, seed)
  const c010 = hash3i(xi, yi + 1, zi, seed)
  const c110 = hash3i(xi + 1, yi + 1, zi, seed)
  const c001 = hash3i(xi, yi, zi + 1, seed)
  const c101 = hash3i(xi + 1, yi, zi + 1, seed)
  const c011 = hash3i(xi, yi + 1, zi + 1, seed)
  const c111 = hash3i(xi + 1, yi + 1, zi + 1, seed)
  const x00 = lerp(c000, c100, u)
  const x10 = lerp(c010, c110, u)
  const x01 = lerp(c001, c101, u)
  const x11 = lerp(c011, c111, u)
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w)
}

/** 二维 value noise（z = 0）。 */
export function valueNoise2(x: number, y: number, seed = 0): number {
  return valueNoise3(x, y, 0, seed)
}

/** 分形噪声：`octaves` 层，每层频率翻倍、幅度减半，归一化到 [0,1)。 */
export function fbm(x: number, y: number, z: number, seed: number, octaves = 3): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = 1
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise3(x * f, y * f, z * f, seed + o * 13) * amp
    norm += amp
    amp *= 0.5
    f *= 2.03
  }
  return sum / norm
}

/**
 * 本帧的墨源与滴墨（坐标以画面高为 1，横向范围 0..aspect）。
 * 墨源沿各自的噪声路径游走；滴墨按时间槽哈希决定有无与位置，晕开后化开。
 */
export function inkSources(t: number, seed: number, aspect: number): InkSources {
  const plumes: InkSource[] = []
  for (let i = 0; i < PLUME_COUNT; i++) {
    const nx = valueNoise3(t * 0.045 + i * 17.1, i * 3.7, 0.5, seed + 50)
    const ny = valueNoise3(i * 5.3, t * 0.04 + i * 9.4, 1.5, seed + 51)
    const nr = valueNoise3(t * 0.08 + i * 2.9, i * 1.3, 2.5, seed + 52)
    plumes.push({
      x: (0.04 + nx * 0.92) * aspect,
      y: 0.04 + ny * 0.92,
      radius: 0.13 + nr * 0.12,
      strength: 0.2 + nr * 0.12
    })
  }
  const drops: InkSource[] = []
  const slot = Math.floor(t / DROP_SLOT)
  const back = Math.ceil(DROP_LIFE / DROP_SLOT) + 1
  for (let k = slot - back; k <= slot; k++) {
    if (hash3i(k, 0, 0, seed + 90) >= DROP_CHANCE) continue
    const born = (k + hash3i(k, 1, 0, seed + 90)) * DROP_SLOT
    const age = t - born
    if (age < 0 || age >= DROP_LIFE) continue
    const grow = easeOutCubic(age / 2.4)
    const fade = 1 - smoothstep((age - 1.1) / (DROP_LIFE - 1.1))
    drops.push({
      x: (0.06 + hash3i(k, 2, 0, seed + 90) * 0.88) * aspect,
      y: 0.08 + hash3i(k, 3, 0, seed + 90) * 0.84,
      radius: 0.025 + grow * (0.1 + hash3i(k, 4, 0, seed + 90) * 0.1),
      strength: 0.46 * fade
    })
  }
  return { plumes, drops }
}

function sourceSum(list: readonly InkSource[], x: number, y: number): number {
  let sum = 0
  for (const s of list) {
    const dx = x - s.x
    const dy = y - s.y
    const d2 = (dx * dx + dy * dy) / (s.radius * s.radius)
    if (d2 < 6) sum += s.strength * Math.exp(-d2)
  }
  return sum
}

/**
 * 某点的墨值（坐标以画面高为 1）：域扭曲墨团 + 墨源 + 滴墨。
 * 墨源与滴墨的距离也在扭曲后的坐标里量，边缘因此参差不齐。
 */
export function inkAt(x: number, y: number, t: number, seed: number, sources: InkSources): number {
  const sx = x * 2.1
  const sy = y * 2.1
  const qx = fbm(sx + t * 0.03, sy, t * 0.045, seed, 2)
  const qy = fbm(sx + 5.2, sy + 1.3 - t * 0.026, t * 0.045, seed + 1, 2)
  const r = fbm(sx + 3.1 * qx + 1.7 + t * 0.018, sy + 3.1 * qy + 9.2, t * 0.06, seed + 2, 3)
  const wx = x + (qx - 0.5) * 0.34
  const wy = y + (qy - 0.5) * 0.34
  const blobs = clamp01((r - 0.5) * 1.9 + 0.5)
  return clamp01(blobs * 0.86 + sourceSum(sources.plumes, wx, wy) + sourceSum(sources.drops, wx, wy) - 0.06)
}

/** 色调区：随墨流移动的低频噪声，高于阈值的区域用强调色。 */
export function toneAt(x: number, y: number, t: number, seed: number): number {
  return valueNoise3(x * 1.6 + 30 + t * 0.022, y * 1.6 - t * 0.012, t * 0.03, seed + 77)
}

/** 指针搅动：把采样点绕指针旋转一个随距离衰减的角度，返回新坐标（同一坐标系）。 */
export function stirPoint(x: number, y: number, mouse: { x: number; y: number } | null, radius: number, t: number): { x: number; y: number; k: number } {
  if (!mouse) return { x, y, k: 0 }
  const dx = x - mouse.x
  const dy = y - mouse.y
  const d = Math.sqrt(dx * dx + dy * dy)
  if (d >= radius) return { x, y, k: 0 }
  const k = smoothstep(1 - d / radius)
  const angle = k * (2.0 + 0.35 * Math.sin(t * 1.7))
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: mouse.x + dx * c - dy * s, y: mouse.y + dx * s + dy * c, k }
}

/** 参考实现：归一化坐标 `u`/`v`（[0,1]）与时间 `t` → 墨值（不含逐格参差）。 */
export function fieldValue(u: number, v: number, t: number, seed = 0, aspect = 1.6): number {
  return inkAt(u * aspect, v, t, seed, inkSources(t, seed, aspect))
}

/** 每格固定的小参差（±0.035），让插值后的墨团边缘不是光滑曲线。 */
export function cellJitter(col: number, row: number, seed: number): number {
  return (hash3i(col, row, 7, seed + 404) - 0.5) * 0.07
}

/** 值 → 墨带：0 空、1 碎墨、2 墨芯。 */
export function inkBand(value: number): 0 | 1 | 2 {
  return value > INK_CORE ? 2 : value > INK_LOW ? 1 : 0
}

/** 值 → 透明度；不到碎墨阈值返回 0。碎墨很淡，墨芯随值加深。 */
export function cellAlpha(value: number): number {
  if (!(value > INK_LOW)) return 0
  if (value <= INK_CORE) return MIN_ALPHA + ((value - INK_LOW) / (INK_CORE - INK_LOW)) * (CORE_ALPHA - MIN_ALPHA) * 0.6
  const k = clamp01((value - INK_CORE) / (INK_FULL - INK_CORE))
  return CORE_ALPHA + (MAX_ALPHA - CORE_ALPHA) * Math.pow(k, 1.1)
}

/** 边缘活跃度：值贴近墨芯阈值时为 1，向两侧在 0.07 内衰减为 0。 */
export function edgeActivity(value: number): number {
  return 1 - smoothstep(Math.abs(value - INK_CORE) / 0.07)
}

/** 本帧该格是否换字：确定性哈希，边缘活跃带概率高、内部很低。 */
export function shouldMutate(col: number, row: number, tick: number, seed: number, value: number): boolean {
  return hash3i(col, row, tick, seed + 4211) < MUTATE_BASE + MUTATE_EDGE * edgeActivity(value)
}

/** 按墨带挑一个字形（CHARSET 下标）。 */
export function pickGlyph(band: number, col: number, row: number, tick: number, seed: number): number {
  const h = hash3i(col, row, tick, seed + 991)
  if (band === 1) return Math.floor(h * DUST.length)
  return DUST.length + Math.floor(h * CORE.length)
}

/** 透明度 → 图集级别（0..ALPHA_LEVELS-1，四舍五入到最近一级）；0 或负值返回 -1。 */
export function alphaLevel(alpha: number, levels = ALPHA_LEVELS): number {
  if (!(alpha > 0)) return -1
  const l = Math.round((alpha / ALPHA_CEILING) * levels) - 1
  if (l < 0) return 0
  return l >= levels ? levels - 1 : l
}

/** 某级对应的烘焙透明度。 */
export function levelAlpha(level: number, levels = ALPHA_LEVELS): number {
  return ((level + 1) / levels) * ALPHA_CEILING
}

/** 网格尺寸：按 CSS 像素与单元边长取整列 / 行数。 */
export function computeGrid(width: number, height: number, cell = CELL_SIZE): GridSpec {
  const safeCell = Math.max(6, Math.floor(cell))
  const w = Math.max(0, width)
  const h = Math.max(0, height)
  return {
    cols: Math.max(0, Math.ceil(w / safeCell)),
    rows: Math.max(0, Math.ceil(h / safeCell)),
    cell: safeCell
  }
}

/**
 * 量不到主页文字时的兜底镂空：正中阅读区 + 底部输入区。
 * 组件量得到文字时只用实测区（见 `textClearZone`），不再叠这块大镂空。
 */
export function defaultClearZones(width: number, height: number): ClearZone[] {
  const min = Math.min(width, height)
  return [
    { x: width * 0.5, y: height * 0.46, rx: Math.max(120, min * 0.18), ry: Math.max(100, min * 0.16), feather: 1.2 },
    bottomClearZone(width, height)
  ]
}

/** 底部输入区与用量行的镂空（输入框本身不透明，这里只让边缘过渡柔和）。 */
export function bottomClearZone(width: number, height: number): ClearZone {
  return { x: width * 0.5, y: height * 1.04, rx: Math.max(300, width * 0.42), ry: Math.max(110, height * 0.2), feather: 0.6 }
}

/** 按文字块实测矩形（相对画布）生成贴身的矩形镂空：留一圈边距、向外 40px 羽化，四角也盖住。 */
export function textClearZone(rect: { left: number; top: number; width: number; height: number }, pad = 28): ClearZone {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    rx: rect.width / 2 + pad,
    ry: rect.height / 2 + pad,
    feather: 40,
    box: true
  }
}

/** 点在一个或多个镂空区内的遮罩系数：区内为 0，区外为 1，边缘 smoothstep 过渡。 */
export function maskFactor(px: number, py: number, zones: readonly ClearZone[]): number {
  let factor = 1
  for (const zone of zones) {
    if (zone.box) {
      const dx = Math.max(0, Math.abs(px - zone.x) - zone.rx)
      const dy = Math.max(0, Math.abs(py - zone.y) - zone.ry)
      if (dx === 0 && dy === 0) return 0
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < zone.feather) {
        const next = smoothstep(d / zone.feather)
        if (next < factor) factor = next
      }
      continue
    }
    const nx = (px - zone.x) / zone.rx
    const ny = (py - zone.y) / zone.ry
    const d2 = nx * nx + ny * ny
    if (d2 <= 1) return 0
    const edge = 1 + zone.feather
    if (d2 < edge * edge) {
      const next = smoothstep((Math.sqrt(d2) - 1) / zone.feather)
      if (next < factor) factor = next
    }
  }
  return factor
}

/** 落点到画面四角的最远距离（加参差幅度）：显影半径以它为满程。 */
export function maxReach(width: number, height: number, anchor: MousePoint): number {
  const dx = Math.max(anchor.x, width - anchor.x)
  const dy = Math.max(anchor.y, height - anchor.y)
  return Math.hypot(dx, dy) + FRONT_WIDTH + FRONT_RAG
}

/**
 * 当前显影半径（CSS px）。入场从 0 推到满程；退场从满程收回 0。
 * 两者同时给出时取较小者（入场途中被打断也能平滑收回）。
 */
export function revealRadius(reach: number, enter: number, exit: number): number {
  const opening = easeOutCubic(enter) * reach
  const closing = (1 - easeInCubic(exit)) * reach
  return Math.min(opening, closing)
}

/** 某距离处的显影系数（边界内侧为 1，向外在 FRONT_WIDTH 内柔和归零）。 */
export function revealFactor(distance: number, radius: number, width = FRONT_WIDTH): number {
  if (radius <= 0) return 0
  return 1 - smoothstep((distance - (radius - width)) / width)
}

/** 边界强度：只在入场 / 退场途中、距离贴近显影半径时 > 0。 */
export function frontStrength(distance: number, radius: number, moving: boolean, width = FRONT_WIDTH): number {
  if (!moving || radius <= 0) return 0
  const x = (distance - (radius - width * 0.5)) / (width * 0.75)
  return Math.exp(-x * x)
}

/** 为某网格分配（或复用）帧缓冲；尺寸不变时原样返回，字形状态随之保留。 */
export function ensureFrame(prev: FieldFrame | null | undefined, cols: number, rows: number, cell: number): FieldFrame {
  const total = cols * rows
  if (prev && prev.alpha.length === total && prev.cols === cols) {
    prev.rows = rows
    prev.cell = cell
    return prev
  }
  return {
    cols,
    rows,
    cell,
    alpha: new Float32Array(total),
    value: new Float32Array(total),
    accent: new Uint8Array(total),
    glyph: new Uint8Array(total),
    band: new Uint8Array(total),
    visible: 0
  }
}

/* 粗网格缓冲：同尺寸时复用 */
let inkScratch = new Float32Array(0)

/**
 * 单帧纯计算：墨值 + 显影 + 遮罩 + 指针 + 字形状态 + 色调，输出可直接绘制的数组。
 * 不含任何 Canvas 调用，便于在 Node 里做确定性 / 性能基准。传入 `out` 时复用其缓冲
 * 并延续字形状态（同一序列输入必得同一序列输出）。
 */
export function computeFieldFrame(input: FieldFrameInput, out?: FieldFrame | null): FieldFrame {
  const cell = Math.max(6, Math.floor(input.cell ?? CELL_SIZE))
  const grid = computeGrid(input.width, input.height, cell)
  const frame = ensureFrame(out, grid.cols, grid.rows, grid.cell)
  const { alpha, value, accent, glyph, band } = frame
  alpha.fill(0)
  value.fill(0)
  accent.fill(0)
  const zones = input.zones ?? defaultClearZones(input.width, input.height)
  const seed = input.seed ?? FIELD_SEED
  const anchor = input.anchor ?? { x: input.width * 0.5, y: input.height * 0.44 }
  const enter = input.enter ?? 1
  const exit = input.exit ?? 0
  const t = input.time
  const tick = input.tick ?? Math.floor(t * TARGET_FPS)
  const fade = (1 - exit) * Math.min(1, enter * 2)
  const height = input.height > 0 ? input.height : 1
  const mouse = input.mouse ? { x: input.mouse.x / height, y: input.mouse.y / height } : null
  const stirRadius = 250 / height
  const ax = anchor.x / height
  const ay = anchor.y / height
  const drift = Math.floor(t / 2.4)
  // 一帧只计算三次落点；粗网格只求距离，不重复生成噪声场。
  const ripples: Array<{ x: number; y: number; radius: number; strength: number }> = [0, 1, 2].map((k) => {
    const slot = drift - k
    const age = t - slot * 2.4
    return { x: ax + (hash3i(slot, 31, 0, seed) - 0.5) * 0.7, y: ay + (hash3i(slot, 73, 0, seed) - 0.5) * 0.5, radius: age * 0.24, strength: Math.max(0, 1 - age / 7.2) * Math.min(1, age / 0.35) }
  })

  for (const pulse of input.pulses ?? []) {
    ripples.push({ x: pulse.x / height, y: pulse.y / height, radius: pulse.age * 0.55, strength: Math.max(0, 1 - pulse.age / 2.4) * Math.min(1, pulse.age / 0.08) * 1.6 })
  }

  /* 墨值与色调在粗网格上取样（低频，插值无可见差别），指针搅动也在这一层做 */
  const fcols = Math.ceil(grid.cols / FIELD_STRIDE) + 1
  const frows = Math.ceil(grid.rows / FIELD_STRIDE) + 1
  if (inkScratch.length < fcols * frows) {
    inkScratch = new Float32Array(fcols * frows)
  }
  const step = (FIELD_STRIDE * grid.cell) / height
  const half = (grid.cell * 0.5) / height
  for (let fr = 0; fr < frows; fr++) {
    const y0 = fr * step + half
    for (let fc = 0; fc < fcols; fc++) {
      const x0 = fc * step + half
      const p = stirPoint(x0, y0, mouse, stirRadius, t)
      const i = fr * fcols + fc
      let ripple = 0
      for (const wave of ripples) {
        const distance = Math.hypot(p.x - wave.x, p.y - wave.y)
        const edge = (distance - wave.radius) / 0.075
        ripple += Math.exp(-edge * edge) * wave.strength
      }
      const focus = Math.exp(-Math.hypot(p.x - ax, p.y - ay) * 1.7)
      /* 指针附近的墨更浓（跟手），再叠上搅动本身造成的扭曲 */
      inkScratch[i] = 0.31 + ripple * 0.37 + focus * 0.15 + p.k * 0.3
    }
  }

  let visible = 0
  for (let row = 0; row < grid.rows; row++) {
    const py = (row + 0.5) * grid.cell
    const fy = row / FIELD_STRIDE
    const fr0 = fy | 0
    const ty = fy - fr0
    for (let col = 0; col < grid.cols; col++) {
      const px = (col + 0.5) * grid.cell
      const idx = row * grid.cols + col
      const fx = col / FIELD_STRIDE
      const fc0 = fx | 0
      const tx = fx - fc0
      const base = fr0 * fcols + fc0
      const ink = lerp(
        lerp(inkScratch[base], inkScratch[base + 1], tx),
        lerp(inkScratch[base + fcols], inkScratch[base + fcols + 1], tx),
        ty
      )
      const shown = 1
      const mask = shown > 0 ? maskFactor(px, py, zones) : 0
      if (shown <= 0 || mask <= 0) {
        band[idx] = 0
        continue
      }
      const front = 0
      const sample = clamp01(ink + cellJitter(col, row, seed) + front * 0.22)
      value[idx] = sample
      const nextBand = inkBand(sample)
      if (nextBand === 0) {
        band[idx] = 0
        continue
      }
      if (nextBand !== band[idx] || shouldMutate(col, row, tick, seed, sample)) {
        glyph[idx] = pickGlyph(nextBand, col, row, tick, seed)
      }
      band[idx] = nextBand
      const a = cellAlpha(sample) * shown * fade * (1 + front * 0.9) * mask
      if (a <= 0.004) continue
      alpha[idx] = a > ALPHA_CEILING ? ALPHA_CEILING : a
      if (nextBand === 2) accent[idx] = ink > 0.72 ? 1 : 0
      visible++
    }
  }
  frame.visible = visible
  return frame
}

/** 帧率策略：隐藏或减少动态时停画；失焦降到 8fps。 */
export function animationPolicy(input: MotionInput): MotionPolicy {
  if (input.reducedMotion) return { active: false, fps: 0 }
  if (!input.visible) return { active: false, fps: 0 }
  return { active: true, fps: input.focused ? TARGET_FPS : BLURRED_FPS }
}

/** 帧间隔（ms）；fps ≤ 0 时视为不再绘制。 */
export function frameInterval(fps: number): number {
  return fps > 0 ? 1000 / fps : Number.POSITIVE_INFINITY
}

/**
 * 节拍判断：距上一帧够一个间隔（减去容差）才画。容差让 60Hz 屏稳定每 2 拍落一帧、
 * 144Hz 屏稳定每 5 拍落一帧，不会因时间戳抖动出现 33ms / 50ms 交替的顿挫。
 */
export function shouldDraw(now: number, lastDraw: number, fps: number): boolean {
  return now - lastDraw >= frameInterval(fps) - FRAME_SLACK_MS
}

/* ------------------------------------------------------------------ 开关 */

/** 动态背景设置字段的结构（AppSettings 尚未含该键时的最小形状）。 */
export interface AsciiBackgroundSettings {
  asciiBackground?: boolean
}

/** 读取：字段缺失视为开启，只有明确 false 才关。 */
export function asciiBackgroundEnabled(settings: AsciiBackgroundSettings | AppSettings | null | undefined): boolean {
  return (settings as AsciiBackgroundSettings | null | undefined)?.asciiBackground !== false
}

/**
 * 构造设置补丁。字段尚未并入 `AppSettings`（热点文件，由集成者按补丁说明落地），
 * 这里用交叉类型让调用方无需类型断言即可交给 `patchSettings`。
 */
export function asciiBackgroundPatch(enabled: boolean): AsciiBackgroundSettings & Partial<AppSettings> {
  return { asciiBackground: enabled }
}
