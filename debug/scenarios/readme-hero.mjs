import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTheme } from '../lib/review-kit.mjs'

export const meta = { demo: true, description: '生成 README 首屏配图：演示项目、中文界面、深浅两色，3200×2000（1600×1000 @2x）' }

export default async function run({ cdp, check, waitFor, sleep, runDir }) {
  const dir = process.env.README_HERO_DIR || runDir
  mkdirSync(dir, { recursive: true })
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false })
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ rightPanelOpen: true })`)
  await waitFor(`!!document.querySelector('[data-testid=wb-rail-env-summary]') && window.__yanStore.getState().messages.length >= 4`, 20000)
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ lang: 'zh-CN' })`)
  await cdp.evaluate(`window.__yanRightPanel.getState().open({ id: 'changes', kind: 'changes' })`)
  await sleep(1200)
  const shots = {}
  for (const theme of ['light', 'dark']) {
    await setTheme(cdp, theme)
    await sleep(700)
    const scrolled = await cdp.evaluate(`(() => { const el = document.querySelector('.v3-stream'); if (!el) return null; el.scrollTop = 0; return { top: el.scrollTop, h: el.scrollHeight, ch: el.clientHeight } })()`)
    await sleep(500)
    const res = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const file = join(dir, `workspace-${theme}.png`)
    writeFileSync(file, Buffer.from(res.result.data, 'base64'))
    shots[theme] = { file, scrolled }
  }
  await setTheme(cdp, 'dark')
  const size = await cdp.evaluate(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`)
  check('两色配图已生成', Object.keys(shots).length === 2, shots)
  console.log('hero', JSON.stringify({ shots, size }))
  return { shots, size }
}
