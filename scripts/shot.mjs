/**
 * 用 Electron 自己截图（而不是 Edge headless）。
 *
 * 理由：只有走真实 Electron，preload / contextIsolation / file:// 下的 CSP
 * 和字体加载才和用户看到的一致。Edge 里跑出来的是「另一个页面」。
 *
 * 用法：
 *   npx electron scripts/shot.mjs <out.png> [宽] [高] [主题] [语言]
 * 例：
 *   npx electron scripts/shot.mjs docs/design/preview/yan-app-1440x900.png 1440 900 dark zh-CN
 *
 * ⚠️ 千万不要在入口用 top-level await `await app.whenReady()`。
 *    Electron 的 ESM 加载器要等整个模块图求值完才发 ready 事件，
 *    而 ready 又要等这个 await —— 直接死锁（表现为「什么都没发生」）。
 *    必须包在 main() 里调用。
 */
import { app, BrowserWindow } from 'electron'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)

async function main() {
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
      /* 产物是 .cjs：sandboxed preload 不支持 ESM（见 electron.vite.config.ts）。
         写成 index.mjs 会让 window.yan 缺失、截图整片空白。 */
      preload: join(root, 'out/preload/index.cjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  await win.loadFile(join(root, 'out/renderer/index.html'))

  // 先把主题/语言落到 localStorage，再重载 —— 不然截的是默认态
  await win.webContents.executeJavaScript(`
    try {
      localStorage.setItem('yan.theme', ${JSON.stringify(theme)});
      localStorage.setItem('yan.lang', ${JSON.stringify(lang)});
    } catch {}
  `)
  await win.webContents.reload()

  // 等字体真正就绪（内嵌 18.5MB TTF，不等会截到回退字形）
  const cnWidth = await win.webContents.executeJavaScript(`
    document.fonts.ready.then(() => {
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
