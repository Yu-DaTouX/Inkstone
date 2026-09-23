/**
 * 右栏「开始」页截图（实施-11 H-3b）：深浅各一张 + 窄窗一张。
 *
 * 与 shot-controls 同一套做法：主进程真窗口 + capturePage，主题不重载只改
 * `data-theme`，避免 GPU 进程崩溃。新会话默认停在开始页，正好截它。
 *
 * 用法： YAN_SHOT_DIR=docs/design/preview electron scripts/shot-start.mjs
 */
import { muteMissingHandlerNoise } from './lib/stdio-guard.mjs'
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(process.env.YAN_SHOT_DIR ?? join(root, 'out/shots-start'))
const STAMP = process.env.YAN_START_STAMP ?? '2026-09-23'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function registerStubHandlers() {
  ipcMain.handle('yan:agentStatus', () => ({ state: 'ready', detail: '' }))
  ipcMain.handle('yan:providerQuota', () => ({ provider: 'openai-codex', supported: false }))
}

async function main() {
  muteMissingHandlerNoise()
  registerStubHandlers()
  await app.whenReady()
  await mkdir(outDir, { recursive: true })

  const narrowOnly = process.env.YAN_START_NARROW === '1'
  const win = new BrowserWindow({
    width: narrowOnly ? 940 : 1280,
    height: narrowOnly ? 620 : 800,
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
      localStorage.setItem('yan.theme', 'dark')
      localStorage.setItem('yan.lang', 'zh-CN')
      localStorage.setItem('yan.onboarded', '1')
    } catch {}
  `)
  await win.webContents.reload()
  await win.webContents.executeJavaScript(`document.fonts.ready.then(() => 0)`)
  const fixture = await readFile(join(root, 'scripts/shot-fixture.js'), 'utf8')
  const injected = await win.webContents.executeJavaScript(fixture)
  if (injected !== 'ok') throw new Error('fixture 注入失败: ' + injected)
  await wait(900)

  /* 真实 userData 里可能保存了旧的 workbench 布局（活动页不是开始页）。
     截图前显式切到「开始」固定标签，确保截的就是这一片。 */
  await win.webContents.executeJavaScript(`
    (() => {
      const s = window.__yanStore
      if (s && !s.getState().settings?.rightPanelOpen) s.getState().setRightPanelOpen(true)
      return true
    })()
  `)
  await wait(400)
  await win.webContents.executeJavaScript(`
    (() => {
      const tab = document.querySelector('[data-testid="right-window-tab-start"]')
      if (tab) tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    })()
  `)
  await wait(500)

  const save = async (name) => {
    await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await wait(200)
    const image = await win.webContents.capturePage()
    await writeFile(join(outDir, name), image.toPNG())
    console.log(`  ✓ ${name}`)
  }

  const setTheme = async (theme) => {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    await wait(400)
  }

  /* 确认开始页真的渲染出来（不是工具页），否则截图没有意义 */
  const startInfo = await win.webContents.executeJavaScript(`
    (() => ({
      start: !!document.querySelector('[data-testid="right-start-page"]'),
      panel: !!document.querySelector('[data-testid="rightpanel"]'),
      tabs: [...document.querySelectorAll('[data-testid^="right-window-tab-"]')].map((x) => x.dataset.testid)
    }))()
  `)
  console.log('  开始页诊断 =', JSON.stringify(startInfo))
  if (!startInfo.start) throw new Error('开始页没有渲染（可能不是新会话默认页）')

  if (narrowOnly) {
    await setTheme('dark')
    await save(`start-page-dark-narrow-940x620-${STAMP}.png`)
    console.log(`\n输出目录：${outDir}`)
    app.exit(0)
    return
  }

  for (const theme of ['dark', 'light']) {
    await setTheme(theme)
    await save(`start-page-${theme}-1280x800-${STAMP}.png`)
  }

  console.log(`\n输出目录：${outDir}`)
  app.exit(0)
}

main().catch((err) => {
  console.error('✗ 开始页截图失败：', err)
  app.exit(2)
})
