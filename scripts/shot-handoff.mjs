/**
 * 交接恢复视图截图（实施-15 A-3）。
 *
 * 注入一个「已提交、续接已发出但目的会话还没看到标记」的状态，然后展开详情 ——
 * 这正是 R6 说的**不确定状态**：不能拿 marker 等价为「跑起来了」，
 * 也不能因为看不到证据就悄悄重发。
 *
 * 注意：`HandoffNote` 每 4s 轮询一次 `getHandoff()`，会把我注入的状态覆盖掉，
 * 所以先把 `refreshHandoff` 换成 no-op。这只是截图夹具，不碰产品逻辑。
 *
 * 用法： YAN_SHOT_DIR=docs/design/preview electron scripts/shot-handoff.mjs
 */
import { muteMissingHandlerNoise } from './lib/stdio-guard.mjs'
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(process.env.YAN_SHOT_DIR ?? join(root, 'out/shots-handoff'))
const STAMP = process.env.YAN_HANDOFF_STAMP ?? '2026-09-23'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function registerStubHandlers() {
  ipcMain.handle('yan:agentStatus', () => ({ state: 'ready', detail: '' }))
}

async function main() {
  muteMissingHandlerNoise()
  registerStubHandlers()
  await app.whenReady()
  await mkdir(outDir, { recursive: true })

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

  /* 注入「已发出、待核实」的交接事务，并把轮询换成 no-op（否则 4s 就被覆盖） */
  const seeded = await win.webContents.executeJavaScript(`
    (() => {
      const s = window.__yanStore
      if (!s) return 'no-store'
      const now = Date.now()
      s.setState({
        refreshHandoff: async () => {},
        handoff: {
          sessionKey: 'C:/sessions/yan-a.jsonl',
          tally: null,
          segmentTally: { count: 2, threshold: 2 },
          chainSegments: 2,
          package: null,
          pending: false,
          threshold: 2,
          transaction: {
            handoffId: 'h-shot',
            stage: 'committed',
            destinationSession: 'C:/sessions/yan-b.jsonl',
            receipts: { sentAt: now - 120000 },
            steps: [
              { at: now - 200000, from: 'pending', to: 'pending' },
              { at: now - 150000, from: 'pending', to: 'committed', detail: 'chain-linked' }
            ],
            resumeAttempts: 1
          },
          events: [],
          autoCommit: true
        }
      })
      return 'ok'
    })()
  `)
  if (seeded !== 'ok') throw new Error('交接状态注入失败: ' + seeded)
  await wait(500)

  const save = async (name) => {
    await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
    await wait(200)
    const image = await win.webContents.capturePage()
    await writeFile(join(outDir, name), image.toPNG())
    console.log(`  ✓ ${name}`)
  }

  const shoot = async (theme) => {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    await wait(300)
    await save(`handoff-receipt-${theme}-1440x900-${STAMP}.png`)
    /* 展开详情：最后确认步骤 + 待核实 + 两个选择 */
    const opened = await win.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('[data-testid="handoff-detail-toggle"]')
        if (!btn) return 'no-toggle'
        if (btn.getAttribute('aria-expanded') !== 'true') btn.click()
        return 'ok'
      })()
    `)
    if (opened !== 'ok') throw new Error('详情按钮不可用: ' + opened)
    await wait(400)
    await save(`handoff-receipt-${theme}-detail-1440x900-${STAMP}.png`)
    /* 收起，下一轮主题重来 */
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="handoff-detail-toggle"]')?.click()`
    )
    await wait(250)
  }

  const detail = await win.webContents.executeJavaScript(`
    (() => {
      const s = window.__yanStore.getState()
      const note = document.querySelector('[data-testid="handoff-note"]')
      return {
        hasNote: !!note,
        txStage: s.handoff?.transaction?.stage ?? null,
        sentAt: s.handoff?.transaction?.receipts?.sentAt ?? null,
        noteText: note?.textContent?.trim()?.slice(0, 120) ?? null,
        toggles: document.querySelectorAll('[data-testid="handoff-detail-toggle"]').length
      }
    })()
  `)
  console.log('  渲染检查（展开前）：', JSON.stringify(detail))

  await shoot('dark')
  await shoot('light')

  console.log(`\n输出目录：${outDir}`)
  app.exit(0)
}

main().catch((err) => {
  console.error('✗ 交接截图失败：', err)
  app.exit(2)
})
