#!/usr/bin/env npx electron
/**
 * 生成应用图标 → build/icon.ico（多尺寸）+ build/icon.png（512，留作其它平台/文档）。
 *
 * 用法：npm run icon
 *
 * 为什么用 Electron 而不是引一个图形库：项目里已经有 Electron 了，
 * 用它离屏渲染 SVG 再截图，零新增依赖，且字面路径与真实渲染一致。
 *
 * 图案：深色圆角方块 + 青色四角星（＝「砚」在对话里的角色符号 ✦）。
 * 不用「砚」字本身，是因为任务栏/开始菜单里最小会缩到 16px，
 * 汉字在那个尺寸会糊成一团；四角星在 16px 下仍可辨认。
 */
import { app, BrowserWindow, nativeImage } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')

// 令牌取自 src/renderer/src/styles/tokens.css（深色主题）：--bg-0 / --fact
const BG = '#0b0d0e'
const EDGE = '#22303a'
const STAR = '#22d3ee'

const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="104" ry="104" fill="${BG}"/>
  <rect x="16.75" y="16.75" width="478.5" height="478.5" rx="103.25" ry="103.25"
        fill="none" stroke="${EDGE}" stroke-width="1.5"/>
  <path d="M256 92
           C 268 190, 322 244, 420 256
           C 322 268, 268 322, 256 420
           C 244 322, 190 268, 92 256
           C 190 244, 244 190, 256 92 Z"
        fill="${STAR}"/>
</svg>`

const html = (size) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
${svg(size)}`

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

/** 渲染一次 512×512（用系统临时目录里的 html 文件，避开 data URL 的偶发 ERR_FAILED） */
async function renderBase() {
  const tmpHtml = join(app.getPath('temp'), 'yan-icon.html')
  writeFileSync(tmpHtml, html(512), 'utf8')
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false }
  })
  await win.loadFile(tmpHtml)
  // 等一帧，确保 SVG 已经画完（capturePage 不会等渲染）
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage()
  win.destroy()
  return img
}

app.commandLine.appendSwitch('force-device-scale-factor', '1')

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true })

  // 只渲染一次 512，再用 nativeImage.resize 出各尺寸
  // （连续创建 offscreen 小窗口会在第二个起 ERR_FAILED，实测踩到）
  const base = await renderBase()
  const b512 = base.toPNG()
  writeFileSync(join(outDir, 'icon.png'), b512)

  const sizes = [16, 32, 48, 64, 128, 256]
  const pngs = sizes.map((size) => {
    const data = base.resize({ width: size, height: size, quality: 'best' }).toPNG()
    console.log(`  ✓ ${size}×${size}  ${data.length} bytes`)
    return { size, data }
  })

  writeFileSync(join(outDir, 'icon.ico'), icoFromPngs(pngs))
  console.log(`\n写入 build/icon.ico（${sizes.join('/')}）+ build/icon.png（512）`)

  app.exit(0)
})
