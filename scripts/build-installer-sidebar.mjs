#!/usr/bin/env npx electron
/**
 * 用统一的 prompt-stone 品牌图标生成 NSIS 侧栏 PNG。
 * BMP 转换由发布环境里的 ffmpeg 完成；NSIS 最终固定使用 164×314、24-bit BMP。
 */
import './lib/stdio-guard.mjs'
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const source = readFileSync(join(buildDir, 'prompt-stone.svg'), 'utf8')
  .replace(/^\s*<svg\b[^>]*>/i, '')
  .replace(/<\/svg>\s*$/i, '')

const mark = (x, y, size, opacity = 1) => `
  <svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 100 100"
       fill="none" color="#22d3ee" opacity="${opacity}">${source}</svg>`

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: 164px; height: 314px; overflow: hidden; background: #080b0d; }
  body { position: relative; }
  .glow { position: absolute; inset: 0; background:
    radial-gradient(circle at 50% 34%, rgba(34,211,238,.18), transparent 34%),
    linear-gradient(155deg, #101a20 0%, #080b0d 52%, #050708 100%); }
  svg { position: absolute; }
</style>
<div class="glow"></div>
<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314" aria-label="砚 · 提示砚">
  ${mark(24, 78, 116)}
  ${mark(23, 196, 118, .055)}
  <rect x="24" y="285" width="116" height="1" fill="rgba(34,211,238,.32)"/>
</svg>`

app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.whenReady().then(async () => {
  mkdirSync(buildDir, { recursive: true })
  const tmpHtml = join(app.getPath('temp'), 'yan-installer-sidebar.html')
  writeFileSync(tmpHtml, html, 'utf8')
  const win = new BrowserWindow({
    width: 164,
    height: 314,
    show: false,
    frame: false,
    transparent: false,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false }
  })
  await win.loadFile(tmpHtml)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const png = (await win.webContents.capturePage()).toPNG()
  win.destroy()
  writeFileSync(join(buildDir, 'installer-sidebar-generated.png'), png)
  console.log('写入 build/installer-sidebar-generated.png（164×314）')
  app.exit(0)
})
