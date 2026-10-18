import { muteMissingHandlerNoise } from './lib/stdio-guard.mjs'
import { app, BrowserWindow } from 'electron'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'resources', 'bot-icons')
const SIZE = 128
const MOODS = ['done', 'fail', 'ask', 'rest']

async function main() {
  muteMissingHandlerNoise()
  const bundle = await build({
    entryPoints: [join(root, 'scripts', 'lib', 'bot-icon-entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'BotIcons',
    platform: 'browser',
    loader: { '.json': 'json' }
  })
  await app.whenReady()
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('about:blank')
  await win.webContents.executeJavaScript(bundle.outputFiles[0].text)
  const brands = await win.webContents.executeJavaScript('BotIcons.allBrands()')
  const mono = new Set(await win.webContents.executeJavaScript('BotIcons.monoBrands()'))
  await mkdir(OUT, { recursive: true })
  const written = []
  for (const brand of brands) {
    for (const mood of MOODS) {
      for (const theme of mono.has(brand) ? ['light', 'dark'] : [null]) {
        const url = await win.webContents.executeJavaScript(
          `BotIcons.renderBotIcon(${JSON.stringify(brand)}, ${JSON.stringify(mood)}, ${JSON.stringify(theme ?? 'light')}, ${SIZE})`
        )
        const name = theme ? `${brand}-${mood}-${theme}.png` : `${brand}-${mood}.png`
        await writeFile(join(OUT, name), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
        written.push(name)
      }
    }
  }
  console.log(`生成 ${written.length} 个 Bot 通知图标 → ${OUT}`)
  win.destroy()
  app.exit(0)
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
