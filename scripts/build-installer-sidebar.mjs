#!/usr/bin/env npx electron
/**
 * 生成 NSIS 安装器的品牌图：欢迎 / 完成页侧栏（164×314）与内页页眉（150×57）。
 *
 * 配色与应用界面同源（v0.4 设计规范，见 docs/DESIGN_SYSTEM.md）：
 *   · 侧栏 = 深色主题的窗口底 `--bg-0` + 靛蓝强调 `--accent` 的提示砚标志；
 *   · 页眉 = NSIS 内页本身是白底，所以用浅色主题的底与强调色。
 * 平色，不用发光与渐变 —— 安装器是用户对砚的第一眼，应当和打开后的界面一致。
 *
 * NSIS 只接受 24-bit BMP：有 ffmpeg 时本脚本直接转换并写入 build/*.bmp，
 * 没有时只写 PNG，并提示手动转换。
 *
 * 用法：npm run installer:sidebar
 */
import './lib/stdio-guard.mjs'
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const source = readFileSync(join(buildDir, 'prompt-stone.svg'), 'utf8')
  .replace(/^\s*<svg\b[^>]*>/i, '')
  .replace(/<\/svg>\s*$/i, '')
  .replace(/<title>[\s\S]*?<\/title>/i, '')

/* 与 src/renderer/src/styles/tokens.css 保持一致 */
const DARK = { bg: '#151515', line: 'rgba(255,255,255,0.08)', fg: '#ecece8', dim: '#b4b4ac', mute: '#92928a', accent: '#93a4f4' }
const LIGHT = { bg: '#ffffff', fg: '#252522', mute: '#73736b', accent: '#5264c8' }

const FONT = `'Segoe UI', 'Microsoft YaHei UI', system-ui, sans-serif`

/* 品牌资产规范（设计规范 §3.4.1）：石框用前景色、`>_` 用强调色；浅底上用砖形应用图标 */
const colored = (frame, accent) => source
  .replace(/(<g id="stone-frame"[^>]*?)stroke="currentColor"/, `$1stroke="${frame}"`)
  .replace(/(<g id="prompt"[^>]*?)stroke="currentColor"/, `$1stroke="${accent}"`)
const mark = (size, frame, accent) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none">${colored(frame, accent)}</svg>`
const tileMark = (size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none"><rect width="100" height="100" rx="22" fill="${DARK.bg}"/><rect x="0.5" y="0.5" width="99" height="99" rx="21.5" stroke="#2c2c29"/><g transform="translate(50 50) scale(1.2) translate(-50 -50)">${colored(DARK.fg, DARK.accent)}</g></svg>`

const sidebarHtml = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 164px; height: 314px; overflow: hidden; background: ${DARK.bg}; }
  body { position: relative; font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
  .mark { position: absolute; left: 22px; top: 56px; }
  .name { position: absolute; left: 28px; top: 150px; color: ${DARK.fg}; font-size: 30px; font-weight: 600; letter-spacing: 0.02em; }
  .en { position: absolute; left: 29px; top: 192px; color: ${DARK.mute}; font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase; }
  .rule { position: absolute; left: 28px; right: 28px; top: 262px; height: 1px; background: ${DARK.line}; }
  .slogan { position: absolute; left: 28px; top: 274px; color: ${DARK.dim}; font-size: 12px; letter-spacing: 0.06em; }
</style>
<div class="mark">${mark(72, DARK.fg, DARK.accent)}</div>
<div class="name">砚</div>
<div class="en">Inkstone</div>
<div class="rule"></div>
<div class="slogan">让想法成形</div>`

const headerHtml = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 150px; height: 57px; overflow: hidden; background: ${LIGHT.bg}; }
  body { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-right: 14px; box-sizing: border-box;
         font-family: ${FONT}; -webkit-font-smoothing: antialiased; }
  .txt { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.1; }
  .name { color: ${LIGHT.fg}; font-size: 16px; font-weight: 600; }
  .en { color: ${LIGHT.mute}; font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase; margin-top: 3px; }
</style>
<div class="txt"><span class="name">砚</span><span class="en">Inkstone</span></div>
${tileMark(32)}`

/*
 * 欢迎页动画帧（build/installer-anim/frame-NN.bmp，installer.nsh 的 nsDialogs 定时器逐帧换图）：
 * 与启动画面同一段：石框描出 → `>` → 光标出现，之后光标在最后两帧间呼吸。
 */
const DRAW_FRAMES = 12
const animFrameHtml = (index) => {
  const t = Math.min(1, index / (DRAW_FRAMES - 1))
  const loop = index >= DRAW_FRAMES
  const prompt = t >= 0.75 ? 1 : 0
  const cursor = loop ? (index === DRAW_FRAMES ? 0.35 : 1) : t >= 1 ? 1 : 0
  const svg = `<svg width="72" height="72" viewBox="0 0 100 100" fill="none">
    <path pathLength="1" d="M70 22H25Q22 22 22 25V75Q22 78 25 78H75Q78 78 78 75V53" stroke="${DARK.fg}" stroke-width="6" stroke-linejoin="round" stroke-dasharray="1" stroke-dashoffset="${1 - t}"/>
    <path d="M36 40L47 50L36 60" stroke="${DARK.accent}" stroke-width="6" stroke-linecap="square" stroke-linejoin="miter" opacity="${prompt}"/>
    <path d="M57 62H69" stroke="${DARK.accent}" stroke-width="6" stroke-linecap="square" opacity="${cursor}"/></svg>`
  return sidebarHtml.replace(/<div class="mark">[\s\S]*?<\/div>/, `<div class="mark">${svg}</div>`)
}

app.commandLine.appendSwitch('force-device-scale-factor', '1')
/* 逐张渲染：关掉上一张的窗口时不能让应用按默认行为退出 */
app.on('window-all-closed', () => {})
/* 位图里不能带 ClearType 彩边：它按屏幕子像素排布渲染，缩放或换屏后就是色边 */
app.commandLine.appendSwitch('disable-lcd-text')

async function render(html, width, height, name) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false }
  })
  /* data URL：连续两个窗口 loadFile 同目录临时文件时，第二次会偶发 ERR_FAILED */
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const png = (await win.webContents.capturePage()).toPNG()
  win.destroy()
  const pngPath = join(buildDir, `${name}-generated.png`)
  writeFileSync(pngPath, png)
  return pngPath
}

function toBmp(pngPath, bmpPath) {
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', pngPath, '-pix_fmt', 'bgr24', bmpPath], { stdio: 'inherit' })
    return true
  } catch {
    return false
  }
}

app.whenReady().then(async () => {
  mkdirSync(buildDir, { recursive: true })
  const outputs = [
    { html: sidebarHtml, w: 164, h: 314, name: 'installer-sidebar', bmp: 'installerSidebar.bmp' },
    { html: headerHtml, w: 150, h: 57, name: 'installer-header', bmp: 'installerHeader.bmp' }
  ]
  for (const item of outputs) {
    const png = await render(item.html, item.w, item.h, item.name)
    const bmp = join(buildDir, item.bmp)
    if (toBmp(png, bmp)) console.log(`写入 build/${item.bmp}（${item.w}×${item.h}，24-bit）`)
    else console.log(`写入 ${png}；未找到 ffmpeg，请手动转换为 24-bit BMP：build/${item.bmp}`)
  }
  const animDir = join(buildDir, 'installer-anim')
  mkdirSync(animDir, { recursive: true })
  for (let i = 0; i < DRAW_FRAMES + 1; i++) {
    const name = 'frame-' + String(i).padStart(2, '0')
    const png = await render(animFrameHtml(i), 164, 314, 'installer-anim/' + name)
    if (!toBmp(png, join(animDir, name + '.bmp'))) console.log('未找到 ffmpeg，动画帧只写了 PNG：' + png)
  }
  /* 中间 PNG 只是转换用，不留在 build/ 里 */
  for (const f of readdirSync(animDir)) if (f.endsWith('-generated.png')) fs.unlinkSync(join(animDir, f))
  console.log(`写入 build/installer-anim/（${DRAW_FRAMES + 1} 帧）`)
  app.exit(0)
})
