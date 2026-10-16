#!/usr/bin/env npx electron
import './lib/stdio-guard.mjs'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESIGN_PATH,
  GEOMETRY_OUT,
  MANIFEST_NAME,
  SVG_OUT,
  buildManifest,
  dedupedFrames,
  readDesign,
  renderGeometryModule,
  renderSvg,
  trayFilePath,
  validateDesign
} from './lib/brand.mjs'
import { syncBootBrand } from './design/sync-boot-brand.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.error('build-icon 需要真实的 Electron（离屏渲染）。请先 `unset ELECTRON_RUN_AS_NODE` 再运行。')
  process.exit(1)
}

const { design, hash } = readDesign(join(root, DESIGN_PATH))
validateDesign(design)
const colors = design.colors

const boot = syncBootBrand({ root, design, checkOnly })

const maskGrids = {}
for (const [key, mask] of Object.entries(design.masks)) {
  maskGrids[key] = mask
}

function cellsFor(gridKey, symbolLayer) {
  const mask = maskGrids[String(gridKey)]
  const cells = []
  mask.frame.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] !== '.') cells.push({ x, y, layer: 'frame' })
  })
  mask[symbolLayer].forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] !== '.') cells.push({ x, y, layer: 'symbol' })
  })
  return cells
}

function gridForPx(px) {
  return String(px) === '24' ? 24 : 16
}

function trayJob(sizePx, theme, symbolLayer, alpha01) {
  const grid = gridForPx(sizePx)
  const symbol = theme === 'on-dark' ? colors.trayOnDark : colors.trayOnLight
  return {
    kind: 'tray',
    size: sizePx,
    grid,
    alpha: alpha01,
    cells: cellsFor(grid, symbolLayer),
    fills: { frame: symbol, symbol }
  }
}

function pixelTileJob(sizePx, grid) {
  return {
    kind: 'pixel-tile',
    size: sizePx,
    grid,
    alpha: 1,
    cells: cellsFor(grid, 'prompt'),
    fills: { tile: colors.tile, rim: colors.rim, frame: colors.frame, symbol: colors.accent }
  }
}

async function main() {
  const { app, BrowserWindow } = await import('electron')
  const userData = mkdtempSync(join(tmpdir(), 'inkstone-icon-'))
  app.setPath('userData', userData)
  await app.whenReady()
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  try {
    await win.loadURL('data:text/html,<html><body></body></html>')

    const icoSizes = design.outputs.icoSizes
    const gridOf = (size) => (size === 16 || size === 32 ? 16 : size === 24 ? 24 : 0)

    const jobs = []
    const targets = []
    const addJob = (job, target) => {
      jobs.push(job)
      targets.push(target)
    }

    for (const size of icoSizes) {
      const grid = gridOf(size)
      addJob(grid ? pixelTileJob(size, grid) : { kind: 'tile', size }, { type: 'ico', size })
    }
    addJob({ kind: 'tile', size: design.outputs.iconPng }, { type: 'iconPng' })

    const traySizes = design.outputs.traySizes
    for (const theme of design.outputs.trayThemes) {
      for (const { px } of traySizes) {
        addJob(trayJob(px, theme, 'prompt', 1), { type: 'tray', rel: trayFilePath(design, theme, px, 'idle', 0, 'static-idle') })
        addJob(trayJob(px, theme, 'question', 1), { type: 'tray', rel: trayFilePath(design, theme, px, 'waiting', 0, 'static-waiting') })
      }
    }

    for (const state of ['running', 'waiting']) {
      const spec = design.animation.states[state]
      dedupedFrames(design, state).forEach((frame, index) => {
        const alpha01 = frame.alpha255 / 255
        for (const theme of design.outputs.trayThemes) {
          for (const { px } of traySizes) {
            addJob(trayJob(px, theme, spec.symbol, alpha01), { type: 'tray', rel: trayFilePath(design, theme, px, state, index) })
          }
        }
      })
    }

    const svgDataUrl =
      'data:image/svg+xml;base64,' +
      Buffer.from(renderSvg(design, { frame: colors.frame, accent: colors.accent }), 'utf8').toString('base64')

    const rendered = await win.webContents.executeJavaScript(`${RENDER}(${JSON.stringify(jobs)}, ${JSON.stringify(svgDataUrl)}, ${JSON.stringify(colors)})`)
    const pngs = rendered.map((b64) => Buffer.from(b64, 'base64'))
    if (pngs.length !== jobs.length) throw new Error(`渲染帧数不符：期望 ${jobs.length}，实际 ${pngs.length}`)

    const ico = icoSizes.map((size) => ({ size, data: pngs[targets.findIndex((t) => t.type === 'ico' && t.size === size)] }))
    const outputs = [
      { rel: SVG_OUT, data: Buffer.from(renderSvg(design), 'utf8') },
      { rel: GEOMETRY_OUT, data: Buffer.from(renderGeometryModule(design, hash), 'utf8') },
      { rel: `build/tray/${MANIFEST_NAME}`, data: Buffer.from(`${JSON.stringify(buildManifest(design, hash), null, 2)}\n`, 'utf8') },
      { rel: 'build/icon.png', data: pngs[targets.findIndex((t) => t.type === 'iconPng')] },
      { rel: 'build/icon.ico', data: icoFromPngs(ico) }
    ]
    targets.forEach((target, i) => {
      if (target.type === 'tray') outputs.push({ rel: `build/tray/${target.rel}`, data: pngs[i] })
    })

    writeOrCheck(outputs)
    await report(outputs, boot)
  } finally {
    win.destroy()
    try {
      rmSync(userData, { recursive: true, force: true })
    } catch {
    }
    app.exit(0)
  }
}

function writeOrCheck(outputs) {
  for (const { rel, data } of outputs) {
    const abs = join(root, rel)
    if (checkOnly) {
      let existing
      try {
        existing = readFileSync(abs)
      } catch {
        throw new Error(`check:brand 缺失产物 ${rel}（先运行 npm run icon）`)
      }
      if (!existing.equals(data)) throw new Error(`check:brand 产物与真源不一致：${rel}`)
    } else {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, data)
    }
  }
}

async function report(outputs, boot) {
  if (checkOnly) {
    console.log(`check:brand 通过：${outputs.length} 个产物与真源一致（source ${hash.slice(0, 12)}），启动画面投影 ${boot.rel} 一致`)
  } else {
    const tray = outputs.filter((o) => o.rel.startsWith('build/tray/tray-')).length
    console.log(
      `写入品牌素材：${SVG_OUT}、build/icon.ico（${design.outputs.icoSizes.join('/')}）、build/icon.png（${design.outputs.iconPng}）、` +
        `build/tray/（${tray} 张，含去重动画帧）、${MANIFEST_NAME}、${GEOMETRY_OUT}（source ${hash.slice(0, 12)}）、` +
        `启动画面投影 ${boot.rel}${boot.changed ? '（已更新）' : '（无变化）'}`
    )
  }
}

function icoFromPngs(entries) {
  const count = entries.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  const dir = Buffer.alloc(16 * count)
  let offset = 6 + 16 * count
  entries.forEach(({ size, data }, i) => {
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
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)])
}

const RENDER = `(async (jobs, svgUrl, B) => {
  const img = new Image()
  img.src = svgUrl
  await img.decode()
  const tile = (ctx, size, radius) => {
    ctx.beginPath(); ctx.roundRect(0, 0, size, size, radius); ctx.fillStyle = B.tile; ctx.fill()
    const w = Math.max(1, size / 100)
    ctx.beginPath(); ctx.roundRect(w / 2, w / 2, size - w, size - w, radius - w / 2); ctx.strokeStyle = B.rim; ctx.lineWidth = w; ctx.stroke()
  }
  const cells = (ctx, job) => {
    const k = job.size / job.grid
    for (const cell of job.cells) {
      ctx.globalAlpha = cell.layer === 'frame' ? 1 : job.alpha
      ctx.fillStyle = cell.layer === 'frame' ? job.fills.frame : job.fills.symbol
      const x0 = Math.round(cell.x * k), y0 = Math.round(cell.y * k)
      ctx.fillRect(x0, y0, Math.round((cell.x + 1) * k) - x0, Math.round((cell.y + 1) * k) - y0)
    }
    ctx.globalAlpha = 1
  }
  return jobs.map((job) => {
    const c = document.createElement('canvas'); c.width = c.height = job.size
    const ctx = c.getContext('2d')
    if (job.kind === 'tile') {
      tile(ctx, job.size, job.size * 0.22)
      const scale = job.size <= 24 ? 75 / 56 : 1
      const d = job.size * scale, o = (job.size - d) / 2
      ctx.drawImage(img, o, o, d, d)
    } else {
      if (job.kind === 'pixel-tile') tile(ctx, job.size, job.size * 0.22)
      cells(ctx, job)
    }
    return c.toDataURL('image/png').split(',')[1]
  })
})`

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
