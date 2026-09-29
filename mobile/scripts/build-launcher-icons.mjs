/** Render Android legacy launcher bitmaps from the canonical prompt-stone SVG.
 * Run with `electron mobile/scripts/build-launcher-icons.mjs` from the repo root.
 * Adaptive icons use the matching vector in res/mipmap-anydpi-v26.
 */
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const mark = readFileSync(new URL('../../build/prompt-stone.svg', import.meta.url), 'utf8')
  /* 品牌资产规范（设计规范 §3.4.1）：与桌面同一块砖——石框前景色、`>_` 强调色 */
  .replace(/(<g id="stone-frame"[^>]*?)stroke="currentColor"/, '$1stroke="#ecece8"')
  .replace(/(<g id="prompt"[^>]*?)stroke="currentColor"/, '$1stroke="#93a4f4"')
const densities = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]
const res = new URL('../android/app/src/main/res/', import.meta.url)

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  try {
    await window.loadURL('data:text/html,<html><body></body></html>')
    const bitmaps = await window.webContents.executeJavaScript(`(async () => {
      const source = new Image()
      source.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(mark).toString('base64')}`)}
      await source.decode()
      return ${JSON.stringify(densities)}.flatMap(([density, size]) =>
        ['ic_launcher', 'ic_launcher_round'].map((name) => {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = size
          const ctx = canvas.getContext('2d')
          ctx.beginPath()
          if (name.endsWith('_round')) ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
          else ctx.roundRect(0, 0, size, size, size * 0.22)
          ctx.clip()
          ctx.fillStyle = '#151515'
          ctx.fillRect(0, 0, size, size)
          /* 圆形遮罩下石框的角离边太近，缩到 86% */
          const d = name.endsWith('_round') ? size * 0.86 : size
          ctx.drawImage(source, (size - d) / 2, (size - d) / 2, d, d)
          ctx.strokeStyle = '#2c2c29'
          ctx.lineWidth = Math.max(1, size / 100)
          ctx.beginPath()
          if (name.endsWith('_round')) ctx.arc(size / 2, size / 2, size / 2 - ctx.lineWidth / 2, 0, Math.PI * 2)
          else ctx.roundRect(ctx.lineWidth / 2, ctx.lineWidth / 2, size - ctx.lineWidth, size - ctx.lineWidth, size * 0.22)
          ctx.stroke()
          return [density, name, canvas.toDataURL('image/png')]
        }))
    })()`)
    for (const [density, name, dataUrl] of bitmaps) {
      writeFileSync(fileURLToPath(new URL(`mipmap-${density}/${name}.png`, res)), Buffer.from(dataUrl.split(',')[1], 'base64'))
    }
    console.log(`Rendered ${bitmaps.length} Android launcher icons from build/prompt-stone.svg`)
  } finally {
    window.destroy()
    app.quit()
  }
}).catch((error) => { console.error(error); app.exit(1) })
