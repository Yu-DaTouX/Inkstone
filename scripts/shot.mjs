import { muteMissingHandlerNoise } from './lib/stdio-guard.mjs'
import { app, BrowserWindow } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

async function main() {
  muteMissingHandlerNoise()
  await app.whenReady()

  const [out = 'shot.png', w = '1440', h = '900', theme = 'dark', lang = 'zh-CN'] = argv
  const width = Number(w)
  const height = Number(h)
  const outPath = resolve(root, out)

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#0b0b0d',
    webPreferences: {
      preload: join(root, 'out/preload/index.cjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  await win.loadFile(join(root, 'out/renderer/index.html'))

  await win.webContents.executeJavaScript(`
    try {
      localStorage.setItem('yan.theme', ${JSON.stringify(theme)});
      localStorage.setItem('yan.lang', ${JSON.stringify(lang)});
    } catch {}
  `)
  await win.webContents.reload()

  const cnWidth = await win.webContents.executeJavaScript(`
    document.fonts.load('12.5px "Maple Mono CN"', '国').then(() => {
      const el = document.createElement('span');
      el.style.cssText = 'position:fixed;visibility:hidden;font:12.5px "Maple Mono CN"';
      el.textContent = '国';
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    })
  `)

  await new Promise((r) => setTimeout(r, 400))

  const image = await win.webContents.capturePage()
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, image.toPNG())

  const ok = Math.abs(cnWidth - 15) < 0.01
  console.log(`✓ ${out}  ${width}x${height}  ${theme}/${lang}`)
  console.log(
    `  汉字格宽 = ${Number(cnWidth).toFixed(2)}px  ${ok ? '(Maple 已生效，栅格对齐)' : '⚠️ 字体未生效，回退了'}`
  )

  app.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('✗ 截图失败：', err)
  app.exit(2)
})
