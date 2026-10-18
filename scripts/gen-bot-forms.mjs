import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decodePng, pngDataUrl, resample } from './lib/png.mjs'

const LOGOS = resolve('assets/lobe-icons')
const OUT = resolve('src/renderer/src/patterns/model-bot/bot-forms.json')
const N = 360
const G = 256
const ART = 128
const FIELD = 60
const FIELD_MARGIN = 10

const BRANDS = {
  claude: { logo: 'claude-color.png', r: 0.375, reach: 0.9, shape: ['star', 12, 0.085, 0.7], spin: 9 },
  codex: { logo: 'openai.png', r: 0.37, shape: ['outline', 1.1, 5], spin: 7, solid: '#10a37f', tintArt: true },
  deepseek: {
    logo: 'deepseek-color.png',
    r: 0.36,
    face: [0, -0.14],
    fins: {
      color: '#3f5ae6',
      parts: [
        { root: [-0.5, 0.38], angle: 142, length: 0.7, base: 0.27, tip: 0.06, sweep: 0 },
        { root: [0.5, 0.38], angle: 38, length: 0.7, base: 0.27, tip: 0.06, sweep: 0 },
        { root: [-0.12, -0.7], angle: -100, length: 0.64, base: 0.34, tip: 0.15, sweep: 0.22 }
      ]
    },
    belly: { color: '#c9d4ff', rect: [-0.86, 0.34, 1.72, 1.56, 0.78] }
  },
  qwen: { logo: 'qwen-color.png', r: 0.37, shape: ['outline', 0.55, 7], spin: 7 },
  gemini: { logo: 'gemini-color.png', r: 0.37, shape: ['outline', 0.35, 14], spin: 5 },
  kimi: { logo: 'kimi.png', frame: [0.02, 0.039, 0.973, 0.965], r: 0.32, c: [0.41, 0.59], shape: ['outline', 0.3, 22], mono: true, keeps: [0.78, 0.02, 0.215, 0.215] },
  glm: { logo: 'zai.png', badge: { box: [0.04, 0.04, 0.96, 0.96], radius: 0.2, fill: '#28282b', glyph: [0.22, 0.24, 0.78, 0.76], ink: '#ffffff' }, r: 0.36, rect: [0.74, 0.74, 0.16], solid: '#28282b', eyeColor: '#ffffff', stroke: '#ffffff' },
  grok: { logo: 'grok.png', r: 0.33, reach: 0.55, face: [0, -0.3], ring: [1.5, 0.32, 0.3, -20, 0.14], mono: true },
  pi: { logo: 'pi.png', r: 0.36, shape: ['circle'], mono: true }
}

const DIRS = Array.from({ length: N }, (_, i) => [Math.cos((i * 2 * Math.PI) / N), Math.sin((i * 2 * Math.PI) / N)])

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

function rgbHex(rgb) {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

function blank(size) {
  return { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) }
}

function alphaBox(image) {
  let x0 = image.width, y0 = image.height, x1 = -1, y1 = -1
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

function crop(image, box) {
  const out = { width: box.w, height: box.h, data: new Uint8ClampedArray(box.w * box.h * 4) }
  for (let y = 0; y < box.h; y++) {
    const from = ((box.y + y) * image.width + box.x) * 4
    out.data.set(image.data.subarray(from, from + box.w * 4), y * box.w * 4)
  }
  return out
}

function paste(target, image, [fx0, fy0, fx1, fy1], tint) {
  const size = target.width
  const scale = Math.min(((fx1 - fx0) * size) / image.width, ((fy1 - fy0) * size) / image.height)
  const w = Math.max(1, Math.round(image.width * scale))
  const h = Math.max(1, Math.round(image.height * scale))
  const left = Math.round(((fx0 + fx1) / 2) * size - w / 2)
  const top = Math.round(((fy0 + fy1) / 2) * size - h / 2)
  const fitted = resample(image, w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tx = left + x, ty = top + y
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue
      const s = (y * w + x) * 4
      const d = (ty * size + tx) * 4
      const a = fitted.data[s + 3] / 255
      if (!a) continue
      const color = tint ?? [fitted.data[s], fitted.data[s + 1], fitted.data[s + 2]]
      const below = target.data[d + 3] / 255
      const out = a + below * (1 - a)
      for (let j = 0; j < 3; j++) target.data[d + j] = (color[j] * a + target.data[d + j] * below * (1 - a)) / out
      target.data[d + 3] = out * 255
    }
  }
}

function roundedBox(size, [x0, y0, x1, y1], radius, color) {
  const out = blank(size)
  const half = [((x1 - x0) * size) / 2, ((y1 - y0) * size) / 2]
  const center = [((x0 + x1) * size) / 2, ((y0 + y1) * size) / 2]
  const r = radius * size
  const rgb = hexRgb(color)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = Math.abs(x + (sx + 0.5) / 4 - center[0]) - (half[0] - r)
          const py = Math.abs(y + (sy + 0.5) / 4 - center[1]) - (half[1] - r)
          const outside = Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0) - r
          if (outside <= 0) inside++
        }
      }
      const o = (y * size + x) * 4
      out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; out.data[o + 3] = (inside / 16) * 255
    }
  }
  return out
}

function sourceOf(spec) {
  const image = decodePng(readFileSync(join(LOGOS, spec.logo)))
  if (spec.badge) {
    const { box, radius, fill, glyph, ink } = spec.badge
    const out = roundedBox(image.width, box, radius, fill)
    paste(out, crop(image, alphaBox(image)), glyph, hexRgb(ink))
    return out
  }
  if (spec.frame) {
    const out = blank(image.width)
    paste(out, crop(image, alphaBox(image)), spec.frame)
    return out
  }
  return image
}

function logoRadii(px, c) {
  return DIRS.map(([dx, dy]) => {
    let last = 0
    for (let d = 0; d < G * 1.5; d++) {
      const x = Math.round(c[0] * G + dx * d)
      const y = Math.round(c[1] * G + dy * d)
      if (x < 0 || y < 0 || x >= G || y >= G) break
      if (px.data[(y * G + x) * 4 + 3] > 127) last = d
    }
    return Math.max(0.02, last / G)
  })
}

function smoothed(ring, w) {
  let current = ring
  for (let pass = 0; pass < 2; pass++) {
    current = current.map((_, i) => {
      let sum = 0
      for (let o = -w; o <= w; o++) sum += current[(i + o + N) % N]
      return sum / (2 * w + 1)
    })
  }
  return current
}

function rectRadius([dx, dy], [w, h, rd]) {
  const inside = (t) => {
    const qx = Math.abs(dx * t) - (w / 2 - rd)
    const qy = Math.abs(dy * t) - (h / 2 - rd)
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rd <= 0
  }
  let lo = 0, hi = 1
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2
    if (inside(mid)) lo = mid
    else hi = mid
  }
  return lo
}

function bodyRadii(spec, logo) {
  if (spec.rect) return DIRS.map((dir) => rectRadius(dir, spec.rect))
  const shape = spec.shape ?? ['circle']
  if (shape[0] === 'circle') return Array(N).fill(spec.r)
  if (shape[0] === 'star') {
    const [, points, depth, puff] = shape
    return DIRS.map((_, i) => {
      const t = (points * i * 2 * Math.PI) / N
      const wave = puff < 1 ? 2 * Math.pow(Math.abs(Math.cos(t / 2)), puff) - 1 : Math.cos(t)
      return spec.r * (1 + depth * wave)
    })
  }
  const [, keep, width] = shape
  const soft = smoothed(logo, width)
  const mean = soft.reduce((a, b) => a + b, 0) / N
  return soft.map((v) => Math.max(spec.r * 0.55, spec.r * (1 + keep * (v / mean - 1))))
}

function colorField(px) {
  const inner = FIELD - FIELD_MARGIN * 2
  const color = new Float32Array(FIELD * FIELD * 3)
  let known = new Uint8Array(FIELD * FIELD)
  const lo = [255, 255, 255], hi = [0, 0, 0], sum = [0, 0, 0]
  let seen = 0
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const row = Math.floor(((y + 0.5) * G) / inner)
      const col = Math.floor(((x + 0.5) * G) / inner)
      const o = (row * G + col) * 4
      if (px.data[o + 3] <= 200) continue
      const k = (y + FIELD_MARGIN) * FIELD + x + FIELD_MARGIN
      for (let j = 0; j < 3; j++) {
        const v = px.data[o + j]
        color[k * 3 + j] = v
        lo[j] = Math.min(lo[j], v); hi[j] = Math.max(hi[j], v); sum[j] += v
      }
      known[k] = 1
      seen++
    }
  }
  const average = rgbHex(sum.map((v) => v / Math.max(1, seen)))
  if (hi.every((h, j) => h - lo[j] < 14)) return { paint: average }
  for (let pass = 0; pass < 80; pass++) {
    let changed = false
    const nextKnown = known.slice()
    const nextColor = color.slice()
    for (let y = 0; y < FIELD; y++) {
      for (let x = 0; x < FIELD; x++) {
        const k = y * FIELD + x
        if (known[k]) continue
        let r = 0, g = 0, b = 0, n = 0
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const xx = x + ox, yy = y + oy
          if (xx < 0 || yy < 0 || xx >= FIELD || yy >= FIELD) continue
          const kk = yy * FIELD + xx
          if (!known[kk]) continue
          r += color[kk * 3]; g += color[kk * 3 + 1]; b += color[kk * 3 + 2]; n++
        }
        if (!n) continue
        nextColor[k * 3] = r / n; nextColor[k * 3 + 1] = g / n; nextColor[k * 3 + 2] = b / n
        nextKnown[k] = 1
        changed = true
      }
    }
    known = nextKnown
    color.set(nextColor)
    if (!changed) break
  }
  const field = blank(FIELD)
  for (let k = 0; k < FIELD * FIELD; k++) {
    field.data[k * 4] = color[k * 3]; field.data[k * 4 + 1] = color[k * 3 + 1]; field.data[k * 4 + 2] = color[k * 3 + 2]; field.data[k * 4 + 3] = 255
  }
  return { paint: average, field: pngDataUrl(field) }
}

function artOf(source, spec) {
  const art = resample(source, ART)
  if (spec.tintArt && spec.solid) {
    const rgb = hexRgb(spec.solid)
    for (let i = 0; i < art.data.length; i += 4) { art.data[i] = rgb[0]; art.data[i + 1] = rgb[1]; art.data[i + 2] = rgb[2] }
  }
  return pngDataUrl(art)
}

const round = (values) => values.map((v) => Math.round(v * 1000) / 1000)

const brands = {}
for (const [key, spec] of Object.entries(BRANDS)) {
  const source = sourceOf(spec)
  const px = resample(source, G)
  const center = spec.c ?? [0.5, 0.5]
  const logo = logoRadii(px, center)
  const body = bodyRadii(spec, logo)
  const color = spec.solid ? { paint: spec.solid } : spec.mono ? {} : colorField(px)
  brands[key] = {
    center,
    radius: spec.r,
    reach: spec.reach ?? 0.8,
    spin: spec.spin ?? 0,
    face: spec.face ?? [0, 0],
    cross: true,
    mono: !!spec.mono,
    ...color,
    ...(spec.rect ? { rect: spec.rect } : {}),
    ...(spec.eyeColor ? { eyeColor: spec.eyeColor } : {}),
    ...(spec.stroke ? { stroke: spec.stroke } : {}),
    ...(spec.ring ? { ring: spec.ring } : {}),
    ...(spec.keeps ? { keeps: spec.keeps } : {}),
    ...(spec.fins ? { fins: spec.fins } : {}),
    ...(spec.belly ? { belly: spec.belly } : {}),
    logo: round(logo),
    body: round(body),
    art: artOf(source, spec)
  }
}

writeFileSync(OUT, `${JSON.stringify({ samples: N, brands })}\n`)
const size = (readFileSync(OUT).length / 1024).toFixed(1)
console.log(`bot-forms.json：${Object.keys(brands).length} 个品牌，${size} KB → ${OUT}`)
