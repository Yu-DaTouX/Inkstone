#!/usr/bin/env npx electron
/**
 * 品牌素材唯一生成入口（设计规范 §3.4.1）：
 *   build/prompt-stone.svg      几何真源的 currentColor 投影（安装器 / 手机端按分组换色）
 *   build/icon.ico              砖形应用图标，16/20/24/32/40/48/64/128/256
 *   build/icon.png              512 砖形（窗口图标、文档与其它平台）
 *   build/tray/*.png            托盘单色字形：on-light / on-dark 各 16/@1.5x/@2x，
 *                               含 idle / running / waiting 静态与去重动画帧
 *   build/tray/manifest.json    帧文件名 + 真实原生时长（runtime 只读它，不再手写常量）
 *   src/shared/brand-geometry.ts 渲染端品牌组件 import 的几何常量
 *
 * 用法：
 *   npm run icon            重新生成上述产物
 *   npm run check:brand     只校验产物与真源一致（--check），**不写任何文件**
 *
 * 几何、像素 mask、配色、透明度与缓动、各状态四段时长**只在**
 * `resources/brand/inkstone-design.json` 定义；本脚本只做「真源 → 像素」的渲染。
 * 16 与 32（以及托盘 1x/2x）用 16 格像素网格画，24 用 24 格，都是同一几何按 75%
 * 落到整像素上的结果，线条不抗锯齿，任务栏与列表里不会发糊；20 与其余是矢量放大。
 *
 * 为什么用 Electron：项目里已有 Electron，离屏 canvas 能直接渲染 SVG，不必再引图形库。
 * 运行时用独立临时 userData、show:false，绝不碰用户正在使用的砚窗口。
 */
import './lib/stdio-guard.mjs' /* 先装护栏：日志管道断了也不能弹框/挂死（见该文件头注释） */
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

/* 启动画面是静态 HTML 里的内联 SVG，必须随图标生成入口一起写入/校验（见 sync-boot-brand.mjs）。 */
const boot = syncBootBrand({ root, design, checkOnly })

/* ───────────────────────── 渲染作业（纯数据） ───────────────────────── */

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

/** 托盘（无砖、单色）单元作业：theme 决定字形色，alpha 决定符号透明度。 */
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

/** 砖形像素作业（小尺寸 icon.ico 档）：底砖 + 框 + 强调色提示符。 */
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

    /* 尺寸档：ico 16/32 用 16 格、24 用 24 格；其余矢量。 */
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

    /* 静态托盘：idle / running（=idle，>_ 亮态）/ waiting（? 亮态）。 */
    const traySizes = design.outputs.traySizes
    for (const theme of design.outputs.trayThemes) {
      for (const { px } of traySizes) {
        addJob(trayJob(px, theme, 'prompt', 1), { type: 'tray', rel: trayFilePath(design, theme, px, 'idle', 0, 'static-idle') })
        addJob(trayJob(px, theme, 'question', 1), { type: 'tray', rel: trayFilePath(design, theme, px, 'waiting', 0, 'static-waiting') })
      }
    }

    /* 动画帧：每个状态按去重后的真实时长出一批帧；帧内符号 alpha 来自真源。 */
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
      /* Electron 子进程释放句柄前偶发 EPERM；目录在系统临时区，留给 OS 回收。 */
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

/** ICO 容器打包多张 PNG（Vista 起 ICO 允许内嵌 PNG 数据） */
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

/*
 * 离屏页面里的渲染器：job 见 trayJob / pixelTileJob 的构造。
 * 只用 canvas 2D，逐格 fillRect，不做抗锯齿；符号透明度由 job.alpha 提供。
 */
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
