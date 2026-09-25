#!/usr/bin/env npx electron
/**
 * 生成应用图标 → build/icon.ico（多尺寸）+ build/icon.png（512，留作其它平台/文档）。
 *
 * 用法：npm run icon
 *
 * 为什么用 Electron 而不是引一个图形库：项目里已经有 Electron 了，
 * 用 Electron 的 nativeImage 直接绘制 16×16 像素网格，生成各尺寸时保持硬边。
 * 图形沿用「提示砚」的开口方框、提示符和下划线，使用原始黑白配色。
 */
import './lib/stdio-guard.mjs'  /* 先装护栏：日志管道断了也不能弹框/挂死（见该文件头注释） */
import { app, nativeImage } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')

const PIXELS = [
  '0000000000000000',
  '0000000000000000',
  '0001111111110000',
  '0010000000000000',
  '0010000000000000',
  '0010000000000000',
  '0010010000000000',
  '0010001000000000',
  '0010000100000100',
  '0010001000000100',
  '0010010001110100',
  '0010000000000100',
  '0010000000000100',
  '0001111111111000',
  '0000000000000000',
  '0000000000000000'
]

function pixelIcon(size) {
  const bitmap = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = PIXELS[Math.floor(y * 16 / size)][Math.floor(x * 16 / size)] === '1'
      const offset = (y * size + x) * 4
      const value = on ? 255 : 0
      bitmap[offset] = value // BGRA
      bitmap[offset + 1] = value
      bitmap[offset + 2] = value
      /* 关的像素要透出去，不能填成不透明黑底：否则图标是黑方块，
         圆角/异形轮廓在深色任务栏上也糊成一片（check:shell-icons 会拦）。 */
      bitmap[offset + 3] = on ? 255 : 0
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}

/** 用 ICO 容器打包多张 PNG（Vista 起 ICO 允许内嵌 PNG 数据） */
function icoFromPngs(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)

  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e + 0) // 0 表示 256
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt8(0, e + 2) // 调色板数
    dir.writeUInt8(0, e + 3) // reserved
    dir.writeUInt16LE(1, e + 4) // color planes
    dir.writeUInt16LE(32, e + 6) // bits per pixel
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)])
}

app.whenReady().then(() => {
  mkdirSync(outDir, { recursive: true })

  writeFileSync(join(outDir, 'icon.png'), pixelIcon(512).toPNG())

  const sizes = [16, 32, 48, 64, 128, 256]
  const pngs = sizes.map((size) => {
    const data = pixelIcon(size).toPNG()
    console.log(`  ✓ ${size}×${size}  ${data.length} bytes`)
    return { size, data }
  })

  writeFileSync(join(outDir, 'icon.ico'), icoFromPngs(pngs))
  console.log(`\n写入 build/icon.ico（${sizes.join('/')}）+ build/icon.png（512）`)

  app.exit(0)
})
