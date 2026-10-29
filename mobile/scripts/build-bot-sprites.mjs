import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(mobile, '..')
const outDir = join(mobile, 'src', 'assets', 'bots')
const manifest = join(mobile, 'src', 'botSprites.generated.ts')

const CELL = 84
const SIZE = 28
const SEED = 2.1
const THEMES = ['dark', 'light']
const ROWS = [
  { mood: 'work', seconds: 4.8, fps: 10 },
  { mood: 'ask', seconds: 3.8, fps: 10 },
  { mood: 'wake' },
  { mood: 'done' },
  { mood: 'fail' },
  { mood: 'rest' }
]

const bundle = await build({
  stdin: {
    contents: `export { BOT_FORMS, MONO_INK, drawBot, luminance, poseAt } from './src/renderer/src/patterns/model-bot/draw'\nexport { MODEL_BRANDS } from './src/shared/model-brand'`,
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  format: 'iife',
  globalName: 'BotDraw',
  platform: 'browser',
  write: false,
  logLevel: 'error'
})

function renderSheets(cell, size, seed, themes, rows) {
  const { BOT_FORMS, MONO_INK, MODEL_BRANDS, drawBot, luminance, poseAt } = window.BotDraw
  const load = (url) => new Promise((done, fail) => { const image = new Image(); image.onload = () => done(image); image.onerror = fail; image.src = url })
  const tint = (image, ink) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    ctx.globalCompositeOperation = 'source-in'
    ctx.fillStyle = ink
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    return canvas
  }
  const columns = Math.max(...rows.map((row) => row.seconds ? Math.round(row.seconds * row.fps) : 1))
  return (async () => {
    const sheets = []
    for (const brand of MODEL_BRANDS) {
      const form = BOT_FORMS[brand] ?? BOT_FORMS.pi
      const art = await load(form.art)
      const field = form.field ? await load(form.field) : null
      for (const theme of themes) {
        const paint = form.mono ? MONO_INK[theme] : form.paint ?? MONO_INK[theme]
        const look = { form, paint, ink: MONO_INK[theme], dark: luminance(paint) < 0.35, art: form.mono ? tint(art, paint) : art, field }
        const sheet = document.createElement('canvas')
        sheet.width = columns * cell
        sheet.height = rows.length * cell
        const sheetCtx = sheet.getContext('2d')
        const frame = document.createElement('canvas')
        frame.width = frame.height = cell
        const ctx = frame.getContext('2d')
        rows.forEach((row, y) => {
          const count = row.seconds ? Math.round(row.seconds * row.fps) : 1
          for (let x = 0; x < count; x++) {
            const t = row.seconds ? x / row.fps : 100
            const pose = poseAt(row.mood, form, { t, seed, since: t - 100, entrance: false, restTurn: 0, still: false, size })
            pose.turn = 0
            drawBot(ctx, look, cell, pose, false)
            sheetCtx.drawImage(frame, x * cell, y * cell)
          }
        })
        sheets.push({ brand, theme, png: sheet.toDataURL('image/png') })
      }
    }
    return sheets
  })()
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  try {
    await window.loadURL('data:text/html,<html><body></body></html>')
    await window.webContents.executeJavaScript(bundle.outputFiles[0].text)
    const sheets = await window.webContents.executeJavaScript(`(${renderSheets.toString()})(${CELL}, ${SIZE}, ${SEED}, ${JSON.stringify(THEMES)}, ${JSON.stringify(ROWS)})`)
    mkdirSync(outDir, { recursive: true })
    for (const { brand, theme, png } of sheets) writeFileSync(join(outDir, `${brand}-${theme}.png`), Buffer.from(png.split(',')[1], 'base64'))
    const rows = Object.fromEntries(ROWS.map((row, index) => [row.mood, { row: index, frames: row.seconds ? Math.round(row.seconds * row.fps) : 1, fps: row.fps ?? 0 }]))
    const lines = [
      `export const BOT_CELL = ${CELL}`,
      `export const BOT_COLUMNS = ${Math.max(...Object.values(rows).map((row) => row.frames))}`,
      `export const BOT_ROW_COUNT = ${ROWS.length}`,
      `export const BOT_ROWS = ${JSON.stringify(rows)} as const`,
      'export type BotSpriteMood = keyof typeof BOT_ROWS',
      'export const BOT_SHEETS: Record<string, number> = {',
      ...sheets.map(({ brand, theme }) => `  '${brand}-${theme}': require('./assets/bots/${brand}-${theme}.png'),`),
      '}',
      ''
    ]
    writeFileSync(manifest, lines.join('\n'))
    console.log(`Rendered ${sheets.length} model bot sprite sheets from src/renderer/src/patterns/model-bot`)
  } finally {
    window.destroy()
    app.quit()
  }
}).catch((error) => { console.error(error); app.exit(1) })
