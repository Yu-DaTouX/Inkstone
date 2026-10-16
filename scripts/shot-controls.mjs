import { muteMissingHandlerNoise } from './lib/stdio-guard.mjs'
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(process.env.YAN_SHOT_DIR ?? join(root, 'out/shots-controls'))
const STAMP = process.env.YAN_CONTROLS_STAMP ?? '2026-09-23'

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

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
  await wait(800)

  const save = async (name) => {
    await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await wait(200)
    const image = await win.webContents.capturePage()
    await writeFile(join(outDir, name), image.toPNG())
    console.log(`  ✓ ${name}`)
  }

  const focusInfo = () =>
    win.webContents.executeJavaScript(`
      (() => {
        const el = document.activeElement
        if (!el || el === document.body) return { tag: '(body)', cls: '', outline: 'n/a', offset: 'n/a' }
        const cs = getComputedStyle(el)
        const cls = typeof el.className === 'string' ? el.className : ''
        return {
          tag: el.tagName.toLowerCase(),
          cls: cls.split(/\\s+/).filter(Boolean).slice(0, 2).join('.'),
          outline: cs.outlineWidth + ' ' + cs.outlineStyle + ' ' + cs.outlineColor,
          offset: cs.outlineOffset,
          /* outline 是 none 时要分清「没样式」还是「没匹配 :focus-visible」 */
          visible: el.matches(':focus-visible'),
          disabled: el.disabled === true
        }
      })()
    `)

  const pressTab = async (times) => {
    for (let i = 0; i < times; i++) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      await wait(160)
    }
  }

  const setTheme = async (theme) => {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    await wait(400)
  }

  const report = []
  report.push(`缩放：zoomFactor=${win.webContents.getZoomFactor()}（计算样式里的长度 = 声明值 / zoom）`)
  for (const theme of ['dark', 'light']) {
    await setTheme(theme)
    await save(`controls-v1-${theme}-base-1280x800-${STAMP}.png`)

    await win.webContents.executeJavaScript(
      `(() => { const a = document.activeElement; if (a && a.blur) a.blur(); return true })()`
    )
    await pressTab(1)
    const chain = []
    for (let i = 0; i < 6; i++) {
      const info = await focusInfo()
      chain.push(
        `${info.tag}.${info.cls} → ${info.outline} (offset ${info.offset})` +
          ` focus-visible=${info.visible}${info.disabled ? ' [disabled]' : ''}`
      )
      await pressTab(1)
    }
    report.push(`[${theme}] 键盘 Tab 焦点链：\n    ` + chain.join('\n    '))
    await save(`controls-v1-${theme}-focus-1280x800-${STAMP}.png`)
  }

  await setTheme('dark')
  for (const zoom of [1.25, 1.5]) {
    win.webContents.setZoomFactor(zoom)
    await wait(600)
    await save(`controls-v1-dark-zoom${Math.round(zoom * 100)}-1280x800-${STAMP}.png`)
  }
  win.webContents.setZoomFactor(1)

  console.log(report.join('\n'))
  console.log(`\n输出目录：${outDir}`)
  app.exit(0)
}

main().catch((err) => {
  console.error('✗ 控件截图失败：', err)
  app.exit(2)
})
