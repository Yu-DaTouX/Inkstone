import { muteMissingHandlerNoise } from './lib/stdio-guard.mjs'
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.env.YAN_SHOT_DIR
  ? resolve(process.env.YAN_SHOT_DIR)
  : join(root, 'docs/design/preview')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function registerStubHandlers() {
  ipcMain.handle('yan:agentStatus', () => ({ state: 'ready', detail: '' }))
  ipcMain.handle('yan:listDir', (_e, rel) => ({
    path: rel || '',
    abs: 'C:/work/pi-desktop' + (rel ? '/' + rel : ''),
    entries: [
      { name: 'src', dir: true },
      { name: 'docs', dir: true },
      { name: 'scripts', dir: true },
      { name: 'resources', dir: true },
      { name: 'package.json', dir: false, size: 2966 },
      { name: 'README.md', dir: false, size: 23073 },
      { name: 'electron-builder.yml', dir: false, size: 2624 },
      { name: 'tsconfig.json', dir: false, size: 107 }
    ],
    skipped: ['node_modules', '.git'],
    truncated: false,
    rootName: 'pi-desktop'
  }))
  ipcMain.handle('yan:providerQuota', (_e, provider) => ({
    provider: provider || 'openai-codex',
    supported: true,
    remaining: 8.42,
    currency: 'USD',
    label: '余额',
    windows: [
      { id: '5h', label: '5 小时', used: 1.58, total: 10 },
      { id: 'week', label: '本周', used: 6.2, total: 30 }
    ],
    checkedAt: Date.now()
  }))
}

async function main() {
  muteMissingHandlerNoise()
  registerStubHandlers()
  await app.whenReady()

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
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
      localStorage.setItem('yan.theme', 'dark');
      localStorage.setItem('yan.lang', 'zh-CN');
      localStorage.setItem('yan.onboarded', '1');
      localStorage.setItem('yan.termSize', JSON.stringify({ h: 260, w: 0 }));
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

  const fixture = await readFile(join(root, 'scripts/shot-fixture.js'), 'utf8')
  const injected = await win.webContents.executeJavaScript(fixture)
  if (injected !== 'ok') throw new Error('fixture 注入失败: ' + injected)
  await wait(700)

  const shot = async (name) => {
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))'
    )
    await wait(180)
    const outPath = join(outDir, name)
    await mkdir(dirname(outPath), { recursive: true })
    const img = await win.webContents.capturePage()
    await writeFile(outPath, img.toPNG())
    console.log('✓', name)
  }

  const collapseReasoning = async () => {
    await win.webContents.executeJavaScript(`
      document.querySelectorAll('[data-testid="reasoning-toggle"]').forEach((b) => {
        if (b.getAttribute('aria-expanded') === 'true') b.click();
      });
    `)
    await wait(300)
  }

  await collapseReasoning()
  await wait(300)
  await shot('ui-live.png')

  await win.webContents.executeJavaScript("document.documentElement.dataset.theme = 'light'")
  await wait(350)
  await shot('yan-app-light.png')
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme = 'dark'")
  await wait(250)

  await win.webContents.executeJavaScript(`
    const toggles = document.querySelectorAll('[data-testid="reasoning-toggle"]');
    const last = toggles[toggles.length - 1] || toggles[0];
    if (last && last.getAttribute('aria-expanded') !== 'true') last.click();
  `)
  await wait(350)
  await shot('reasoning-window.png')
  await collapseReasoning()
  await wait(250)

  await win.webContents.executeJavaScript(
    "window.__yanStore.getState().openSettings('appearance')"
  )
  await wait(450)
  await shot('ui-settings.png')

  const ok = Math.abs(cnWidth - 15) < 0.01
  console.log(`  汉字格宽 = ${Number(cnWidth).toFixed(2)}px  ${ok ? '(Maple 已生效)' : '⚠️ 字体未生效'}`)
  app.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('✗ 截图失败：', err)
  app.exit(2)
})
