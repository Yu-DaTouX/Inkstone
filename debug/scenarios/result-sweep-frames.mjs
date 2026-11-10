import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { observation: true, demo: true, description: '完成卡入场扫线连续截帧：运行结束后 1.3s 内按完成卡区域连续截图，写到 SWEEP_DIR' }

export default async function run({ cdp, box, sleep, waitFor, report, log, autoApprove, newSession, running }) {
  const ev = (x) => cdp.evaluate(x)
  const dir = process.env.SWEEP_DIR ?? '.'
  mkdirSync(dir, { recursive: true })
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await autoApprove()
  await newSession(box.project)
  await ev(`window.__yanStore.getState().send('WRITES sweep')`)
  await waitFor(`${running}`, 20000, 10)
  await waitFor(`!(${running})`, 120000, 10)
  const rows = []
  for (let i = 0; i < 14; i += 1) {
    const info = await ev(`(() => { const el = [...document.querySelectorAll('.v3-result[data-arrive]')].pop(); if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el, '::after'); return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), x: Math.round(r.left), t: cs.transform, o: cs.opacity } })()`)
    rows.push({ i, t: Date.now(), info })
    if (info && info.h > 0) {
      const clip = { x: Math.max(0, info.x - 6), y: Math.max(0, info.top - 8), width: Math.min(1280, info.w + 12), height: Math.min(800, info.h + 16), scale: 1 }
      const res = await cdp.call('Page.captureScreenshot', { format: 'png', clip })
      writeFileSync(join(dir, `sweep-${String(i).padStart(2, '0')}.png`), Buffer.from(res.result.data, 'base64'))
    }
    await sleep(60)
  }
  report.rows = rows.map((r) => ({ i: r.i, ...(r.info ?? {}) }))
  log('sweep', report.rows)
}
