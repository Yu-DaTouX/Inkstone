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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

const mark = (size, color) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none" style="color:${color}">${source}</svg>`

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
<div class="mark">${mark(72, DARK.accent)}</div>
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
${mark(30, LIGHT.accent)}`

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
  app.exit(0)
})
