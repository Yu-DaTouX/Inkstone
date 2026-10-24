import { createImage, encodePng, fillRect, pixel, setPixel, type RgbaImage } from './png.ts'

export interface PaletteEntry {
  key: string
  hex: string
  rgba: [number, number, number, number]
  count: number
}

export interface TextureView {
  png: Buffer
  width: number
  height: number
  cell: number
  palette: PaletteEntry[]
  grid: string[] | null
  transparentPixels: number
  text: string
}

const KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const GRID_TEXT_LIMIT = 64

const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111']
}

function hex(rgba: [number, number, number, number]): string {
  const body = rgba.slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('')
  return `#${body}${rgba[3] === 255 ? '' : rgba[3].toString(16).padStart(2, '0')}`
}

function drawNumber(image: RgbaImage, value: number, x: number, y: number, scale: number, color: [number, number, number, number]): void {
  let cursor = x
  for (const char of String(value)) {
    const glyph = DIGITS[char]
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) if (glyph[row][col] === '1') fillRect(image, cursor + col * scale, y + row * scale, scale, scale, color)
    }
    cursor += 4 * scale
  }
}

function numberWidth(value: number, scale: number): number {
  return String(value).length * 4 * scale - scale
}

export function analyzePalette(image: RgbaImage): { palette: PaletteEntry[]; keyOf: Map<number, string>; transparent: number } {
  const counts = new Map<number, number>()
  let transparent = 0
  for (let index = 0; index < image.width * image.height; index++) {
    const alpha = image.data[index * 4 + 3]
    if (alpha === 0) {
      transparent += 1
      continue
    }
    const packed = ((image.data[index * 4] << 24) | (image.data[index * 4 + 1] << 16) | (image.data[index * 4 + 2] << 8) | alpha) >>> 0
    counts.set(packed, (counts.get(packed) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const keyOf = new Map<number, string>()
  const palette = sorted.map(([packed, count], index) => {
    const rgba: [number, number, number, number] = [packed >>> 24, (packed >>> 16) & 0xff, (packed >>> 8) & 0xff, packed & 0xff]
    const key = KEYS[index] ?? '?'
    keyOf.set(packed, key)
    return { key, hex: hex(rgba), rgba, count }
  })
  return { palette, keyOf, transparent }
}

export function textureGrid(image: RgbaImage, keyOf: Map<number, string>): string[] {
  const rows: string[] = []
  for (let y = 0; y < image.height; y++) {
    let line = ''
    for (let x = 0; x < image.width; x++) {
      const [r, g, b, a] = pixel(image, x, y)
      line += a === 0 ? '.' : keyOf.get(((r << 24) | (g << 16) | (b << 8) | a) >>> 0) ?? '?'
    }
    rows.push(line)
  }
  return rows
}

export function renderTextureView(image: RgbaImage, options: { maxSize?: number; grid?: boolean } = {}): TextureView {
  const maxSize = options.maxSize ?? 512
  const cell = Math.max(1, Math.min(32, Math.floor(maxSize / Math.max(image.width, image.height))))
  const showGrid = (options.grid ?? true) && cell >= 6
  const labelScale = cell >= 16 ? 2 : 1
  const margin = showGrid ? Math.max(numberWidth(Math.max(image.width, image.height) - 1, labelScale) + 6, 5 * labelScale + 6) : 0
  const width = margin + image.width * cell + (showGrid ? 1 : 0)
  const height = margin + image.height * cell + (showGrid ? 1 : 0)
  const view = createImage(width, height, [32, 32, 36, 255])
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [r, g, b, a] = pixel(image, x, y)
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          const checker = ((dx < cell / 2) !== (dy < cell / 2)) ? 204 : 255
          const mix = (channel: number) => Math.round((channel * a + checker * (255 - a)) / 255)
          setPixel(view, margin + x * cell + dx, margin + y * cell + dy, [mix(r), mix(g), mix(b), 255])
        }
      }
    }
  }
  if (showGrid) {
    const line: [number, number, number, number] = [96, 96, 104, 255]
    const major: [number, number, number, number] = [255, 64, 64, 255]
    for (let x = 0; x <= image.width; x++) fillRect(view, margin + x * cell, margin, 1, image.height * cell + 1, x % 8 === 0 ? major : line)
    for (let y = 0; y <= image.height; y++) fillRect(view, margin, margin + y * cell, image.width * cell + 1, 1, y % 8 === 0 ? major : line)
    const step = cell * labelScale >= 12 ? 1 : cell >= 8 ? 2 : 4
    const label: [number, number, number, number] = [230, 230, 230, 255]
    for (let x = 0; x < image.width; x += step) {
      drawNumber(view, x, margin + x * cell + Math.floor((cell - numberWidth(x, labelScale)) / 2), Math.floor((margin - 5 * labelScale) / 2), labelScale, label)
    }
    for (let y = 0; y < image.height; y += step) {
      drawNumber(view, y, Math.floor((margin - numberWidth(y, labelScale)) / 2), margin + y * cell + Math.floor((cell - 5 * labelScale) / 2), labelScale, label)
    }
  }
  const { palette, keyOf, transparent } = analyzePalette(image)
  const grid = image.width <= GRID_TEXT_LIMIT && image.height <= GRID_TEXT_LIMIT ? textureGrid(image, keyOf) : null
  const lines = [
    `尺寸 ${image.width}×${image.height}，放大 ${cell} 倍（最近邻）${showGrid ? '，网格每 8 格红线，坐标从左上角 0,0 起' : ''}`,
    `透明像素 ${transparent}，不同颜色 ${palette.length}${palette.length > KEYS.length ? `（超出 ${KEYS.length} 种的记为 ?）` : ''}`,
    '调色板（键 颜色 像素数）：',
    ...palette.slice(0, 80).map((entry) => `  ${entry.key} ${entry.hex} ×${entry.count}`)
  ]
  if (grid) lines.push('像素图（. 为全透明，每行是 y，从左到右是 x）：', ...grid.map((row, y) => `${String(y).padStart(3)} ${row}`))
  return { png: encodePng(view), width, height, cell, palette, grid, transparentPixels: transparent, text: lines.join('\n') }
}

export function parseHexColor(value: string): [number, number, number, number] {
  const match = value.trim().match(/^#?([0-9a-f]{6})([0-9a-f]{2})?$/i)
  if (!match) throw new Error(`颜色格式不对：${value}（用 #rrggbb 或 #rrggbbaa）`)
  const rgb = Number.parseInt(match[1], 16)
  return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff, match[2] ? Number.parseInt(match[2], 16) : 255]
}

export function imageFromGrid(grid: string[], palette: Record<string, string>): RgbaImage {
  if (!grid.length) throw new Error('像素图不能为空')
  const width = grid[0].length
  if (!width || grid.some((row) => row.length !== width)) throw new Error('像素图每一行长度必须相同')
  const colors = new Map<string, [number, number, number, number]>()
  for (const [key, value] of Object.entries(palette)) {
    if ([...key].length !== 1) throw new Error(`调色板的键必须是单个字符：${key}`)
    colors.set(key, parseHexColor(value))
  }
  const image = createImage(width, grid.length)
  grid.forEach((row, y) => {
    ;[...row].forEach((char, x) => {
      if (char === '.' || char === ' ') return
      const color = colors.get(char)
      if (!color) throw new Error(`第 ${y} 行第 ${x} 列的字符 ${char} 不在调色板里`)
      setPixel(image, x, y, color)
    })
  })
  return image
}

export function exampleItemTexture(): RgbaImage {
  const image = createImage(16, 16)
  const outline: [number, number, number, number] = [40, 30, 60, 255]
  const body: [number, number, number, number] = [92, 70, 160, 255]
  const shine: [number, number, number, number] = [180, 160, 240, 255]
  for (let y = 3; y <= 12; y++) {
    for (let x = 3; x <= 12; x++) {
      const edge = x === 3 || x === 12 || y === 3 || y === 12
      setPixel(image, x, y, edge ? outline : body)
    }
  }
  fillRect(image, 5, 5, 2, 2, shine)
  return image
}
