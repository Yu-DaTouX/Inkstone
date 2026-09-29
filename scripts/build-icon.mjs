#!/usr/bin/env npx electron
/**
 * 生成桌面外壳图标（设计规范 §3.4.1）：
 *   build/icon.ico   砖形应用图标，16/20/24/32/40/48/64/128/256
 *   build/icon.png   512 砖形（窗口图标、文档与其它平台）
 *   build/tray/      托盘单色字形：on-dark（浅色字形，给深色任务栏）/ on-light，各 @1x/@1.5x/@2x
 *
 * 用法：npm run icon
 *
 * 几何只认 build/prompt-stone.svg：大尺寸直接渲染那份矢量；16 与 32（以及托盘）
 * 用 16 格像素网格画，24（以及托盘 1.5 倍）用 24 格——都是同一几何按 75% 落到
 * 整像素上的结果，线条不抗锯齿，任务栏与列表里不会发糊。20 是矢量放大到 75% 渲染。
 *
 * 为什么用 Electron：项目里已有 Electron，离屏 canvas 能直接渲染 SVG，不必再引图形库。
 */
import './lib/stdio-guard.mjs'  /* 先装护栏：日志管道断了也不能弹框/挂死（见该文件头注释） */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')

/* 品牌配色（设计规范 §3.4.1 的表） */
export const BRAND = { tile: '#151515', rim: '#2c2c29', frame: '#ecece8', accent: '#93a4f4', trayOnLight: '#1b1b1a' }

/*
 * 16 格像素字形：F = 石框，A = 提示符 `>_`。石框占 2..13 列/行（75%），
 * 顶边在第 10 列断开、右边从第 8 行起，对应矢量的右上开口。
 */
const GLYPH = [
  '................',
  '................',
  '..FFFFFFFFF.....',
  '..F.............',
  '..F.............',
  '..F..A..........',
  '..F...A.........',
  '..F....A........',
  '..F...A......F..',
  '..F..A.......F..',
  '..F......AAA.F..',
  '..F..........F..',
  '..F..........F..',
  '..FFFFFFFFFFFF..',
  '................',
  '................'
]

/*
 * 24 格像素字形（线宽 2px），用于 24：Win11 任务栏 100% 缩放下正是 24px，
 * 这一档最常被看到，单独画而不是矢量缩放。外角各去 1 像素，对应矢量的圆角转折。
 */
const GLYPH24 = [
  '........................',
  '........................',
  '........................',
  '....FFFFFFFFFFFFFF......',
  '...FFFFFFFFFFFFFFF......',
  '...FF...................',
  '...FF...................',
  '...FF...................',
  '...FF...................',
  '...FF...AA..............',
  '...FF....AA.............',
  '...FF.....AA............',
  '...FF......AA...........',
  '...FF.....AA.......FF...',
  '...FF....AA........FF...',
  '...FF...AA....AAAA.FF...',
  '...FF.........AAAA.FF...',
  '...FF..............FF...',
  '...FF..............FF...',
  '...FFFFFFFFFFFFFFFFFF...',
  '....FFFFFFFFFFFFFFFF....',
  '........................',
  '........................',
  '........................'
]

/** 源 SVG：石框与提示符分组上色 */
function markSvg(frame, accent) {
  return readFileSync(join(outDir, 'prompt-stone.svg'), 'utf8')
    .replace(/(<g id="stone-frame"[^>]*?)stroke="currentColor"/, `$1stroke="${frame}"`)
    .replace(/(<g id="prompt"[^>]*?)stroke="currentColor"/, `$1stroke="${accent}"`)
}

/** ICO 容器打包多张 PNG（Vista 起 ICO 允许内嵌 PNG 数据） */
function icoFromPngs(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, e + 0)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt8(0, e + 2)
    dir.writeUInt8(0, e + 3)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)])
}

/*
 * 在离屏页面里画：job = { kind: 'tile' | 'pixel-tile' | 'tray', size, color? }
 * 返回 PNG 的 base64。
 */
const RENDER = `(async (jobs, svg, glyphs, B) => {
  const img = new Image()
  img.src = svg
  await img.decode()
  const tile = (ctx, size, radius) => {
    ctx.beginPath(); ctx.roundRect(0, 0, size, size, radius); ctx.fillStyle = B.tile; ctx.fill()
    const w = Math.max(1, size / 100)
    ctx.beginPath(); ctx.roundRect(w / 2, w / 2, size - w, size - w, radius - w / 2); ctx.strokeStyle = B.rim; ctx.lineWidth = w; ctx.stroke()
  }
  return jobs.map(({ kind, size, color, grid }) => {
    const c = document.createElement('canvas'); c.width = c.height = size
    const ctx = c.getContext('2d')
    if (kind === 'tile') {
      tile(ctx, size, size * 0.22)
      /* 标志几何 22..78 占 56%；小尺寸放大到 75% */
      const scale = size <= 24 ? 75 / 56 : 1
      const d = size * scale, o = (size - d) / 2
      ctx.drawImage(img, o, o, d, d)
    } else {
      const glyph = glyphs[grid]
      const k = size / grid
      if (kind === 'pixel-tile') tile(ctx, size, size * 0.22)
      glyph.forEach((row, y) => [...row].forEach((ch, x) => {
        if (ch === '.') return
        ctx.fillStyle = kind === 'tray' ? color : ch === 'A' ? B.accent : B.frame
        const x0 = Math.round(x * k), y0 = Math.round(y * k)
        ctx.fillRect(x0, y0, Math.round((x + 1) * k) - x0, Math.round((y + 1) * k) - y0)
      }))
    }
    return c.toDataURL('image/png').split(',')[1]
  })
})`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  try {
    await win.loadURL('data:text/html,<html><body></body></html>')
    const render = async (jobs) =>
      (await win.webContents.executeJavaScript(`${RENDER}(${JSON.stringify(jobs)}, ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(markSvg(BRAND.frame, BRAND.accent)).toString('base64')}`)}, ${JSON.stringify({ 16: GLYPH, 24: GLYPH24 })}, ${JSON.stringify(BRAND)})`))
        .map((b64) => Buffer.from(b64, 'base64'))

    mkdirSync(join(outDir, 'tray'), { recursive: true })

    const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    /* 16/32 用 16 格，24 用 24 格（整数倍，像素对齐）；其余矢量 */
    const gridOf = (size) => (size === 16 || size === 32 ? 16 : size === 24 ? 24 : 0)
    const icoJobs = icoSizes.map((size) => (gridOf(size) ? { kind: 'pixel-tile', size, grid: gridOf(size) } : { kind: 'tile', size }))
    const icoPngs = (await render(icoJobs)).map((data, i) => ({ size: icoSizes[i], data }))
    writeFileSync(join(outDir, 'icon.ico'), icoFromPngs(icoPngs))
    const [png512] = await render([{ kind: 'tile', size: 512 }])
    writeFileSync(join(outDir, 'icon.png'), png512)

    /* 托盘：Electron 按 @1.5x/@2x 后缀自动挑 DPI；1x/2x 用 16 格，1.5x 用 24 格，三档都像素对齐 */
    const trays = []
    for (const [name, color] of [['on-dark', BRAND.frame], ['on-light', BRAND.trayOnLight]]) {
      for (const [suffix, size] of [['', 16], ['@1.5x', 24], ['@2x', 32]]) trays.push({ file: `tray-${name}${suffix}.png`, job: { kind: 'tray', size, color, grid: size === 24 ? 24 : 16 } })
    }
    const trayPngs = await render(trays.map((t) => t.job))
    trays.forEach((t, i) => writeFileSync(join(outDir, 'tray', t.file), trayPngs[i]))

    console.log(`写入 build/icon.ico（${icoSizes.join('/')}）、build/icon.png（512）、build/tray/（${trays.length} 张）`)
  } finally {
    win.destroy()
    app.exit(0)
  }
}).catch((error) => { console.error(error); app.exit(1) })
